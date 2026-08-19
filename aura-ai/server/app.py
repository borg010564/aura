import asyncio
import json
import os
import secrets
import socket
import sys
from pathlib import Path

# The Windows console defaults to cp1252, which raises UnicodeEncodeError on emoji — and
# replies routinely contain them. That crashed the websocket handler mid-turn, so a reply
# was generated but never delivered. Log in UTF-8 and never let an unprintable character
# take down a conversation.
for _stream in (sys.stdout, sys.stderr):
    try:
        # line_buffering so logs appear immediately rather than sitting in a block buffer
        _stream.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
    except (AttributeError, ValueError):
        pass

from dotenv import load_dotenv

load_dotenv()  # must run before importing brain, which reads env vars at import time

from fastapi import FastAPI, Response, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from openai import AsyncOpenAI

import realtime
from brain import PCM_SAMPLE_RATE, Brain, goodnight_line, is_sleep_command
from personality import PERSONAS

# Speech-to-speech is the default: measured 0.72s to the first spoken word against 4.18s
# for the transcribe -> chat -> speak pipeline. Set AURA_REALTIME=0 to go back to it.
USE_REALTIME = os.getenv("AURA_REALTIME", "1").lower() not in ("0", "false", "no")

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
PORT = int(os.getenv("AURA_PORT", "8000"))

# Gate for a server reachable from the internet. Every /ws connection opens a session billed
# to our OpenAI key, so a public host needs one. Left unset the endpoint stays open, which is
# what you want on a home LAN and emphatically not what you want on a public address.
ACCESS_TOKEN = os.getenv("AURA_TOKEN") or None
SSL_CERT = os.getenv("AURA_SSL_CERT") or None
SSL_KEY = os.getenv("AURA_SSL_KEY") or None

API_KEY = os.getenv("OPENAI_API_KEY")
MOCK_MODE = os.getenv("AURA_MOCK", "").lower() in ("1", "true", "yes")

if not API_KEY and not MOCK_MODE:
    raise RuntimeError(
        "OPENAI_API_KEY is not set. Copy server/.env.example to server/.env and fill it in "
        "(or set AURA_MOCK=1 in .env to try the app without an API key)."
    )

client = AsyncOpenAI(api_key=API_KEY) if API_KEY else None

app = FastAPI()

_background: set[asyncio.Task] = set()


def _dispatch(coro, label: str) -> None:
    """Run a coroutine alongside the message loop, keeping a reference so it isn't
    garbage-collected mid-flight, and logging rather than swallowing any failure."""
    task = asyncio.create_task(coro)
    _background.add(task)
    task.add_done_callback(_background.discard)

    def _report(t: asyncio.Task) -> None:
        if not t.cancelled() and t.exception():
            print(f"[aura] {label} failed: {t.exception()}")

    task.add_done_callback(_report)


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    # Refused before accept(), so an unauthorised caller never reaches the OpenAI connection
    # below and never costs anything. compare_digest keeps the check constant-time.
    if ACCESS_TOKEN is not None:
        offered = websocket.query_params.get("token", "")
        if not secrets.compare_digest(offered, ACCESS_TOKEN):
            print("[aura] refused a /ws connection with a bad or missing token")
            await websocket.close(code=1008)  # policy violation
            return

    await websocket.accept()
    brain = Brain(client)

    async def emit(event):
        """Forward one Realtime event to the phone, in the shape it already understands."""
        if isinstance(event, (bytes, bytearray)):
            await websocket.send_bytes(event)
        else:
            await websocket.send_json(event)

    live = None
    if USE_REALTIME and API_KEY and not brain.is_mock:
        live = realtime.RealtimeBrain(API_KEY, PERSONAS[brain.persona_id], emit)
        try:
            await live.connect()
            print(f"[aura] realtime session open ({realtime.REALTIME_MODEL})")
        except Exception as exc:
            # Never strand the phone: the three-call pipeline still works.
            print(f"[aura] realtime unavailable ({exc}); using the standard pipeline")
            live = None

    await websocket.send_json(
        {
            "type": "personas",
            "list": [{"id": p.id, "label": p.label} for p in PERSONAS.values()],
            "current": brain.persona_id,
        }
    )
    try:
        while True:
            message = await websocket.receive()
            if message["type"] == "websocket.disconnect":
                break

            audio_bytes = message.get("bytes")
            text = message.get("text")

            if audio_bytes is not None:
                print(f"[aura] received {len(audio_bytes)} bytes of audio from phone")
                await websocket.send_json({"type": "thinking"})

                if live is not None:
                    # Speech in, speech out, one session — no transcribe/chat/speak chain.
                    try:
                        await live.send_audio(realtime.to_pcm24k(audio_bytes))
                    except Exception as exc:
                        print(f"[aura] realtime send failed: {exc}")
                        await websocket.send_json({"type": "error", "message": str(exc)})
                    continue

                if brain.is_mock:
                    # Mock mode still sends one complete WAV; the client handles both.
                    try:
                        user_text, reply_text, reply_audio = await brain.process_utterance(
                            audio_bytes
                        )
                    except Exception as exc:
                        print(f"[aura] error processing utterance: {exc}")
                        await websocket.send_json({"type": "error", "message": str(exc)})
                        continue
                    await websocket.send_json(
                        {"type": "reply", "user_text": user_text, "reply_text": reply_text}
                    )
                    await websocket.send_bytes(reply_audio)
                    continue

                try:
                    user_text = await brain.transcribe(audio_bytes)
                    print(f"[aura] heard: {user_text!r}")
                except Exception as exc:
                    print(f"[aura] error transcribing: {exc}")
                    await websocket.send_json({"type": "error", "message": str(exc)})
                    continue

                if not user_text.strip():
                    # Nothing intelligible — usually a false wake, or speech that started
                    # before the mic was warm. Say nothing and go back to idle rather than
                    # asking the model to reply to silence, which produced things like
                    # "Silent partner mode — got it!" out of an empty room.
                    print("[aura] nothing heard; ignoring")
                    await websocket.send_json({"type": "idle"})
                    continue

                if is_sleep_command(user_text):
                    # A device command, not a conversation: no chat call, no history entry.
                    # The client waits for the sign-off to finish playing before the eyes
                    # actually close, so it doesn't cut itself off mid-goodnight.
                    line = goodnight_line()
                    print(f"[aura] going to sleep: {line!r}")
                    await websocket.send_json({"type": "sleep"})
                    await websocket.send_json(
                        {"type": "reply", "user_text": user_text, "reply_text": line}
                    )
                    await websocket.send_json(
                        {
                            "type": "audio_start",
                            "format": "pcm_s16le",
                            "sampleRate": PCM_SAMPLE_RATE,
                        }
                    )
                    try:
                        async for chunk in brain.stream_speech(line):
                            await websocket.send_bytes(chunk)
                    finally:
                        await websocket.send_json({"type": "audio_end"})
                    continue

                # Speak each sentence as soon as the model finishes writing it, rather than
                # waiting for the whole reply — the model is still composing the last
                # sentence while the first could already be playing.
                audio_open = False
                spoken = ""
                try:
                    async for sentence in brain.reply_sentences(user_text):
                        spoken += sentence
                        await websocket.send_json(
                            {
                                "type": "reply",
                                "user_text": user_text,
                                "reply_text": spoken.strip(),
                            }
                        )
                        if not audio_open:
                            await websocket.send_json(
                                {
                                    "type": "audio_start",
                                    "format": "pcm_s16le",
                                    "sampleRate": PCM_SAMPLE_RATE,
                                }
                            )
                            audio_open = True
                        async for chunk in brain.stream_speech(sentence):
                            await websocket.send_bytes(chunk)
                    try:
                        print(f"[aura] reply: {spoken.strip()!r}")
                    except Exception:
                        pass  # a logging hiccup must never cost a paid-for reply
                except Exception as exc:
                    print(f"[aura] error generating reply: {exc}")
                    await websocket.send_json({"type": "error", "message": str(exc)})
                finally:
                    if audio_open:
                        await websocket.send_json({"type": "audio_end"})

            elif text is not None:
                try:
                    control = json.loads(text)
                except ValueError:
                    continue
                if control.get("type") == "set_persona":
                    new_id = brain.set_persona(control.get("persona", ""))
                    print(f"[aura] persona switched to {new_id}")
                    if live is not None:
                        # Don't hold up the message loop: switching rebuilds the Realtime
                        # session, and awaiting it here made three quick taps of the
                        # persona button queue up into three sequential rebuilds, ~5s
                        # before it settled. Dispatched instead, RealtimeBrain coalesces
                        # them into one rebuild to whichever persona you stopped on.
                        _dispatch(live.set_persona(PERSONAS[new_id]), "set_persona")
                    await websocket.send_json({"type": "persona_set", "persona": new_id})
                elif control.get("type") == "clear_history":
                    brain.clear_history()
                    print("[aura] conversation history cleared")
                    await websocket.send_json({"type": "history_cleared"})
                elif control.get("type") == "stop" and live is not None:
                    await live.cancel()
    except WebSocketDisconnect:
        print("[aura] phone disconnected")
    finally:
        if live is not None:
            await live.close()


@app.get("/config.js")
async def config_js():
    """Tells the page to use this server as its brain.

    The standalone Android build generates its own version of this file instead, pointing
    the page at OpenAI directly — same page, different brain.
    """
    return Response(
        content='window.AuraConfig = { mode: "server" };',
        media_type="application/javascript",
        headers={"Cache-Control": "no-store"},
    )


app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")


def _lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


if __name__ == "__main__":
    import uvicorn

    from discovery import start_discovery_responder

    scheme = "https" if SSL_CERT and SSL_KEY else "http"
    ip = _lan_ip()
    print(f"\nAura is running. Open this on your phone's browser (same WiFi):\n\n  {scheme}://{ip}:{PORT}\n")
    print("(The Android app finds this automatically — no need to type the address.)\n")

    # Lets the Android app locate this server even after the router hands out a new IP.
    start_discovery_responder(scheme, PORT)

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=PORT,
        ssl_certfile=SSL_CERT,
        ssl_keyfile=SSL_KEY,
    )
