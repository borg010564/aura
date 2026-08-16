"""Speech-to-speech brain, built on OpenAI's Realtime API.

The original pipeline made three round trips per turn — transcribe, then chat, then
synthesise — and each one waited for the last to finish. Measured end to end that floored
out around 3s and typically ran to 4s, and benchmarking the three calls on their own gave
the same numbers: the time was OpenAI's, not ours, so there was nothing left to tune.

Realtime collapses all three into one streaming session: audio goes in, audio comes back,
and the model starts speaking while it's still working the rest out. Same question, same
network, measured from the end of the spoken question: 4.18s before, 0.72s here.

The session is long-lived, so conversation history lives in the session itself rather than
being replayed as messages on every turn.
"""

import array
import asyncio
import base64
import io
import json
import os
import sys
import time
import wave

import websockets

import brain
import memory
import weather

REALTIME_MODEL = os.getenv("AURA_REALTIME_MODEL", "gpt-realtime")
REALTIME_URL = f"wss://api.openai.com/v1/realtime?model={REALTIME_MODEL}"

# The wire format in both directions. 24kHz mono 16-bit PCM is what the client already
# plays, so audio deltas can be forwarded to the phone untouched.
PCM_SAMPLE_RATE = 24000

# How many exchanges to carry into a new session when the persona changes. Enough to keep
# the thread of a conversation without replaying an entire evening of it.
MAX_REPLAYED_TURNS = 8

# Realtime offers a different voice set from the `tts-1` endpoint — nova, onyx and fable
# aren't in it, and asking for one fails the whole session with no audio at all. Map each
# persona onto the nearest Realtime voice so they still sound like themselves.
REALTIME_VOICES = {
    "nova": "coral",  # bright and warm, like Aura's own
    "onyx": "ash",  # the deeper, drier one, for Rex
    "fable": "ballad",  # expressive, for theatrical Echo
    "shimmer": "shimmer",
    "echo": "echo",
    "alloy": "alloy",
}
SUPPORTED_VOICES = {
    "alloy", "ash", "ballad", "coral", "echo", "sage", "shimmer", "verse", "marin", "cedar",
}


def realtime_voice(tts_voice: str) -> str:
    if tts_voice in SUPPORTED_VOICES:
        return tts_voice
    return REALTIME_VOICES.get(tts_voice, "coral")


SLEEP_TOOL = {
    "type": "function",
    "name": "go_to_sleep",
    "description": (
        "Put Aura to sleep: the eyes close and it stops responding until spoken to again. "
        "Call this whenever the user tells you to sleep, go to bed, take a nap, or says "
        "goodnight. Say a short goodnight first. Do NOT call it when sleep merely comes up "
        "in conversation, e.g. 'when do owls go to sleep?'."
    ),
    "parameters": {"type": "object", "properties": {}},
}


def _flatten(tools: list[dict]) -> list[dict]:
    """Chat-completions tools are nested under "function"; Realtime wants them flat."""
    out = []
    for t in tools:
        fn = t.get("function", t)
        out.append(
            {
                "type": "function",
                "name": fn["name"],
                "description": fn.get("description", ""),
                "parameters": fn.get("parameters", {"type": "object", "properties": {}}),
            }
        )
    return out


ALL_TOOLS = _flatten(memory.TOOLS + weather.TOOLS) + [SLEEP_TOOL]


def to_pcm24k(audio: bytes) -> bytes:
    """The phone uploads a 16kHz mono WAV; Realtime wants raw 24kHz mono PCM.

    Done by hand rather than with `audioop`, which was removed in Python 3.13.
    """
    if audio[:4] != b"RIFF":
        return audio  # already raw PCM
    with wave.open(io.BytesIO(audio)) as w:
        frames = w.readframes(w.getnframes())
        rate, width, channels = w.getframerate(), w.getsampwidth(), w.getnchannels()

    if width != 2:
        raise ValueError(f"expected 16-bit audio from the phone, got {width * 8}-bit")

    samples = array.array("h")
    samples.frombytes(frames)
    if sys.byteorder == "big":
        samples.byteswap()  # WAV is little-endian

    if channels > 1:
        samples = array.array("h", samples[::channels])

    if rate != PCM_SAMPLE_RATE:
        n = len(samples) * PCM_SAMPLE_RATE // rate
        step = rate / PCM_SAMPLE_RATE
        out = array.array("h", bytes(2 * n))
        last = len(samples) - 1
        for i in range(n):
            pos = i * step
            i0 = int(pos)
            i1 = i0 + 1 if i0 < last else i0
            frac = pos - i0
            out[i] = int(samples[i0] * (1 - frac) + samples[i1] * frac)
        samples = out

    if sys.byteorder == "big":
        samples.byteswap()
    return samples.tobytes()


class RealtimeBrain:
    """One Realtime session, driving one phone."""

    def __init__(self, api_key: str, persona, emit):
        """`emit` is an async callable taking the same events the phone already understands."""
        self._api_key = api_key
        self._persona = persona
        self._emit = emit
        self._ws = None
        self._pump = None
        self._spoken = ""
        self._audio_open = False
        self._sleeping = False
        self._asked_at = None
        self._pending_tool = False
        # Only needed to rebuild the conversation in a new session after a persona change;
        # within one session the model keeps its own context.
        self._history: list[tuple[str, str]] = []
        self._persona_lock = asyncio.Lock()
        self._desired_persona = persona

    def _remember(self, role: str, text: str) -> None:
        self._history.append((role, text))
        del self._history[: max(0, len(self._history) - MAX_REPLAYED_TURNS * 2)]

    # ---- lifecycle ----

    async def connect(self) -> None:
        self._ws = await websockets.connect(
            REALTIME_URL,
            additional_headers={"Authorization": f"Bearer {self._api_key}"},
            max_size=None,
        )
        await self._configure()
        self._pump = asyncio.create_task(self._read_events())

    async def close(self) -> None:
        if self._pump:
            self._pump.cancel()
        if self._ws:
            await self._ws.close()

    async def _configure(self) -> None:
        # output_modalities must be set explicitly. Left to inherit, a session.update that
        # only named a voice silently produced responses with no audio at all.
        await self._send(
            {
                "type": "session.update",
                "session": {
                    "type": "realtime",
                    "instructions": self._instructions(),
                    "output_modalities": ["audio"],
                    "audio": {
                        "input": {
                            "format": {"type": "audio/pcm", "rate": PCM_SAMPLE_RATE},
                            # Transcribe what was said alongside answering it. The model
                            # doesn't need this to reply, but we do: it's what gets logged
                            # as "heard", and it's what lets a conversation be replayed
                            # into a new session when the persona changes.
                            "transcription": {"model": "gpt-4o-mini-transcribe"},
                            # The phone has already decided the utterance is over — it does
                            # its own endpointing before uploading. Leaving server-side VAD
                            # on made it wait out a second silence window for speech that
                            # had already finished, and it raced our explicit commit:
                            # whichever lost hit "buffer too small... has 0.00ms of audio".
                            "turn_detection": None,
                        },
                        "output": {
                            "voice": realtime_voice(self._persona.tts_voice),
                            "format": {"type": "audio/pcm", "rate": PCM_SAMPLE_RATE},
                        },
                    },
                    "tools": ALL_TOOLS,
                    "tool_choice": "auto",
                },
            }
        )

    # Working straight from audio, the model picks its own language — and a stretch of room
    # noise is enough to send it somewhere unexpected. A real turn here came back fluently
    # in Thai. The old pipeline never showed this because it replied to a transcript, which
    # Whisper had already rendered in English.
    LANGUAGE_RULE = (
        " Always speak English, whatever the audio sounds like. If you cannot make out what "
        "was said, say nothing at all rather than guessing."
        # Left to its own devices the model happily says goodnight and stops there, which
        # looks like the command worked while the eyes stay wide open. The tool is the only
        # thing that actually puts Aura to sleep, so spell that out.
        " When asked to sleep, go to bed, take a nap, or told goodnight, you MUST call the "
        "go_to_sleep tool — saying goodnight on its own does nothing. Say your goodnight "
        "and call the tool in the same turn."
    )

    def _instructions(self) -> str:
        return self._persona.system_prompt + self.LANGUAGE_RULE + memory.facts_prompt_block()

    async def set_persona(self, persona) -> None:
        """Switch voice and personality.

        A session's voice is fixed the moment it has spoken — `session.update` comes back
        with "Cannot update a conversation's voice if assistant audio is present", and
        because the whole update is rejected the new personality doesn't take either. So
        the only way to change voice is a new session, and the conversation is replayed
        into it so switching persona mid-chat doesn't wipe what you were talking about.
        """
        # Switching is no longer instant — it's a teardown and rebuild — and the persona
        # button cycles on each tap, so a few quick taps used to overlap and land on the
        # wrong personality, sometimes skipping one entirely. Take the lock, and once it's
        # ours check nothing newer has been asked for: three taps should cost one reconnect
        # to the persona you stopped on, not three interleaved ones.
        self._desired_persona = persona
        async with self._persona_lock:
            if self._desired_persona is not persona:
                return  # superseded while queued
            await self._reconnect_as(persona)

    async def _reconnect_as(self, persona) -> None:
        self._persona = persona
        history = list(self._history)
        await self.close()
        await self.connect()
        for role, text in history:
            await self._send(
                {
                    "type": "conversation.item.create",
                    "item": {
                        "type": "message",
                        "role": role,
                        # The two roles take different content types, and the API rejects
                        # the item outright if they're swapped.
                        "content": [
                            {
                                "type": "input_text" if role == "user" else "output_text",
                                "text": text,
                            }
                        ],
                    },
                }
            )
        self._history = history
        print(f"[aura] persona now {persona.id} (voice {realtime_voice(persona.tts_voice)}), "
              f"{len(history)} turns carried over")

    # ---- talking to it ----

    async def send_audio(self, pcm: bytes) -> None:
        """Feed one complete utterance and ask for a reply."""
        self._spoken = ""
        self._sleeping = False
        self._asked_at = time.perf_counter()
        # The whole utterance is already in hand, so send it as one message rather than
        # dribbling it out in chunks — there's nothing to stream and each message costs a
        # base64 round of its own.
        await self._send(
            {
                "type": "input_audio_buffer.append",
                "audio": base64.b64encode(pcm).decode(),
            }
        )
        await self._send({"type": "input_audio_buffer.commit"})
        await self._send({"type": "response.create"})
        print(f"[aura] realtime: sent {len(pcm)/(PCM_SAMPLE_RATE*2):.2f}s of audio")

    async def cancel(self) -> None:
        """"Aura stop" — abandon whatever is being said."""
        await self._send({"type": "response.cancel"})

    async def _send(self, payload: dict) -> None:
        await self._ws.send(json.dumps(payload))

    # ---- hearing back ----

    async def _read_events(self) -> None:
        try:
            async for raw in self._ws:
                await self._handle(json.loads(raw))
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # a dropped session must not take the phone down with it
            print(f"[aura] realtime stream ended: {type(exc).__name__}: {exc}")

    async def _handle(self, ev: dict) -> None:
        kind = ev.get("type", "")

        if kind == "response.output_audio.delta":
            if not self._audio_open:
                if self._asked_at:
                    print(f"[aura] timing: realtime_first_audio={time.perf_counter()-self._asked_at:.2f}s")
                await self._emit(
                    {
                        "type": "audio_start",
                        "format": "pcm_s16le",
                        "sampleRate": PCM_SAMPLE_RATE,
                    }
                )
                self._audio_open = True
            await self._emit(base64.b64decode(ev["delta"]))

        elif kind == "response.output_audio_transcript.delta":
            # Captions, as the words are spoken.
            self._spoken += ev.get("delta", "")
            await self._emit({"type": "reply", "user_text": "", "reply_text": self._spoken.strip()})

        elif kind == "conversation.item.input_audio_transcription.completed":
            heard = (ev.get("transcript") or "").strip()
            print(f"[aura] heard: {heard!r}")
            if heard:
                self._remember("user", heard)

        elif kind == "response.function_call_arguments.done":
            await self._run_tool(ev.get("name", ""), ev.get("arguments", "") or "{}", ev.get("call_id"))

        elif kind == "response.done":
            if self._audio_open:
                await self._emit({"type": "audio_end"})
                self._audio_open = False
            if self._spoken.strip():
                print(f"[aura] reply: {self._spoken.strip()!r}")
                self._remember("assistant", self._spoken.strip())
            if self._pending_tool:
                # A tool ran, so a second response carrying the actual answer is on its way.
                # Treating this one as the end of the turn sent the face back to idle and
                # wiped the caption just before the weather arrived.
                self._pending_tool = False
                return
            if self._sleeping:
                await self._emit({"type": "sleep"})
                self._sleeping = False
            elif not self._spoken.strip():
                # Nothing to say — usually a false wake. Drop the thinking face silently.
                await self._emit({"type": "idle"})

        elif kind == "error":
            message = ev.get("error", {}).get("message", "unknown error")
            print(f"[aura] realtime error: {message}")
            await self._emit({"type": "error", "message": message})

    async def _run_tool(self, name: str, arguments: str, call_id: str | None) -> None:
        if name == "go_to_sleep":
            # The face closes its eyes once the goodnight has finished playing, so this is
            # just a flag; response.done applies it.
            self._sleeping = True
            result = "sleeping"
        else:
            result = await brain.run_tool(name, arguments)  # same routing as the old pipeline

        print(f"[aura] tool {name} -> {str(result)[:80]!r}")
        if call_id:
            self._pending_tool = True
            await self._send(
                {
                    "type": "conversation.item.create",
                    "item": {
                        "type": "function_call_output",
                        "call_id": call_id,
                        "output": str(result),
                    },
                }
            )
            await self._send({"type": "response.create"})
