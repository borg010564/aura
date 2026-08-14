# Aura

A desk companion in the spirit of the Loona robot: an Android phone lies on its side showing
a pair of animated glowing eyes, listens for "Hey Aura", and holds a spoken conversation.

The phone is the face. The brain is a small Python server — or the phone itself, if no
server is around.

```
aura-ai/        the brain and the face
  server/         FastAPI + WebSocket, OpenAI Realtime, memory, weather, personas
  web/            the eyes, wake word, mic handling — served to the phone
aura-android/   a thin native shell around the web app
```

## Getting it running

**Server** (needs Python 3.10+ and an OpenAI API key):

```bash
cd aura-ai/server && pip install -r requirements.txt
```

Copy `.env.example` to `.env` and paste your key in, then:

```bash
python aura-ai/server/app.py
```

It prints a URL and answers UDP discovery probes, so the Android app finds it by itself.

**Android app** (needs Android Studio, and a JDK 21 — 25 is too new for this Gradle):

```bash
cd aura-android && ./gradlew assembleDebug
```

`local.properties` needs `sdk.dir` pointing at your Android SDK. The web app is copied into
the APK at build time from `../aura-ai/web`, so the two directories must stay siblings.

## What it does

Say **"Hey Aura"** to talk to it, or press and hold anywhere. **"Aura stop"** interrupts it
mid-sentence. **"Go to sleep"** closes its eyes until you speak to it again. It remembers
your name and anything else worth keeping, looks up the weather, has six switchable
personalities, and watches for a face so its eyes follow you and it dozes off in an empty
room.

Wake word, face tracking and the eye animation all run on the phone at no API cost. Only
actual conversation costs anything.

## Where to read next

- [`aura-ai/README.md`](aura-ai/README.md) — how it all works, and the measurements behind
  the design decisions: response speed, the wake word, presence detection, memory
- [`aura-android/README.md`](aura-android/README.md) — the native shell, and why it exists
  (WebView can't get the microphone on its own here)

Both are written up with the failure modes that were hit along the way, because most of them
were silent ones — the sort that look like the feature simply doesn't work.

## Two brains

With an API key saved in the app, the phone can run the whole thing alone. It prefers the PC
server when it can reach one, because that's measurably faster, and falls back to standalone
anywhere else. Details and numbers in `aura-ai/README.md`.
