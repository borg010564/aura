const captionEl = document.getElementById("caption");
const hintEl = document.getElementById("hint");

// Two ways to reach the brain, sharing one protocol:
//  - "server": the Python server on a PC, over a WebSocket (needs the PC running)
//  - "direct": OpenAI called straight from the phone (standalone, no PC at all)
// direct.js emits exactly the events the server would, so nothing below cares which.
const useDirect =
  window.AuraConfig && window.AuraConfig.mode === "direct" &&
  window.AuraDirect && window.AuraDirect.isReady();

let ws = null;
const transport = useDirect
  ? {
      kind: "direct",
      isReady: () => true,
      sendAudio: (buf) => AuraDirect.sendAudio(buf),
      sendControl: (obj) => AuraDirect.sendControl(obj),
    }
  : {
      // The socket is created by connectSocket() below and replaced on every reconnect,
      // so everything here reads `ws` at call time rather than capturing it.
      kind: "server",
      isReady: () => ws != null && ws.readyState === WebSocket.OPEN,
      sendAudio: (buf) => ws.send(buf),
      sendControl: (obj) => ws.send(JSON.stringify(obj)),
    };

// Reconnect backoff: quick first retry, easing off to one attempt every 10s.
const RECONNECT_BASE_MS = 700;
const RECONNECT_MAX_MS = 10000;
let reconnectAttempt = 0;
let reconnectTimer = null;
console.log("[aura] transport:", transport.kind);

const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
let talkRAF = null;

let mediaRecorder = null;
let chunks = [];
let micStream = null;
let holding = false; // true only while the user is physically pressing (press-and-hold mode)
let recordingMode = null; // 'press' | 'wake' | null
let recordingStartedAt = 0;

// Tune these if wake-word recording cuts you off too early or waits too long.
//
// The threshold adapts to the room. A fixed value of 10 was below the ambient noise floor
// here, so "you've stopped talking" never triggered and every command ran to the full
// timeout — which felt like Aura taking 12 seconds to respond when the APIs only took ~3.
const SPEECH_THRESHOLD = 10; // floor; the real threshold is raised to suit the room
const NOISE_CALIBRATION_MS = 350; // listen this long at the start to gauge the room
const NOISE_MARGIN = 1.7; // speech must exceed noise floor by this factor
const NOISE_MARGIN_ABS = 7; // ...and by at least this much, for very quiet rooms
// Stop this long after speech ends. This is pure dead time you sit through before Aura
// even starts thinking, and it also pads every clip with silence that then has to be
// uploaded and transcribed — a 4s recording of a 1.5s question took 1.6s to transcribe
// where a tight one takes 0.6s. 500ms still tolerates the pause in "what's the weather...
// in London?" without cutting you off.
const SILENCE_MS = 500;
const MAX_RECORDING_MS = 9000; // hard cap per command

// Speech recognition gains nothing above 16 kHz, and the native bridge captures at 44.1 kHz
// for the wake-word model's benefit. Downsampling before upload cut a 1 MB clip to ~380 KB,
// so it reaches the server sooner.
const UPLOAD_SAMPLE_RATE = 16000;
// Anything below this fraction of the clip's own peak counts as silence when trimming the
// ends. Relative rather than absolute because the mic level varies hugely between rooms.
const SILENCE_TRIM_FRACTION = 0.06;
const SILENCE_TRIM_MARGIN_MS = 120; // keep this much either side, so nothing gets clipped

// Clips shorter than this are almost always an accidental tap/false-trigger, not a real
// command — OpenAI rejects anything under ~0.1s anyway, so skip sending these entirely.
const MIN_SEND_MS = 400;

// How much to amplify Aura's spoken replies. 1.0 = unchanged; raise if it's still too
// quiet, lower if it sounds distorted/crackly even with the compressor. Chrome on Android
// seems to duck playback volume more than Edge while the mic is held open for wake-word
// listening (an OS-level thing, not something we control) — pushed higher to compensate.
const TTS_VOLUME_BOOST = 4.0;
// Applied *after* the limiter, to recover the loudness the limiter takes off the peaks.
// Raise this first if replies are still too quiet.
const TTS_MAKEUP_GAIN = 2.2;

// ---- Persona switching (personality + TTS voice, set server-side per connection) ----

const personaBtn = document.getElementById("personaBtn");
let personaList = [{ id: "aura", label: "Aura" }];
let currentPersonaId = "aura";

function renderPersonaBtn() {
  const current = personaList.find((p) => p.id === currentPersonaId);
  personaBtn.textContent = current ? current.label : currentPersonaId;
}

personaBtn.addEventListener("click", () => {
  if (personaList.length < 2 || !transport.isReady()) return;
  const idx = personaList.findIndex((p) => p.id === currentPersonaId);
  const next = personaList[(idx + 1) % personaList.length];
  transport.sendControl({ type: "set_persona", persona: next.id });
});

// ---- Conversation memory reset ----

const forgetBtn = document.getElementById("forgetBtn");

forgetBtn.addEventListener("click", () => {
  if (!transport.isReady()) return;
  if (!confirm("Forget the whole conversation history? This can't be undone.")) return;
  transport.sendControl({ type: "clear_history" });
});

function setCaption(text) {
  captionEl.textContent = text || "";
}

function hideHint() {
  hintEl.classList.add("hidden");
}

function pickMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"];
  return candidates.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || "";
}

// Android hands out the microphone exclusively: while we hold an open capture stream,
// the wake-word engine's own getUserMedia() fails with NotReadableError ("Could not
// start audio source"). So the mic is acquired per-recording and released immediately
// afterwards rather than cached open for the lifetime of the page.
async function ensureMic() {
  if (micStream && micStream.getAudioTracks().some((t) => t.readyState === "live")) {
    return micStream;
  }
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  return micStream;
}

function releaseMic() {
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
}

// True when the Android app is feeding us raw PCM (see native-audio.js).
function nativePcmAvailable() {
  return typeof window.__auraStartPcmTap === "function";
}

// The raw mic signal comes through quiet, and quiet audio transcribes badly — clips were
// coming back as '' or misheard. Normalising the peak up to near full scale before upload
// makes a large difference. Capped so near-silence isn't blown up into loud noise.
const WAV_TARGET_PEAK = 0.95;
// Measured peaks on this phone are around 0.02-0.03 of full scale, so the cap has to be
// generous or normalisation can't reach a usable level. The limiter downstream stops this
// turning quiet-room hiss into loud noise.
const WAV_MAX_GAIN = 30;

/** Flattens chunks and resamples to targetRate (linear interpolation is fine for speech). */
function flattenAndResample(chunks, sourceRate, targetRate) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const src = new Float32Array(n);
  let o = 0;
  for (const c of chunks) {
    src.set(c, o);
    o += c.length;
  }
  if (!targetRate || targetRate >= sourceRate) return src;

  const ratio = sourceRate / targetRate;
  const outLen = Math.floor(src.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const i1 = i0 + 1 < src.length ? i0 + 1 : i0;
    const frac = pos - i0;
    out[i] = src[i0] * (1 - frac) + src[i1] * frac;
  }
  return out;
}

/**
 * Cuts the dead air off both ends of a clip.
 *
 * Every recording has some: the native bridge needs a moment to produce its first sample,
 * and the endpointer only stops after a deliberate stretch of silence. That padding gets
 * uploaded and transcribed like anything else — transcription time tracks clip length
 * closely (0.6s for a tight clip against 1.6s for one twice as long), so trimming it is
 * a direct latency win. A generous margin is left at each end: clipping a word costs far
 * more than a tenth of a second of silence.
 */
function trimSilence(samples, sampleRate) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = samples[i] < 0 ? -samples[i] : samples[i];
    if (a > peak) peak = a;
  }
  if (peak <= 0.0005) return samples; // nothing there; leave it for the caller to reject

  const gate = peak * SILENCE_TRIM_FRACTION;
  const margin = Math.floor((SILENCE_TRIM_MARGIN_MS / 1000) * sampleRate);

  let first = 0;
  while (first < samples.length && Math.abs(samples[first]) < gate) first++;
  let last = samples.length - 1;
  while (last > first && Math.abs(samples[last]) < gate) last--;

  const from = Math.max(0, first - margin);
  const to = Math.min(samples.length, last + margin);
  return from === 0 && to === samples.length ? samples : samples.subarray(from, to);
}

/** Packs captured float chunks into a 16-bit mono WAV file, level-normalised. */
function encodeWav(inputChunks, inputRate) {
  const sampleRate = Math.min(UPLOAD_SAMPLE_RATE || inputRate, inputRate);
  const resampled = flattenAndResample(inputChunks, inputRate, sampleRate);
  const samples = trimSilence(resampled, sampleRate);
  const trimmedMs = Math.round(((resampled.length - samples.length) / sampleRate) * 1000);
  const chunks = [samples];

  let total = samples.length;
  let peak = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const a = c[i] < 0 ? -c[i] : c[i];
      if (a > peak) peak = a;
    }
  }

  let gain = 1;
  if (peak > 0.0005) {
    gain = Math.min(WAV_TARGET_PEAK / peak, WAV_MAX_GAIN);
    if (gain < 1) gain = 1; // never quieten, only lift
  }
  console.log(
    "[aura] wav peak=" + peak.toFixed(4) + " gain=" + gain.toFixed(2) +
      " samples=" + total + " @" + sampleRate + "Hz, trimmed " + trimmedMs + "ms of silence"
  );

  const bytes = new ArrayBuffer(44 + total * 2);
  const view = new DataView(bytes);

  const ascii = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };

  ascii(0, "RIFF");
  view.setUint32(4, 36 + total * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM header size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, total * 2, true);

  let offset = 44;
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i++) {
      let s = chunk[i] * gain;
      if (s > 1) s = 1;
      else if (s < -1) s = -1;
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      offset += 2;
    }
  }
  return bytes;
}

// ---- Wake word ("Hey Aura") via a small model trained on YOUR voice, in-browser ----
// Uses TensorFlow.js "Speech Commands" transfer learning: record a handful of "Hey Aura"
// and background-noise samples once, it trains a tiny classifier locally (no account, no
// cloud), and the trained model is remembered via IndexedDB so you won't retrain again
// unless you tap "retrain wake word". No signup, but accuracy depends on your recordings —
// use the retrain link if it's too trigger-happy or not responsive enough.

const WAKE_WORD_LABEL = "hey_aura";
const STOP_WORD_LABEL = "aura_stop";
// Bumped to v2 because adding "aura_stop" as a new class requires a full retrain —
// the classifier's output size is fixed at training time, so old v1 models saved
// under the old name are simply left behind and the training panel reappears.
const WAKE_MODEL_NAME = "aura-wake-word-v2";
const OLD_WAKE_MODEL_NAME = "aura-wake-word";
const MIN_EXAMPLES_PER_CLASS = 15;
const WAKE_PROBABILITY_THRESHOLD = 0.85;
// How often the model gets a look at the incoming audio, as a fraction of its ~1s window.
// This matters far more than it looks. Left at the library's default, measured hops on the
// phone were 1.0-2.3s — longer than the phrase itself, so "Hey Aura" regularly fell
// *between* two windows and was never scored at all, which felt exactly like Aura ignoring
// you. At 0.9 the hop measured 283ms, so any one-second phrase gets three or four chances
// to be recognised. The extra inference is affordable: the render loop stayed at ~56fps.
const WAKE_OVERLAP_FACTOR = 0.9;
// Stricter than the wake threshold: while Aura is talking, its own voice can bleed from
// the speaker into the mic (no real echo cancellation here) and get misheard as "Aura
// stop", cutting itself off. Requiring much higher confidence during playback specifically
// cuts down on that self-triggering without touching normal "Hey Aura" sensitivity.
const STOP_PROBABILITY_THRESHOLD = 0.97;

let transferRecognizer = null;
const WAKE_LOG_SIZE = 60;
const wakeLog = [];
// Exposed for debugging over remote DevTools: shows the recent frames and, importantly,
// the gaps between them — a phrase can only be recognised if a window covers it.
window.__auraWakeLog = () => {
  const gaps = wakeLog.slice(1).map((r, i) => r.at - wakeLog[i].at);
  return {
    frames: wakeLog.length,
    medianGapMs: gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] : null,
    gapsOver1s: gaps.filter((g) => g > 1000).length,
    best: [...wakeLog].sort((a, b) => b.score - a.score).slice(0, 8),
    recent: wakeLog.slice(-15),
  };
};

let wakeReady = false; // model trained/loaded and safe to start listening
let wakeListening = false;
let turnCancelled = false; // set when "Aura stop" interrupts a thinking/talking turn
let currentAudioSource = null; // the currently-playing TTS AudioBufferSourceNode, if any
let currentRobotEffectStop = null; // stops the Robbie persona's ring-mod oscillator, if active

// A cheap, classic "robot voice" effect: ring modulation. Multiplying the voice signal by a
// low-frequency carrier tone is what gives it that robotic warble. Only applied for Robbie.
function createRobotEffect(ctx) {
  const carrier = ctx.createOscillator();
  carrier.type = "sine";
  carrier.frequency.value = 35; // Hz
  const ringGain = ctx.createGain();
  ringGain.gain.value = 0; // base 0 so output = input * carrier signal (true ring mod)
  carrier.connect(ringGain.gain);
  carrier.start();
  return {
    node: ringGain,
    stop: () => {
      try {
        carrier.stop();
      } catch (_) {}
    },
  };
}

const trainPanel = document.getElementById("trainPanel");
const trainStatus = document.getElementById("trainStatus");
const wakeCountEl = document.getElementById("wakeCount");
const noiseCountEl = document.getElementById("noiseCount");
const stopCountEl = document.getElementById("stopCount");
const recordWakeBtn = document.getElementById("recordWake");
const recordNoiseBtn = document.getElementById("recordNoise");
const recordStopBtn = document.getElementById("recordStop");
const trainBtn = document.getElementById("trainBtn");
const skipTrainBtn = document.getElementById("skipTrain");
const retrainLink = document.getElementById("retrainLink");

async function setupWakeWordListening() {
  if (transferRecognizer) return;
  if (!window.speechCommands || !window.tf) {
    return; // library failed to load (e.g. no internet on first run); press-and-hold still works
  }

  try {
    const baseRecognizer = speechCommands.create("BROWSER_FFT");
    await baseRecognizer.ensureModelLoaded();
    transferRecognizer = baseRecognizer.createTransfer(WAKE_MODEL_NAME);

    const saved = await speechCommands.listSavedTransferModels();
    if (saved.includes(WAKE_MODEL_NAME)) {
      await transferRecognizer.load();
      wakeReady = true;
      retrainLink.classList.remove("panel-hidden");
    } else {
      try {
        await speechCommands.deleteSavedTransferModel(OLD_WAKE_MODEL_NAME);
      } catch (_) {}
      showTrainPanel();
    }
  } catch (err) {
    console.log("[aura wake] init failed:", err);
  }
}

function showTrainPanel() {
  trainPanel.classList.remove("panel-hidden");
  updateExampleCounts();
}

function hideTrainPanel() {
  trainPanel.classList.add("panel-hidden");
}

function updateExampleCounts() {
  const counts = transferRecognizer.isDatasetEmpty() ? {} : transferRecognizer.countExamples();
  const wakeN = counts[WAKE_WORD_LABEL] || 0;
  const noiseN = counts[speechCommands.BACKGROUND_NOISE_TAG] || 0;
  const stopN = counts[STOP_WORD_LABEL] || 0;
  wakeCountEl.textContent = wakeN;
  noiseCountEl.textContent = noiseN;
  stopCountEl.textContent = stopN;
  trainBtn.disabled =
    wakeN < MIN_EXAMPLES_PER_CLASS || noiseN < MIN_EXAMPLES_PER_CLASS || stopN < MIN_EXAMPLES_PER_CLASS;
}

let collectingExample = false;

async function recordTrainingSample(label) {
  // collectExample() throws if called again while a previous call is still in-flight
  // (e.g. from tapping the button more than once before it visibly responds) — guard
  // against that instead of letting the confusing library error surface.
  if (collectingExample) return;
  collectingExample = true;
  recordWakeBtn.disabled = true;
  recordNoiseBtn.disabled = true;
  recordStopBtn.disabled = true;
  trainStatus.textContent = "Listening… say it now";
  releaseMic(); // the recognizer opens its own stream; ours would block it
  try {
    // collectExample() can hang indefinitely if the mic stream never opens (seen in
    // Android WebView) — it neither resolves nor rejects, leaving the UI stuck on
    // "Listening…". Race it against a timeout so a failure is at least visible.
    await Promise.race([
      transferRecognizer.collectExample(label),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timed out waiting for the microphone")), 8000)
      ),
    ]);
    trainStatus.textContent = "";
  } catch (err) {
    trainStatus.textContent = "Couldn't record: " + (err && err.message ? err.message : err);
  } finally {
    collectingExample = false;
    recordWakeBtn.disabled = false;
    recordNoiseBtn.disabled = false;
    recordStopBtn.disabled = false;
  }
  updateExampleCounts();
}

recordWakeBtn.addEventListener("click", () => recordTrainingSample(WAKE_WORD_LABEL));
recordNoiseBtn.addEventListener("click", () => recordTrainingSample(speechCommands.BACKGROUND_NOISE_TAG));
recordStopBtn.addEventListener("click", () => recordTrainingSample(STOP_WORD_LABEL));

skipTrainBtn.addEventListener("click", () => {
  transferRecognizer.clearExamples();
  hideTrainPanel();
});

trainBtn.addEventListener("click", async () => {
  trainBtn.disabled = true;
  recordWakeBtn.disabled = true;
  recordNoiseBtn.disabled = true;
  recordStopBtn.disabled = true;
  trainStatus.textContent = "Training…";
  try {
    await transferRecognizer.train({
      epochs: 30,
      callback: {
        onEpochEnd: async (epoch, logs) => {
          trainStatus.textContent = `Training… epoch ${epoch + 1} (accuracy ${Math.round((logs.acc || 0) * 100)}%)`;
        },
      },
    });
    await transferRecognizer.save();
    wakeReady = true;
    hideTrainPanel();
    retrainLink.classList.remove("panel-hidden");
    resumeWakeWordListening();
  } catch (err) {
    trainStatus.textContent = "Training failed: " + (err && err.message ? err.message : err);
    recordWakeBtn.disabled = false;
    recordNoiseBtn.disabled = false;
    recordStopBtn.disabled = false;
    trainBtn.disabled = false;
  }
});

retrainLink.addEventListener("click", async () => {
  await pauseWakeWordListening();
  try {
    await speechCommands.deleteSavedTransferModel(WAKE_MODEL_NAME);
  } catch (_) {}
  transferRecognizer.clearExamples();
  wakeReady = false;
  retrainLink.classList.add("panel-hidden");
  showTrainPanel();
});

async function resumeWakeWordListening() {
  if (!transferRecognizer || !wakeReady || wakeListening) return;
  if (mediaRecorder && mediaRecorder.state === "recording") return;
  releaseMic(); // hand the mic back before the recognizer opens its own stream
  try {
    await transferRecognizer.listen(
      (result) => {
        const words = transferRecognizer.wordLabels();
        const scores = Array.from(result.scores);
        const topIndex = scores.indexOf(Math.max(...scores));
        const label = words[topIndex];
        const score = scores[topIndex];

        // A rolling record of what the model actually heard. Wake-word accuracy depends on
        // recordings only the user has, so when "it didn't hear me" the useful question is
        // whether the phrase scored 0.2 (needs retraining) or 0.8 (threshold too strict) —
        // or was never scored at all (a gap in the listening cadence). Run
        // window.__auraWakeLog() to see.
        wakeLog.push({ at: Math.round(performance.now()), label, score: +score.toFixed(3) });
        if (wakeLog.length > WAKE_LOG_SIZE) wakeLog.shift();

        if (label === WAKE_WORD_LABEL && score > WAKE_PROBABILITY_THRESHOLD && Face.state === "idle") {
          pauseWakeWordListening();
          beginRecording("wake");
        } else if (
          label === STOP_WORD_LABEL &&
          score > STOP_PROBABILITY_THRESHOLD &&
          (Face.state === "thinking" || Face.state === "talking")
        ) {
          stopAuraNow();
        }
      },
      {
        probabilityThreshold: WAKE_PROBABILITY_THRESHOLD,
        includeSpectrogram: false,
        overlapFactor: WAKE_OVERLAP_FACTOR,
        // The library suppresses callbacks for a second after each recognition. That's
        // meant to stop one word firing twice, but "Aura stop" has to be heard *while*
        // Aura is mid-reply — possibly right after a previous detection — so keep it short.
        suppressionTimeMillis: 200,
      }
    );
    wakeListening = true;
  } catch (err) {
    console.log("[aura wake] resume failed:", err);
  }
}

async function pauseWakeWordListening() {
  if (!transferRecognizer || !wakeListening) return;
  wakeListening = false;
  try {
    await transferRecognizer.stopListening();
  } catch (_) {}
}

// Monitors the level of whatever we're recording. In wake mode it also decides when
// you've stopped talking. It always records the peak so we can tell, after the fact,
// whether any real speech reached us at all.
let lastRecordingPeak = 0;
let lastRecordingHeardSpeech = false;

function startLevelWatch(stream, autoStop) {
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);

  const startedAt = performance.now();
  let heardSpeech = false;
  let silenceStart = null;
  let noiseSum = 0;
  let noiseCount = 0;
  let threshold = SPEECH_THRESHOLD;
  let calibrated = false;
  let audibleFrom = null; // when the bridge actually started delivering audio
  lastRecordingPeak = 0;
  lastRecordingHeardSpeech = false;

  function check() {
    if (!mediaRecorder || mediaRecorder.state !== "recording") {
      source.disconnect();
      return;
    }
    analyser.getByteFrequencyData(data);
    const avg = data.reduce((a, b) => a + b, 0) / data.length;
    const now = performance.now();
    const elapsed = now - startedAt;
    if (avg > lastRecordingPeak) lastRecordingPeak = avg;

    // Spend the first fraction of a second learning this room's noise floor, then set a
    // threshold above it. Without this, a noisy room reads as continuous speech.
    //
    // Time the window from the first *audible* frame, not from when recording started.
    // The native bridge takes ~400ms to deliver its first sample, so a window anchored to
    // the start measured pure digital silence every time: floor 0, threshold pinned to its
    // 10 minimum, while the real room sat at 20 and peaked at 48. Everything then counted
    // as speech, so it never endpointed, every recording ran to the 9s cap, and nine
    // seconds of room noise transcribed to "" — which felt like Aura ignoring you.
    if (!calibrated) {
      if (avg <= 0 && audibleFrom === null) {
        requestAnimationFrame(check); // bridge hasn't started delivering yet
        return;
      }
      if (audibleFrom === null) audibleFrom = now;
      if (now - audibleFrom < NOISE_CALIBRATION_MS) {
        noiseSum += avg;
        noiseCount++;
        requestAnimationFrame(check);
        return;
      }
      const floor = noiseCount ? noiseSum / noiseCount : 0;
      threshold = Math.max(SPEECH_THRESHOLD, floor * NOISE_MARGIN, floor + NOISE_MARGIN_ABS);
      calibrated = true;
      console.log(
        "[aura] noise floor=" + floor.toFixed(1) + " -> speech threshold=" + threshold.toFixed(1)
      );
    }

    if (avg > threshold) {
      heardSpeech = true;
      lastRecordingHeardSpeech = true;
      silenceStart = null;
    } else if (heardSpeech && autoStop) {
      if (silenceStart === null) silenceStart = now;
      if (now - silenceStart > SILENCE_MS) {
        console.log("[aura] endpointed after " + Math.round(elapsed) + "ms");
        source.disconnect();
        finishRecording();
        return;
      }
    }

    if (autoStop && elapsed > MAX_RECORDING_MS) {
      console.log("[aura] recording hit the " + MAX_RECORDING_MS + "ms cap");
      source.disconnect();
      finishRecording();
      return;
    }

    requestAnimationFrame(check);
  }
  requestAnimationFrame(check);
}

// ---- Shared recording flow (used by both press-and-hold and wake word) ----

async function beginRecording(mode) {
  if (mediaRecorder && mediaRecorder.state === "recording") return;

  await pauseWakeWordListening();
  if (mode === "press") holding = true;
  hideHint();
  setCaption(micStream ? "" : "Requesting microphone access…");

  try {
    await audioCtx.resume();
    const stream = await ensureMic();

    if (mode === "press" && !holding) {
      // released before permission resolved; abort cleanly, nothing recorded
      releaseMic();
      resumeWakeWordListening();
      return;
    }

    chunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: pickMimeType() });
    mediaRecorder.ondataavailable = (ev) => {
      if (ev.data.size > 0) chunks.push(ev.data);
    };
    mediaRecorder.onstop = handleRecordingStopped;
    if (nativePcmAvailable()) window.__auraStartPcmTap();
    mediaRecorder.start();
    recordingStartedAt = performance.now();
    recordingMode = mode;
    Face.setState("listening");
    setCaption("");

    // Always monitor level; only wake-mode auto-stops on silence.
    startLevelWatch(stream, mode === "wake");
    if (mode !== "wake" && !holding) {
      // released right as recording started
      finishRecording();
    }
  } catch (err) {
    setCaption("Mic error: " + (err && err.message ? err.message : err));
    Face.setState("idle");
    holding = false;
    recordingMode = null;
    releaseMic();
    resumeWakeWordListening();
  }
}

function finishRecording() {
  if (!mediaRecorder || mediaRecorder.state !== "recording") return;
  Face.setState("thinking");
  mediaRecorder.stop();
}

async function handleRecordingStopped() {
  recordingMode = null;
  holding = false;
  const elapsedMs = performance.now() - recordingStartedAt;
  let buf;
  const tapped = nativePcmAvailable() ? window.__auraStopPcmTap() : null;
  if (tapped && tapped.length) {
    // Raw PCM straight from the native bridge — no silence padding, no re-encode.
    buf = encodeWav(tapped, window.__auraPcmSampleRate || 44100);
  } else {
    const blob = new Blob(chunks, { type: mediaRecorder.mimeType });
    buf = await blob.arrayBuffer();
  }
  releaseMic(); // free the mic so wake-word listening can reclaim it below

  console.log(
    "[aura] recorded " +
      Math.round(elapsedMs) +
      "ms, " +
      buf.byteLength +
      " bytes, peakLevel=" +
      Math.round(lastRecordingPeak) +
      " (threshold " +
      SPEECH_THRESHOLD +
      "), speechDetected=" +
      lastRecordingHeardSpeech
  );

  if (buf.byteLength > 0 && elapsedMs >= MIN_SEND_MS && transport.isReady()) {
    turnCancelled = false;
    transport.sendAudio(buf);
    // Resume listening now (not just after the reply finishes) so "Aura stop" can be
    // heard while it's thinking/talking, not only once it's back to idle.
    resumeWakeWordListening();
  } else {
    Face.setState("idle");
    resumeWakeWordListening();
  }
}

function stopAuraNow() {
  pendingSleep = false; // "Aura stop" cancels the turn, sleep command included
  // Tell the brain too, not just the speaker. In realtime mode the model is still
  // generating speech we'd be paying for and throwing away.
  if (transport.isReady()) transport.sendControl({ type: "stop" });
  // Mark the turn cancelled whenever more audio is still on its way — either the reply
  // hasn't been generated yet ("thinking"), or speech is still streaming in mid-sentence.
  // The flag is cleared when the turn's "audio_end" arrives.
  if (Face.state === "thinking" || (pcmStream && !pcmStream.finished)) {
    turnCancelled = true;
  }
  stopPcmStream();
  if (currentAudioSource) {
    try {
      currentAudioSource.stop();
    } catch (_) {}
    currentAudioSource = null;
  }
  cancelAnimationFrame(talkRAF);
  Face.setTalkLevel(0);
  Face.setState("idle");
  setCaption("");
}

// ---- Fullscreen + landscape lock (needs a real user gesture, so tied to the first tap) ----

let immersiveRequested = false;

async function requestImmersiveMode() {
  if (immersiveRequested) return;
  immersiveRequested = true;
  try {
    if (document.documentElement.requestFullscreen && !document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
    }
  } catch (err) {
    console.log("[aura] fullscreen request failed:", err);
    // fullscreen can be denied/unsupported (e.g. some in-app browsers) — not fatal
  }
  try {
    if (screen.orientation && screen.orientation.lock) {
      await screen.orientation.lock("landscape");
    }
  } catch (err) {
    console.log("[aura] orientation lock failed:", err);
    // orientation lock commonly requires fullscreen to have actually succeeded, or
    // isn't supported at all — falls back to whatever orientation the phone is in
  }
}

// ---- Press-and-hold (manual fallback, no cloud speech recognition involved) ----

async function startHold(e) {
  // Request fullscreen on the very first tap anywhere, including on the training panel's
  // buttons — if we only checked for this outside the panel, anyone who only ever
  // interacts via "Hey Aura" after training would never trigger it at all.
  requestImmersiveMode();

  // Let the training panel's own buttons handle their own taps — don't hijack them
  // into a press-and-hold recording, and don't preventDefault (which can suppress
  // the button's click event on touch devices).
  if (e.target && e.target.closest && e.target.closest("#trainPanel, #retrainLink, #personaBtn, #forgetBtn")) return;

  if (e.cancelable) e.preventDefault();
  if (holding || (mediaRecorder && mediaRecorder.state === "recording")) return;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setCaption("Mic isn't available on this connection — see README (needs HTTPS or a Chrome flag).");
    return;
  }

  await beginRecording("press");
  await setupWakeWordListening(); // creates the recognizer now that we're inside a real gesture
  resumeWakeWordListening(); // if a model was already trained/saved, start listening right away
}

function stopHold(e) {
  if (e && e.target && e.target.closest && e.target.closest("#trainPanel, #retrainLink, #personaBtn, #forgetBtn")) return;
  if (e && e.cancelable) e.preventDefault();
  if (!holding) return;
  holding = false;
  if (recordingMode === "press" && mediaRecorder && mediaRecorder.state === "recording") {
    finishRecording();
  }
}

document.addEventListener("pointerdown", startHold);
document.addEventListener("pointerup", stopHold);
document.addEventListener("pointercancel", stopHold);
document.addEventListener("pointerleave", stopHold);
document.addEventListener("contextmenu", (e) => e.preventDefault());

async function handleTransportEvent(event) {
  if (typeof event.data === "string") {
    const msg = JSON.parse(event.data);
    if (msg.type === "thinking") {
      if (!turnCancelled) Face.setState("thinking");
    } else if (msg.type === "reply") {
      if (!turnCancelled) setCaption(msg.reply_text);
      // if cancelled, the binary audio for this same turn is still coming — leave the
      // flag set so that gets skipped too, then it'll be cleared there.
    } else if (msg.type === "error") {
      turnCancelled = false;
      pendingSleep = false;
      Face.setState("idle");
      setCaption("Hmm, something went wrong: " + msg.message);
      resumeWakeWordListening();
    } else if (msg.type === "personas") {
      personaList = msg.list;
      currentPersonaId = msg.current;
      const saved = localStorage.getItem("aura_persona");
      if (saved && saved !== currentPersonaId && personaList.some((p) => p.id === saved)) {
        transport.sendControl({ type: "set_persona", persona: saved });
      } else {
        renderPersonaBtn();
      }
    } else if (msg.type === "persona_set") {
      currentPersonaId = msg.persona;
      localStorage.setItem("aura_persona", currentPersonaId);
      renderPersonaBtn();
    } else if (msg.type === "history_cleared") {
      setCaption("(memory cleared)");
    } else if (msg.type === "idle") {
      // Nothing was heard; drop the "thinking" face without saying anything.
      turnCancelled = false;
      Face.setState("idle");
      setCaption("");
      resumeWakeWordListening();
    } else if (msg.type === "sleep") {
      // Usually the goodnight is still playing, so wait for it to finish. But in realtime
      // mode the sleep arrives after a tool round-trip, by which point the audio may
      // already be done — and then there'd be nothing left to trigger the sleep.
      if (pcmStream) pendingSleep = true;
      else goToSleep();
    } else if (msg.type === "audio_start") {
      if (!turnCancelled) startPcmStream(msg.sampleRate || 24000);
    } else if (msg.type === "audio_end") {
      if (turnCancelled) {
        turnCancelled = false; // the cancelled turn's audio has finished arriving
      } else {
        endPcmStream();
      }
    }
    return;
  }
  // Binary frame: either a chunk of streamed PCM, or (mock mode) a whole WAV file.
  if (pcmStream) {
    if (!turnCancelled) pushPcmChunk(event.data);
    return;
  }
  if (turnCancelled) {
    turnCancelled = false; // stale audio for the cancelled turn consumed
    return;
  }
  await playReplyAudio(event.data);
};

// ---- Streamed speech playback ----
//
// The server sends raw PCM as it's synthesised rather than one finished file, so playback
// starts on the first chunk instead of waiting out the whole ~2.5s of synthesis. Each chunk
// is scheduled back-to-back on the Web Audio clock so it plays gapless.

let pcmStream = null;
// Set by a "go to sleep" command, applied once its spoken sign-off has played out.
let pendingSleep = false;

/** Closes the eyes for real, after any goodnight has finished. */
function goToSleep() {
  pendingSleep = false;
  Face.setTalkLevel(0);
  Face.sleep();
  setCaption('Sleeping — say "Hey Aura" to wake me.');
  // Keep listening: the wake word is the way back, and it costs nothing while idle.
  resumeWakeWordListening();
}

/**
 * Builds the playback chain: boost -> peak limiter -> makeup gain -> speaker.
 *
 * The order matters. Feeding a boosted signal into a DynamicsCompressor with the browser's
 * defaults (threshold -24 dB, ratio 12:1) squashes the whole signal and, with no makeup
 * gain after it, ends up *quieter* than no processing at all. Here the compressor is set
 * to behave as a limiter that only catches peaks, and the volume is made up afterwards.
 */
function createPlaybackChain() {
  const input = audioCtx.createGain();
  input.gain.value = TTS_VOLUME_BOOST;

  const limiter = audioCtx.createDynamicsCompressor();
  limiter.threshold.value = -6; // only intervene near the top
  limiter.knee.value = 0;
  limiter.ratio.value = 20; // hard limit rather than gentle compression
  limiter.attack.value = 0.003;
  limiter.release.value = 0.1;

  const makeup = audioCtx.createGain();
  makeup.gain.value = TTS_MAKEUP_GAIN;

  input.connect(limiter);
  limiter.connect(makeup);
  makeup.connect(audioCtx.destination);
  return { input, limiter, makeup };
}

function startPcmStream(sampleRate) {
  stopPcmStream(); // never leave an old stream running

  const chain = createPlaybackChain();
  const gain = chain.input;

  pcmStream = {
    sampleRate,
    gain,
    nextTime: 0,
    sources: [],
    finished: false,
    endTimer: null,
  };

  audioCtx.resume().catch(() => {});
  Face.setState("talking");
}

function pushPcmChunk(arrayBuffer) {
  const stream = pcmStream;
  if (!stream || arrayBuffer.byteLength < 2) return;

  // 16-bit little-endian mono -> float samples
  const samples = new Int16Array(arrayBuffer);
  const floats = new Float32Array(samples.length);
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i] / 32768;
    floats[i] = v;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
  }

  const buffer = audioCtx.createBuffer(1, floats.length, stream.sampleRate);
  buffer.copyToChannel(floats, 0);
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(stream.gain);

  // Keep a small lead so scheduling jitter can't cause gaps, but stay responsive.
  const now = audioCtx.currentTime;
  if (stream.nextTime < now + 0.08) stream.nextTime = now + 0.08;
  source.start(stream.nextTime);
  stream.nextTime += buffer.duration;
  stream.sources.push(source);
  source.onended = () => {
    const i = stream.sources.indexOf(source);
    if (i >= 0) stream.sources.splice(i, 1);
  };

  // Drive the talking animation straight from the audio we just scheduled.
  Face.setTalkLevel(Math.min(1, peak * 1.7));
}

function endPcmStream() {
  const stream = pcmStream;
  if (!stream) return;
  stream.finished = true;

  // Wait for what's already scheduled to actually finish playing before going idle.
  const remainingMs = Math.max(0, (stream.nextTime - audioCtx.currentTime) * 1000);
  stream.endTimer = setTimeout(() => {
    if (pcmStream !== stream) return; // superseded by a newer turn
    pcmStream = null;
    if (pendingSleep) {
      goToSleep();
      return;
    }
    Face.setTalkLevel(0);
    Face.setState("idle");
    resumeWakeWordListening();
  }, remainingMs + 80);
}

function stopPcmStream() {
  const stream = pcmStream;
  if (!stream) return;
  pcmStream = null;
  if (stream.endTimer) clearTimeout(stream.endTimer);
  stream.sources.forEach((s) => {
    try {
      s.stop();
    } catch (_) {}
  });
  stream.sources.length = 0;
  try {
    stream.gain.disconnect();
  } catch (_) {}
}

async function playReplyAudio(arrayBuffer) {
  try {
    const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;

    // Same boost -> limiter -> makeup chain as the streaming path, with the analyser
    // tapped off the front so the talking animation still follows the voice.
    const playback = createPlaybackChain();

    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 256;
    const data = new Uint8Array(analyser.frequencyBinCount);

    let chain = source;
    if (currentPersonaId === "robbie") {
      const robotEffect = createRobotEffect(audioCtx);
      currentRobotEffectStop = robotEffect.stop;
      chain.connect(robotEffect.node);
      chain = robotEffect.node;
    }
    chain.connect(analyser);
    chain.connect(playback.input);

    Face.setState("talking");
    currentAudioSource = source;

    function pump() {
      analyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      Face.setTalkLevel(Math.min(1, avg / 130));
      talkRAF = requestAnimationFrame(pump);
    }
    pump();

    source.onended = () => {
      currentAudioSource = null;
      if (currentRobotEffectStop) {
        currentRobotEffectStop();
        currentRobotEffectStop = null;
      }
      cancelAnimationFrame(talkRAF);
      Face.setTalkLevel(0);
      Face.setState("idle");
      resumeWakeWordListening();
    };
    source.start();
  } catch (err) {
    Face.setState("idle");
    resumeWakeWordListening();
  }
}

// Wire whichever transport we're using into the single event handler above.
if (transport.kind === "direct") {
  AuraDirect.start((msg) =>
    handleTransportEvent({ data: msg instanceof ArrayBuffer ? msg : JSON.stringify(msg) })
  );
} else {
  connectSocket();
}

/**
 * Opens the WebSocket, and keeps reopening it.
 *
 * Without this a single dropped connection killed Aura for good: the page stayed up and
 * the wake word kept firing, but every recording was thrown away because the transport
 * wasn't ready, so it looked exactly like it had stopped listening. Restarting the server
 * did it, and so did the router handing the PC a new address. Neither is rare enough to
 * need a manual reload.
 */
function connectSocket() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.binaryType = "arraybuffer";
  ws.onmessage = handleTransportEvent;

  ws.onopen = () => {
    if (reconnectAttempt > 0) {
      console.log("[aura] reconnected to the brain");
      setCaption("");
    }
    reconnectAttempt = 0;
  };

  ws.onclose = () => {
    // Back off gradually, but keep trying: the server usually comes back.
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** reconnectAttempt);
    reconnectAttempt++;
    setCaption(
      reconnectAttempt > 2 ? "Can't reach the brain — still trying…" : ""
    );
    console.log("[aura] socket closed; retrying in " + delay + "ms");
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectSocket, delay);
  };
}

// Coming back to the app is a good moment to retry immediately rather than sit out the
// remaining backoff — the network has often changed while it was in the background.
document.addEventListener("visibilitychange", () => {
  if (
    document.visibilityState === "visible" &&
    transport.kind === "server" &&
    ws &&
    ws.readyState === WebSocket.CLOSED
  ) {
    clearTimeout(reconnectTimer);
    reconnectAttempt = 0;
    connectSocket();
  }
});

if ("wakeLock" in navigator) {
  navigator.wakeLock.request("screen").catch(() => {});
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState === "visible") {
      try {
        await navigator.wakeLock.request("screen");
      } catch (_) {}
    }
  });
}

// In a plain browser we must wait for a real tap before creating the recognizer: an
// AudioContext built without a user gesture can be left permanently suspended, with no
// error — just audio that silently never flows. So there, startHold() arms it.
//
// The native app is different. Audio comes from AudioBridge.kt rather than the browser's
// gesture-gated capture path, so we can arm wake-word listening immediately. Without this,
// "Hey Aura" was dead after every app launch until you happened to tap the screen — which
// looks exactly like Aura ignoring you.
if (window.__auraNativeAudioActive) {
  (async () => {
    try {
      await audioCtx.resume();
    } catch (_) {}
    await setupWakeWordListening();
    await resumeWakeWordListening();
    console.log(
      "[aura] wake word armed at startup (wakeReady=" +
        wakeReady +
        ", listening=" +
        wakeListening +
        ")"
    );
  })();
}
