# Aura — phone-as-face AI companion

A DIY take on the Loona robot pet: your Android phone shows an animated glowing-eyes face
with live captions, while your Windows PC runs the "brain" — it listens to what you say
(via the phone's mic), thinks with ChatGPT, and talks back.

## How it works
- `server/` — a Python (FastAPI) app on your PC. It serves the face web page and handles
  speech-to-text, ChatGPT conversation, and text-to-speech via the OpenAI API.
- `web/` — the face page. Open it in Chrome on your phone; it connects back to the PC over
  your WiFi via WebSocket.
- Say **"Hey Aura"** to start talking hands-free, or press and hold anywhere on the screen
  as a manual fallback — release to send.
- Say **"Aura stop"** any time it's thinking or talking to interrupt it immediately, like a
  Google Home/Alexa stop command.
- Say **"go to sleep"** (or "goodnight", "time for bed", "take a nap") and it says a short
  goodnight, then closes its eyes and stays that way until you speak to it again.

### "Go to sleep"
Unlike "Hey Aura" and "Aura stop", this isn't a trained wake word — it's matched against the
transcript of an ordinary utterance, so there's nothing extra to record. It's recognised
before the chat call is made, which makes it instant and free: no reply is generated, nothing
is added to the conversation history, and only the canned sign-off is synthesised.

Matching is against the *whole* utterance rather than a substring, so "when do owls go to
sleep?" and "can I go to sleep?" stay ordinary questions. Leading filler is ignored, including
the ways transcription mangles the name — a real recording of "Aura, go to sleep" came back as
"Or I go to sleep", so those spellings are accepted too.

Once asleep it ignores the camera: walking past won't wake it, which is the difference between
being *told* to sleep and dozing off on its own after a quiet spell. Saying "Hey Aura" or
pressing and holding wakes it back up. The phrase list lives in `server/brain.py` and
`web/direct.js` — keep the two in step if you add to it.

## Setup
1. Install Python 3.10+ if you don't have it.
2. From `server/`, install dependencies:
   ```
   pip install -r requirements.txt
   ```
3. Copy `server/.env.example` to `server/.env` and paste in your OpenAI API key:
   ```
   OPENAI_API_KEY=sk-...
   ```
   To try the whole face/voice pipeline first without spending anything or needing a key yet,
   set `AURA_MOCK=1` in `.env` instead — Aura will skip the real OpenAI calls and reply with a
   canned line + a short test tone, so you can check the eyes/captions/audio flow end-to-end.
4. Run the server from the `server/` folder:
   ```
   python app.py
   ```
   It prints a URL like `http://192.168.1.42:8000` — that's what you'll open on your phone.
   If Windows Firewall prompts you, click **Allow access** for Private networks.

## Which brain Aura uses
With an API key saved, the app picks automatically at launch: it spends ~1.2s looking for
the PC server and uses it if found, otherwise runs standalone. If the server disappears
mid-session it switches to standalone rather than showing an error.

That ordering isn't arbitrary — measured to first spoken word:

| Stage | PC server | Standalone |
|---|---|---|
| Transcribe | 0.54s | 1.09s |
| First sentence | 0.75s | 1.63s |
| Speech starts | 1.28s | 2.31s |
| **Total** | **2.6s** | **5.0s** |

Every stage is roughly twice as slow standalone. It isn't the code — both run the same
pipeline. The PC reaches OpenAI over wired broadband while the phone goes over its WiFi
uplink, and that penalty applies to all three API calls. So: fast at home, portable away.

## Two ways to run Aura
**Standalone (no PC).** Long-press the screen in the Android app, paste an OpenAI API key,
and save. The app then runs the whole assistant on the phone — it calls OpenAI directly for
transcription, chat and speech. The web app is bundled inside the APK and served over
`https://appassets.androidplatform.net`, which keeps it a secure context so the mic and
camera still work. Works anywhere, including on mobile data.

**PC server.** Leave the API key blank and Aura uses the Python server on your PC, found
automatically over the network. This keeps your key off the phone and gives you the server
console, which is far easier to debug with.

Both modes run the *same* web app — `aura-ai/web/` is copied into the APK at build time, so
they can't drift apart. Only the brain behind it differs (`web/direct.js` vs `server/`).

Two things worth knowing before switching:
- **The two modes don't share data.** They're different browser origins, so the trained wake
  word, remembered facts and conversation history each start fresh. Expect to retrain the
  wake word once after switching.
- **In standalone the key lives on the phone** (app preferences, not in the APK). Fine for
  personal use; on a PC server it never leaves your machine.

## Starting the server automatically
The server only runs while its process is alive, so if Aura ever says it can't find the
server, that's usually the reason.

`server/start_aura.bat` starts it with the right working directory (the SSL cert paths in
`.env` are relative to that folder). A shortcut to it lives in the Startup folder, so it
launches minimised at logon:

```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\AuraServer.vbs
```

Delete that file to turn autostart off. The window stays on the taskbar so you can read the
logs or close it to stop the server.

## Microphone over WiFi (important)
Browsers only allow microphone access on a "secure context" — HTTPS, or `localhost`. Since
the phone loads the page over plain `http://<lan-ip>`, pick one of these:

- **Quickest (dev only):** on the phone, open
  `chrome://flags/#unsafely-treat-insecure-origin-as-secure`, enable it, type in
  `http://<lan-ip>:8000` (the exact URL the server printed), then relaunch Chrome.
- **More proper:** run the server over HTTPS with a self-signed certificate. From `server/`:
  ```
  openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 365 -subj "/CN=aura"
  ```
  Then in `server/.env` set:
  ```
  AURA_SSL_CERT=cert.pem
  AURA_SSL_KEY=key.pem
  ```
  Restart the server and open `https://<lan-ip>:8000` on the phone — tap through the
  one-time "connection not private" warning (expected for a self-signed cert).

## Using it
1. On your phone (same WiFi as the PC), open the printed URL in Chrome.
2. The **first time**, press and hold anywhere to grant microphone permission (wake-word
   setup can't request permission on its own — browsers require an actual tap for that the
   first time).
3. Right after that, a **training screen** appears (see below) — record a handful of samples
   once, then it's remembered for future visits.
4. From then on, just say **"Hey Aura"** and speak your question — it auto-detects when
   you've stopped talking (about 1.2s of silence) and sends it. Press and hold still works
   any time as a manual alternative.
5. Watch the eyes go listening → thinking → talking, with a caption and spoken reply.

If wake-word recording cuts you off too early or waits too long before sending, tune
`SPEECH_THRESHOLD` / `SILENCE_MS` near the top of `web/client.js`.

## Training the wake word (and stop word)
"Hey Aura" and "Aura stop" detection both use [TensorFlow.js's Speech Commands](https://github.com/tensorflow/tfjs-models/tree/master/speech-commands)
transfer learning: a small pretrained audio model gets fine-tuned on a few samples of your
own voice, entirely in the browser — no account, no signup, no cloud service. Both phrases
are trained together as one classifier (plus background noise), since that's how this
transfer-learning approach works.

The first time (after granting mic access via press-and-hold), a training screen appears:
1. Tap **"Say Hey Aura"** about 15 times, saying the phrase clearly each time, with a beat
   of silence before/after.
2. Tap **"Say Aura Stop"** about 15 times, the same way.
3. Tap **"Record background noise"** about 15 times — normal room sound, silence, whatever
   it'll actually be idle in, not necessarily silent.
4. Tap **Train** once all three counters reach 15 — training runs locally and takes maybe
   10–30 seconds, then it's remembered (via IndexedDB) so you won't have to redo this on
   future visits, unless you tap the small **"retrain wake word"** link in the bottom-right
   corner.

Accuracy depends entirely on your recordings — since this isn't a purpose-built wake-word
engine, expect to potentially retrain once or twice to get a good balance between it
responding reliably and not triggering on other sounds. If you'd rather skip this altogether,
tap **"Skip — use press-and-hold only"** on the training screen (this also skips "Aura stop"
— you'd just wait it out or reload the page instead).

**If you trained before this feature was added**, the training screen will reappear once —
adding "Aura stop" as a new word means the whole classifier has to be retrained from scratch
(its output size is fixed at training time), so your old "Hey Aura" recordings unfortunately
need to be redone alongside the new "Aura stop" ones.

"Aura stop" only does anything while Aura is **thinking** or **talking** — it interrupts
whatever's in progress and returns to idle immediately. It's ignored the rest of the time.

### If Aura seems not to be listening
Two separate faults caused this, both since fixed. They're worth knowing about, because both
were invisible from the outside and neither was in the part of the code you'd suspect.

**The model wasn't getting a look often enough.** `listen()` was called without an
`overlapFactor`, and the library's default produced a measured hop of 1.0–2.3s on the phone —
longer than the phrase itself. "Hey Aura" regularly fell *between* two windows and was never
scored at all. Now pinned to `WAKE_OVERLAP_FACTOR = 0.9`, measured at ~300ms, so a
one-second phrase gets three or four chances. The render loop stays at ~56fps.

**Every recording ran to the 9-second cap and transcribed to nothing.** The endpointer
learns the room's noise floor over the first 350ms of a recording — but the native audio
bridge doesn't deliver its first sample until ~400ms in, so that window measured pure digital
silence *every single time*. The floor came out as 0, the threshold stayed pinned at its
minimum of 10, and the real room sat at 20 and peaked at 48. So every frame counted as
speech, silence detection never fired, and Whisper got nine seconds of room noise and
returned `""`. The calibration window now starts from the first *audible* frame; recordings
endpoint in 2–4s and the threshold tracks the room (measured floors of 4–18 producing
thresholds of 11–31). `native-audio.js` also keeps the recorder warm for 3s after the last
consumer lets go, so the constant wake-word-to-recording handover doesn't pay that ramp.

An empty transcript is now ignored outright — the server replies with `{"type":"idle"}` and
Aura silently returns to idle. Previously it asked the model to respond to silence, which is
where gems like "Silent partner mode — got it!" came from, at full API cost.

To see what the model is actually hearing, attach remote DevTools and run
`window.__auraWakeLog()`. It reports recent detections with scores and the gaps between
them, which distinguishes the three failure modes: scored low (retrain), scored just under
threshold (lower it), or never scored at all (a cadence gap).

## Personas
Tap the small persona name in the bottom-left corner (starts as "Aura") to cycle through
different personalities, each with its own tone and OpenAI TTS voice:

| Persona | Vibe | Voice |
|---|---|---|
| Aura | witty, a little sassy | nova (female) |
| Nova | warm, gentle, nurturing | nova |
| Rex | confident, deadpan, dry | onyx |
| Echo | theatrical, dramatic | fable |
| Shimmer | bubbly, upbeat | shimmer |
| Robbie | cute, earnest robot | echo (+ ring-mod effect) |

Your choice is remembered (in the phone browser's local storage) and re-applied automatically
next time you open the page. Switching persona keeps the current conversation history — it
just changes tone and voice going forward, it doesn't reset anything. To tweak the wording or
add your own, edit `server/personality.py` — each persona is just a system prompt paired with
a TTS voice name.

Robbie is a bit special: on top of a different voice, his replies also get a light ring-
modulation effect applied client-side (`createRobotEffect` in `web/client.js`) for an actual
robotic warble, not just robot-flavored wording. Tune the `frequency.value` in that function
(currently 35 Hz) for a more or less pronounced effect.

## Response speed
The server talks to OpenAI's **Realtime API** (`server/realtime.py`): audio in, audio out,
one streaming session. Measured end to end, same question and same network:

| | Time to first spoken word |
|---|---|
| Three-call pipeline (transcribe → chat → speak) | 3.2 / 4.1 / 5.2s — **avg 4.2s** |
| Realtime, speech to speech | 1.4 / 1.4 / 1.5 / 1.6s — **avg 1.5s** |

Server-side, from committing the audio to the first byte back, is 0.5–0.95s; the rest is
upload and encoding. Tool turns cost more — asking for weather took 5.8s, since that's two
model responses either side of a live weather lookup.

`AURA_REALTIME=0` reverts to the old pipeline, which is still there in `brain.py` and is
used automatically if the Realtime session can't be opened. Standalone mode (no PC) also
still uses it.

Four things that bit during the port, all of which fail quietly rather than loudly:
- **`output_modalities` must be set explicitly.** A `session.update` that named only a voice
  produced responses containing no audio whatsoever.
- **Realtime has its own voice list.** `nova`, `onyx` and `fable` aren't on it, and asking
  for one fails the entire session. `REALTIME_VOICES` maps each persona to its nearest match.
- **Turn detection had to go.** The phone already endpoints before uploading, so server-side
  VAD waited out a second silence window and raced our explicit commit — whichever lost
  reported `buffer too small... has 0.00ms of audio`.
- **Language drifts.** Working from audio rather than a transcript, a stretch of room noise
  got a fluent reply in Thai. The instructions now pin English.
- **A dropped WebSocket used to be permanent.** There was no reconnect: the page stayed up
  and the wake word kept firing, but recordings were discarded because the transport wasn't
  ready — indistinguishable from Aura ignoring you. Restarting the server did it, and so did
  the router giving the PC a new address. `connectSocket()` now retries with backoff and
  retries immediately when the app is brought back to the foreground.
- **A session's voice is fixed once it has spoken.** `session.update` returns "Cannot update
  a conversation's voice if assistant audio is present" — and since the *whole* update is
  rejected, the new personality didn't take either, so switching persona changed nothing at
  all. Changing voice means a new session, so `set_persona` reconnects and replays the last
  few exchanges into the fresh one (as `input_text` for the user and `output_text` for the
  assistant — swap those and the API rejects the item). Switching mid-chat keeps the thread:
  told a favourite colour as Aura, then asked as Rex, it still answered "you said green".
  Because a switch is now a rebuild rather than an instant update, rapid taps of the
  persona button are coalesced — three taps cost one extra rebuild, not three, and land
  on whichever persona you stopped on.

### The old pipeline, for reference
Measured at **avg 4.2s**, almost all of it OpenAI's, with the spread being API variance
rather than anything in the code:

| Stage | Measured | Ours to control? |
|---|---|---|
| Endpoint + upload | ~0.5-0.7s | yes |
| Transcribe | 0.54-0.69s | partly (scales with clip length) |
| Chat, first token | 0.75-2.01s | no |
| TTS, first audio | 1.48-2.80s | no |

Benchmarking the three calls directly from the PC gave the same numbers, so **the floor for
this three-call design is roughly 3s**, typically 4s — which is what prompted the move to
Realtime above. Tuning within it is worth tenths of a second, not seconds.

Two things that are *not* worth chasing, both measured and ruled out: connection warmth (warm
2.10s vs idle 1.85s — noise), and swapping models (`whisper-1` is slower than
`gpt-4o-mini-transcribe`; `gpt-4o-mini` is no faster than `gpt-4o` to first token).

**If it feels much slower than the above, check which brain it's on** — standalone roughly
doubles every API call (see the table further up). It is worth confirming rather than
assuming: a bug in discovery once left the phone stuck on standalone for an entire session
while the server sat there reachable. `lan_ip()` asked the OS which address reaches the
internet, which on a PC with a VPN returns the VPN's carrier-grade-NAT address — so the phone
was handed `100.64.x.x`, couldn't route to it, and silently fell back. Discovery now resolves
the address by routing to the phone specifically, and the app prefers a direct TCP check of
the remembered address over a UDP broadcast (a firewall will drop the broadcast while
allowing the connection that actually matters).

Three things got the pipeline itself to where it is, each worth roughly a second:

- **Transcription model** — `gpt-4o-mini-transcribe` instead of `whisper-1` (~0.5s vs ~2.0s)
- **Sentence streaming** — the reply is spoken sentence-by-sentence as the model writes it,
  rather than waiting for the whole answer. The opening fragment is deliberately allowed to
  be very short ("Sure!", "No worries!") so sound starts as early as possible
- **Audio streaming** — speech plays as it synthesises, instead of waiting for a finished file

Adjacent dials if you want it snappier still:
- `SILENCE_MS` in `web/client.js` (500ms) — how long Aura waits after you stop talking before
  deciding you're done. This is pure added latency, but drop it too far and it cuts you off
  during natural pauses
- `AURA_MAX_REPLY_TOKENS` in `.env` (120) — shorter replies finish speaking sooner

## Presence (Aura notices you)
Aura uses the front camera to tell whether someone is in front of it. When you're there it
stays awake; when you've been gone a while its eyes close, and they open again when you come
back.

**This is entirely on-device.** Frames are analysed locally by a small face-detection model
([BlazeFace](https://github.com/tensorflow/tfjs-models/tree/master/blazeface), vendored in
`web/blazeface/` so it works without internet). No image is ever uploaded, saved, or sent to
any API — the only thing that leaves `presence.js` is a true/false "someone is there".

The camera is released whenever Aura is in the background, and reacquired on return. If the
camera is missing or you refuse the permission, presence detection just stays off and
everything else works exactly as before.

### Eyes that follow you
The same detection also reports *where* your face is, and Aura turns its eyes towards you
using the `look_left/right/up/down` frames. Detection speeds up to ~2.5×/second while you're
there and drops back to a lazy poll when you're not, so tracking stays responsive without
costing battery when the room is empty.

If the eyes follow you the *wrong way*, flip `MIRROR_HORIZONTAL` in `web/presence.js` — the
front camera's image is left-right reversed relative to where you're actually standing.

Tuning, in `web/face.js`:
- `GAZE_DEADZONE_X` / `GAZE_DEADZONE_Y` — how far off-centre you must be before the eyes
  commit to a direction. Lower = more sensitive, but too low makes them twitch
- `GAZE_FRESH_MS` — how long a reading stays valid before Aura reverts to idle glances

Timings live at the top of `web/presence.js` and `web/face.js`:
- `ABSENT_AFTER_MS` (25s) — how long without seeing a face before you count as gone
- `PRESENCE_GRACE_MS` (45s) — stays awake this long after you interact, even if the camera
  can't see you (a dark room or awkward angle shouldn't make it nod off mid-conversation)
- `DETECT_INTERVAL_MS` (1.2s) — how often it looks; raise it to save battery

Android shows a green camera indicator while this runs. That's the OS being honest about
camera use and can't be suppressed — same as the microphone dot.

## Weather
Ask "what's the weather?", "will it rain later?", or "do I need a jacket?" and Aura looks up
live conditions via [Open-Meteo](https://open-meteo.com/) — free, no API key, no signup.

If you don't name a place, Aura uses whatever it knows: first any location you've told it
(stored in long-term memory below), then `AURA_DEFAULT_LOCATION` from `.env`. If it knows
neither, it simply asks — and remembers your answer, so it only ever asks once.

Set `AURA_WEATHER_UNITS=imperial` in `.env` for °F and mph; the default is metric.

Aura only calls out to the weather service when weather actually comes up, so ordinary
conversation is unaffected in both speed and cost.

## Long-term memory (names and other facts)
Tell Aura your name — or anything else personal — and it sticks permanently. Aura decides
what's worth keeping and saves it to `server/user_memory.json`, which is injected into every
future conversation. This is separate from conversation history, so it survives restarts,
reconnects, and the "forget everything" button.

It works through function calling, so it costs nothing extra on ordinary turns — Aura only
makes the extra call on turns where it actually decides to remember something.

To wipe it, just say *"forget everything you know about me"*, or delete
`server/user_memory.json`. It's plain JSON, so you can also open it and edit or prune facts
by hand. Memory is capped at 40 facts (oldest drop off) so it can't grow forever.

## Conversation memory
Aura remembers your conversation across reloads, reconnects, and server restarts — it's saved
to a plain JSON file at `server/conversation_history.json` on your PC (not in the cloud, not
on the phone). Only the most recent ~12 exchanges are kept, so it won't grow forever or make
replies drift oddly over very long stretches — older turns just quietly roll off.

To start completely fresh, tap **"forget everything"** in the top-right corner (it'll ask you
to confirm, since this can't be undone). You can also just delete
`server/conversation_history.json` directly and restart the server.

## Notes
- `server/.env` holds your OpenAI key — don't commit or share it.
- `server/conversation_history.json` holds your conversation history — also personal, also not
  meant to be committed/shared.
- The trained wake-word model lives in your phone browser's storage (IndexedDB), not in this
  project's files — reinstalling Chrome or clearing site data means retraining.
- Aside from the OpenAI API calls and a one-time download of TensorFlow.js's public pretrained
  base model (a few MB, cached after first load), everything runs on your local WiFi only.
