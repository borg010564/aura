# Aura Android shell

A thin native wrapper around Aura's web page (`aura-ai/web/`). It doesn't reimplement any
assistant logic — no face, wake word, or voice code lives here — it just hosts the same web
page inside a WebView, but with things the browser can't reliably give us:

- Real immersive fullscreen (hides the status bar and nav bar), reasserted automatically if a
  dialog or notification briefly brings them back.
- A hard landscape lock via the manifest, instead of the flaky Screen Orientation Web API.
- The screen is kept on the whole time the app is open.
- A native microphone permission prompt on first launch, independent of Chrome's
  secure-context/gesture rules.
- **Native microphone capture** (see below) — without this the mic does not work at all.

## Why microphone capture is native
WebView's own `getUserMedia()` fails with `NotReadableError: Could not start audio source` on
the devices this was tested on (a UMIDIGI G9 5G and a Black Shark 9, both Android 14), even
with permission granted, the app foregrounded, a secure context, and the microphone
completely idle. WebView captures audio from a **sandboxed isolated renderer process**, which
doesn't satisfy the `RECORD_AUDIO` app-op's `foreground` requirement — and that app-op mode
can't be changed on these OEM builds. Chrome isn't affected because it handles audio
capture differently as a privileged browser.

The workaround, and how it fits together:

- `AudioBridge.kt` records from the **app's own process** with `AudioRecord`
  (`VOICE_RECOGNITION` source, 44.1 kHz mono 16-bit) and pushes base64 PCM into the page.
- `aura-ai/web/native-audio.js` decodes those samples, feeds them through a Web Audio graph
  into a `MediaStreamDestinationNode`, and replaces `navigator.mediaDevices.getUserMedia`
  with one that hands back the resulting **real `MediaStream`**.
- Everything downstream — `MediaRecorder` for press-and-hold, and TensorFlow.js
  speech-commands for the wake word — works unchanged, because it receives an ordinary
  stream and never knows the difference.

44.1 kHz is deliberate: it's the rate speech-commands expects, so its spectrogram framing
lines up without resampling. In a normal browser `window.AuraNative` doesn't exist and
`native-audio.js` does nothing, leaving Chrome behaviour untouched.

## First run
1. Install the app (see below).
2. On first launch, it asks for microphone permission — allow it.
3. It then asks for Aura's address — type in the `https://` URL your server prints on
   startup (e.g. `https://192.168.1.42:8000`), then tap Connect.
4. From then on it remembers that address and loads straight into the face.
5. If your PC's LAN IP ever changes, **long-press anywhere on the screen** to clear the saved
   address and re-enter it.

## Installing the APK directly (fastest way to try it)
A debug build is already at `app/build/outputs/apk/debug/app-debug.apk`. To install it:
1. Enable USB debugging on your phone (Settings → About phone → tap "Build number" 7 times to
   unlock Developer options → enable "USB debugging").
2. Plug the phone into your PC via USB and allow the debugging prompt that appears on it.
3. From `aura-android/`, run:
   ```
   "%ANDROID_HOME%\platform-tools\adb.exe" install -r app\build\outputs\apk\debug\app-debug.apk
   ```
   (or just `adb install -r ...` if `adb` is already on your PATH).

## Opening it in Android Studio instead
Open the `aura-android/` folder as a project in Android Studio — it'll pick up the Gradle
wrapper automatically. From there you can run it straight onto a connected phone (or an
emulator) with the Run button, and edit `MainActivity.kt` if you want to change anything.

## Notes
- The self-signed HTTPS certificate warning you saw in Chrome doesn't happen here — the app
  is configured to accept it automatically, but only for whatever URL you typed in above. It's
  not a general browser, so this doesn't weaken anything beyond this one app trusting its own
  configured server.
- `.jdk/` (if present) is a temporary JDK used only to build from the command line during
  development — Android Studio uses its own bundled JDK and doesn't need it.
