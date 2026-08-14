import io
import json
import math
import os
import random
import struct
import time
import wave
from pathlib import Path

from openai import AsyncOpenAI

import memory
import weather
from personality import DEFAULT_PERSONA_ID, PERSONAS

# Everything the model is allowed to call. Tools cost nothing unless actually invoked.
ALL_TOOLS = memory.TOOLS + weather.TOOLS
WEATHER_TOOL_NAMES = {t["function"]["name"] for t in weather.TOOLS}


async def run_tool(name: str, arguments: str) -> str:
    """Routes a tool call to whichever module owns it."""
    if name in WEATHER_TOOL_NAMES:
        try:
            args = json.loads(arguments) if arguments else {}
        except json.JSONDecodeError:
            args = {}
        return await weather.run_tool(name, args)
    return memory.run_tool(name, arguments)

CHAT_MODEL = os.getenv("AURA_CHAT_MODEL", "gpt-4o-mini")
# Measured on this setup: whisper-1 ~2.0s vs gpt-4o-mini-transcribe ~0.7s for the same clip.
# Transcription was the single biggest chunk of response latency.
TRANSCRIBE_MODEL = os.getenv("AURA_TRANSCRIBE_MODEL", "gpt-4o-mini-transcribe")
# tts-1 measured ~1.5s vs gpt-4o-mini-tts ~2.5s, so the older model is the faster one here.
TTS_MODEL = os.getenv("AURA_TTS_MODEL", "tts-1")

# Caps runaway replies. The personas already ask for 1-3 sentences; this also bounds how
# long TTS takes, since synthesis time scales with reply length.
MAX_REPLY_TOKENS = int(os.getenv("AURA_MAX_REPLY_TOKENS", "120"))

MAX_HISTORY_TURNS = 12

# OpenAI's PCM speech output is 24 kHz, 16-bit, mono, little-endian.
PCM_SAMPLE_RATE = 24000
PCM_CHUNK_BYTES = 4800  # ~100ms per chunk

MOCK_MODE = os.getenv("AURA_MOCK", "").lower() in ("1", "true", "yes")

HISTORY_FILE = Path(__file__).resolve().parent / os.getenv(
    "AURA_HISTORY_FILE", "conversation_history.json"
)


_SENTENCE_ENDINGS = ".!?…"


# The opening fragment is allowed to be short so speech can start as early as possible —
# replies often begin with "Sure!" or "No worries!", and holding those back until the next
# sentence completes was costing well over a second before Aura made any sound.
MIN_FIRST_CHARS = 4
MIN_CHARS = 12
# If the model rambles without punctuation, cut at a word boundary rather than wait.
MAX_CHARS_BEFORE_FORCED_BREAK = 110


def _sentence_break(text: str, is_first: bool = False):
    """Index just past the first sentence ending, or None if there isn't one yet.

    Avoids cutting on a decimal point or an abbreviation by requiring whitespace after
    the punctuation, and skips fragments too short to be worth speaking on their own.
    """
    minimum = MIN_FIRST_CHARS if is_first else MIN_CHARS
    for i, ch in enumerate(text):
        if ch in _SENTENCE_ENDINGS:
            j = i + 1
            # absorb trailing quotes/brackets and repeated punctuation
            while j < len(text) and text[j] in "\"')]}…!?.":
                j += 1
            if j >= len(text):
                return None  # might still be mid-punctuation; wait for more
            if text[j].isspace() and len(text[:j].strip()) >= minimum:
                return j

    if len(text) >= MAX_CHARS_BEFORE_FORCED_BREAK:
        cut = text.rfind(" ", 0, MAX_CHARS_BEFORE_FORCED_BREAK)
        if cut > MIN_CHARS:
            return cut
    return None


# ---- "Go to sleep" ----
#
# Handled here rather than by the model: it's a device command, not a conversation, so it
# should be instant, free, and impossible for the model to answer with chit-chat about
# bedtime. Matched against the whole utterance (not a substring) so "when do owls go to
# sleep?" stays an ordinary question.
#
# Kept in step with the same list in web/direct.js, which does this for standalone mode.
_SLEEP_PHRASES = {
    "go to sleep",
    "goodnight",
    "good night",
    "night night",
    "nighty night",
    "go to bed",
    "time to sleep",
    "sleep now",
    "take a nap",
    "go dormant",
    "time for bed",
}
# Openers to ignore. Includes the ways transcription mangles "Aura" at the start of an
# utterance — a real recording of "Aura, go to sleep" came back as "Or I go to sleep",
# which the exact match would otherwise miss. All are function words, so dropping them
# can't turn a question into a command: "Do I go to sleep?" and "Can I go to sleep?" keep
# their leading verb and so still fall through to normal conversation.
_SLEEP_LEADERS = (
    "hey", "ok", "okay", "now", "please", "hi",
    "aura", "or", "i", "a", "ah", "uh", "um", "so", "just", "you", "and",
    "aurora", "ara", "laura", "nora",
)
_SLEEP_TRAILERS = ("aura", "now", "please", "then", "ok", "okay")
_SLEEP_GOODNIGHTS = [
    "Goodnight.",
    "Night. Wake me whenever.",
    "Sleeping. Say 'Hey Aura' when you need me.",
]


def is_sleep_command(text: str) -> bool:
    """True if the whole utterance is a request for Aura to go to sleep."""
    cleaned = "".join(c for c in (text or "").lower() if c.isalnum() or c.isspace())
    words = cleaned.split()
    # Drop the ways people top and tail a command, so "Aura, go to sleep please" matches.
    while words and words[0] in _SLEEP_LEADERS:
        words.pop(0)
    while words and words[-1] in _SLEEP_TRAILERS:
        words.pop()
    return " ".join(words) in _SLEEP_PHRASES


def goodnight_line() -> str:
    """A short canned sign-off, so saying goodnight costs no chat call."""
    return random.choice(_SLEEP_GOODNIGHTS)


def _mock_tone_wav(duration: float = 0.9, freq: float = 330.0, rate: int = 16000) -> bytes:
    """A short synthesized beep, used in mock mode so audio playback can be tested
    without calling the real TTS API."""
    n_samples = int(duration * rate)
    frames = bytearray()
    for i in range(n_samples):
        t = i / rate
        envelope = math.sin(math.pi * min(t / duration, 1.0))  # fade in/out
        tremolo = 0.6 + 0.4 * math.sin(2 * math.pi * 4 * t)  # gives the talk animation some life
        sample = int(9000 * envelope * tremolo * math.sin(2 * math.pi * freq * t))
        frames += struct.pack("<h", sample)

    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(bytes(frames))
    return buf.getvalue()


class Brain:
    """Holds one conversation's history and drives STT -> chat -> TTS for each turn."""

    def __init__(self, client: AsyncOpenAI | None, persona_id: str = DEFAULT_PERSONA_ID):
        self._client = client
        self._history: list[dict] = self._load_history()
        self._persona = PERSONAS.get(persona_id, PERSONAS[DEFAULT_PERSONA_ID])

    @property
    def persona_id(self) -> str:
        return self._persona.id

    def set_persona(self, persona_id: str) -> str:
        """Switches persona (voice + personality) for future turns; conversation
        history is kept as-is. Returns the resolved persona id (unchanged if the
        requested one doesn't exist)."""
        self._persona = PERSONAS.get(persona_id, self._persona)
        return self._persona.id

    def clear_history(self) -> None:
        self._history = []
        self._save_history()

    @staticmethod
    def _load_history() -> list[dict]:
        try:
            with open(HISTORY_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, list):
                    return data
        except (FileNotFoundError, json.JSONDecodeError):
            pass
        return []

    def _save_history(self) -> None:
        try:
            with open(HISTORY_FILE, "w", encoding="utf-8") as f:
                json.dump(self._history, f)
        except OSError as exc:
            print(f"[aura] couldn't save conversation history: {exc}")

    async def process_utterance(self, audio_bytes: bytes) -> tuple[str, str, bytes]:
        if MOCK_MODE:
            return self._mock_turn()

        t0 = time.perf_counter()
        user_text = await self._transcribe(audio_bytes)
        t1 = time.perf_counter()
        reply_text = await self._chat(user_text)
        t2 = time.perf_counter()
        reply_audio = await self._synthesize(reply_text)
        t3 = time.perf_counter()
        print(
            f"[aura] timing: transcribe={t1 - t0:.2f}s chat={t2 - t1:.2f}s "
            f"tts={t3 - t2:.2f}s total={t3 - t0:.2f}s"
        )
        return user_text, reply_text, reply_audio

    @property
    def is_mock(self) -> bool:
        return MOCK_MODE

    async def transcribe(self, audio_bytes: bytes) -> str:
        t0 = time.perf_counter()
        user_text = await self._transcribe(audio_bytes)
        print(f"[aura] timing: transcribe={time.perf_counter() - t0:.2f}s")
        return user_text

    async def reply_sentences(self, user_text: str):
        """Streams the reply and yields it a sentence at a time.

        Waiting for the whole answer before speaking was the largest remaining delay: the
        model is still writing sentence three while sentence one could already be playing.
        Yielding per sentence lets speech synthesis start roughly a second earlier.

        Tool calls (memory, weather) can't be spoken mid-flight, so if the model asks for
        one we resolve it first and then stream the real answer.
        """
        self._history.append({"role": "user", "content": user_text})
        system_prompt = self._persona.system_prompt + memory.facts_prompt_block()
        messages = [{"role": "system", "content": system_prompt}, *self._history]

        full = ""
        async for sentence in self._stream_sentences(messages, allow_tools=True):
            full += sentence
            yield sentence

        reply_text = full.strip() or "Got it."
        self._history.append({"role": "assistant", "content": reply_text})
        self._history = self._history[-MAX_HISTORY_TURNS * 2 :]
        self._save_history()
        self.last_reply_text = reply_text

    async def _stream_sentences(self, messages: list[dict], allow_tools: bool):
        """Yields complete sentences from a streamed completion."""
        kwargs = {
            "model": CHAT_MODEL,
            "messages": messages,
            "max_tokens": MAX_REPLY_TOKENS,
            "stream": True,
        }
        if allow_tools:
            kwargs["tools"] = ALL_TOOLS

        buffer = ""
        tool_calls: dict[int, dict] = {}
        t0 = time.perf_counter()
        first_sentence_at = None

        stream = await self._client.chat.completions.create(**kwargs)
        async for event in stream:
            if not event.choices:
                continue
            delta = event.choices[0].delta

            for tc in getattr(delta, "tool_calls", None) or []:
                slot = tool_calls.setdefault(
                    tc.index, {"id": "", "name": "", "arguments": ""}
                )
                if tc.id:
                    slot["id"] = tc.id
                if tc.function and tc.function.name:
                    slot["name"] = tc.function.name
                if tc.function and tc.function.arguments:
                    slot["arguments"] += tc.function.arguments

            if delta.content:
                buffer += delta.content
                # Emit as soon as a sentence is complete, so speech can start on it.
                while True:
                    cut = _sentence_break(buffer, is_first=first_sentence_at is None)
                    if cut is None:
                        break
                    sentence, buffer = buffer[:cut], buffer[cut:]
                    if sentence.strip():
                        if first_sentence_at is None:
                            first_sentence_at = time.perf_counter()
                            print(f"[aura] timing: chat_first_sentence={first_sentence_at - t0:.2f}s")
                        yield sentence

        if tool_calls:
            # The model wants data before it can answer. Resolve, then stream for real.
            ordered = [tool_calls[i] for i in sorted(tool_calls)]
            messages.append(
                {
                    "role": "assistant",
                    "content": buffer or None,
                    "tool_calls": [
                        {
                            "id": c["id"],
                            "type": "function",
                            "function": {"name": c["name"], "arguments": c["arguments"]},
                        }
                        for c in ordered
                    ],
                }
            )
            for c in ordered:
                result = await run_tool(c["name"], c["arguments"])
                messages.append(
                    {"role": "tool", "tool_call_id": c["id"], "content": result}
                )
            async for sentence in self._stream_sentences(messages, allow_tools=False):
                yield sentence
            return

        if buffer.strip():
            yield buffer

    async def stream_speech(self, text: str):
        """Yields raw PCM as it's generated, so playback can start before synthesis ends.

        Waiting for the whole file was the single biggest chunk of response latency
        (~2.5s measured); streaming lets the first audio play in a fraction of that.
        """
        print(f"[aura] streaming speech with persona={self._persona.id} voice={self._persona.tts_voice}")
        t0 = time.perf_counter()
        first_chunk_at = None
        total = 0
        async with self._client.audio.speech.with_streaming_response.create(
            model=TTS_MODEL,
            voice=self._persona.tts_voice,
            input=text,
            response_format="pcm",
        ) as response:
            async for chunk in response.iter_bytes(PCM_CHUNK_BYTES):
                if not chunk:
                    continue
                if first_chunk_at is None:
                    first_chunk_at = time.perf_counter()
                    print(f"[aura] timing: tts_first_audio={first_chunk_at - t0:.2f}s")
                total += len(chunk)
                yield chunk
        print(
            f"[aura] timing: tts_complete={time.perf_counter() - t0:.2f}s ({total} bytes)"
        )

    def _mock_turn(self) -> tuple[str, str, bytes]:
        user_text = "(mock) hey Aura, can you hear me?"
        reply_text = f"(mock mode, persona={self._persona.label}) Loud and clear. No API calls were made."
        return user_text, reply_text, _mock_tone_wav()

    async def _transcribe(self, audio_bytes: bytes) -> str:
        audio_file = io.BytesIO(audio_bytes)
        # OpenAI picks its decoder from the filename extension, so it has to match the
        # actual bytes. The phone sends WAV (raw PCM from the native bridge) while a plain
        # browser sends WebM/Opus from MediaRecorder — mislabelling either one gets a 400
        # "Audio file might be corrupted or unsupported".
        audio_file.name = "utterance.wav" if audio_bytes[:4] == b"RIFF" else "utterance.webm"
        result = await self._client.audio.transcriptions.create(
            model=TRANSCRIBE_MODEL,
            file=audio_file,
        )
        return result.text.strip()

    async def _chat(self, user_text: str) -> str:
        self._history.append({"role": "user", "content": user_text})

        # Long-term facts are prepended to the persona prompt so they survive the rolling
        # history window. The memory tools cost nothing unless the model actually calls
        # them, so ordinary turns are as fast as before.
        system_prompt = self._persona.system_prompt + memory.facts_prompt_block()
        messages = [{"role": "system", "content": system_prompt}, *self._history]

        response = await self._client.chat.completions.create(
            model=CHAT_MODEL,
            messages=messages,
            max_tokens=MAX_REPLY_TOKENS,
            tools=ALL_TOOLS,
        )
        message = response.choices[0].message

        if message.tool_calls:
            # Record the tool calls, run them, then ask for the actual spoken reply.
            messages.append(
                {
                    "role": "assistant",
                    "content": message.content,
                    "tool_calls": [
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.function.name,
                                "arguments": tc.function.arguments,
                            },
                        }
                        for tc in message.tool_calls
                    ],
                }
            )
            for tc in message.tool_calls:
                result = await run_tool(tc.function.name, tc.function.arguments)
                messages.append(
                    {"role": "tool", "tool_call_id": tc.id, "content": result}
                )

            response = await self._client.chat.completions.create(
                model=CHAT_MODEL,
                messages=messages,
                max_tokens=MAX_REPLY_TOKENS,
            )
            message = response.choices[0].message

        reply_text = (message.content or "").strip()
        if not reply_text:
            reply_text = "Got it, I'll remember that."

        self._history.append({"role": "assistant", "content": reply_text})
        self._history = self._history[-MAX_HISTORY_TURNS * 2 :]
        self._save_history()
        return reply_text

    async def _synthesize(self, text: str) -> bytes:
        print(f"[aura] synthesizing with persona={self._persona.id} voice={self._persona.tts_voice}")
        response = await self._client.audio.speech.create(
            model=TTS_MODEL,
            voice=self._persona.tts_voice,
            input=text,
        )
        return response.content
