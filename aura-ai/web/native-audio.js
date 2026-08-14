// Bridges natively-captured microphone audio into a real MediaStream.
//
// Android WebView's getUserMedia() fails with NotReadableError on the phones this runs on:
// WebView captures audio from a sandboxed renderer process, which doesn't satisfy the
// RECORD_AUDIO app-op's "foreground" requirement. The native app records from its own
// process instead (AudioBridge.kt) and pushes PCM here, where it's fed through a Web Audio
// graph into a MediaStreamDestination. The result is an ordinary MediaStream, so
// MediaRecorder (press-and-hold) and TensorFlow.js speech-commands (wake word) both keep
// working without knowing anything changed.
//
// In a normal browser AuraNative is absent and this file does nothing at all.

(function () {
  const native = window.AuraNative;
  if (!native || typeof native.isAvailable !== "function" || !native.isAvailable()) return;

  const SAMPLE_RATE = native.sampleRate();
  const MAX_BACKLOG_CHUNKS = 60; // ~5s; drop older audio rather than drift further behind

  // How long the recorder stays running after the last consumer releases it. Long enough
  // to cover a wake-word-to-recording handover; short enough that putting Aura down still
  // releases the mic promptly.
  const LINGER_MS = 3000;

  let ctx = null;
  let destination = null;
  let processor = null;
  let activeStreams = 0;
  let lingerTimer = null;

  const queue = [];
  let residual = new Float32Array(0);

  // When recording, we tap the PCM straight off the bridge rather than re-recording the
  // Web Audio graph. The graph pads with silence whenever the next chunk hasn't arrived,
  // which riddles a MediaRecorder capture with dropouts — enough to make speech
  // untranscribable ("heard: ''") even though it sounds present locally.
  let tap = null;

  window.__auraPcmSampleRate = SAMPLE_RATE;

  window.__auraStartPcmTap = function () {
    tap = [];
  };

  window.__auraStopPcmTap = function () {
    const captured = tap;
    tap = null;
    return captured;
  };

  window.__auraAudioChunk = function (b64) {
    const bin = atob(b64);
    const sampleCount = bin.length >> 1;
    const samples = new Float32Array(sampleCount);
    for (let i = 0; i < sampleCount; i++) {
      // little-endian signed 16-bit PCM -> float in [-1, 1)
      let v = (bin.charCodeAt(i * 2 + 1) << 8) | bin.charCodeAt(i * 2);
      if (v >= 0x8000) v -= 0x10000;
      samples[i] = v / 32768;
    }
    if (tap) tap.push(samples);
    queue.push(samples);
    while (queue.length > MAX_BACKLOG_CHUNKS) queue.shift();
  };

  window.__auraAudioError = function (reason) {
    console.log("[aura] native capture error:", reason);
    window.__auraNativeCaptureError = reason;
  };

  function buildGraph() {
    if (ctx) return;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    ctx = new Ctor({ sampleRate: SAMPLE_RATE });
    destination = ctx.createMediaStreamDestination();

    processor = ctx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = function (e) {
      const out = e.outputBuffer.getChannelData(0);
      let written = 0;
      while (written < out.length) {
        if (residual.length === 0) {
          if (queue.length === 0) break;
          residual = queue.shift();
        }
        const n = Math.min(out.length - written, residual.length);
        out.set(residual.subarray(0, n), written);
        residual = residual.subarray(n);
        written += n;
      }
      // pad with silence if the native side hasn't delivered yet
      for (let i = written; i < out.length; i++) out[i] = 0;
    };

    processor.connect(destination);

    // A ScriptProcessor only runs while it's connected to the context destination, but we
    // must not actually play the mic back through the speaker — hence the muted branch.
    const muted = ctx.createGain();
    muted.gain.value = 0;
    processor.connect(muted);
    muted.connect(ctx.destination);
  }

  function releaseOne() {
    activeStreams = Math.max(0, activeStreams - 1);
    if (activeStreams === 0) {
      // Don't stop the recorder the instant the last consumer lets go. Aura hands the mic
      // back and forth constantly — wake word to recording and back after every turn — and
      // a cold AudioRecord takes ~400ms to produce its first sample. Stopping immediately
      // meant paying that ramp on every handover, which swallowed the opening of whatever
      // you said. Linger instead, so a handover finds the recorder already warm.
      if (lingerTimer) clearTimeout(lingerTimer);
      lingerTimer = setTimeout(stopCaptureNow, LINGER_MS);
    }
  }

  function stopCaptureNow() {
    lingerTimer = null;
    if (activeStreams > 0) return; // someone picked it back up during the linger
    native.stopCapture();
    queue.length = 0;
    residual = new Float32Array(0);
  }

  const originalGetUserMedia =
    navigator.mediaDevices && navigator.mediaDevices.getUserMedia
      ? navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
      : null;

  async function nativeGetUserMedia(constraints) {
    if (!constraints || !constraints.audio) {
      if (originalGetUserMedia) return originalGetUserMedia(constraints);
      throw new DOMException("Only audio capture is supported here", "NotSupportedError");
    }

    buildGraph();
    if (ctx.state !== "running") await ctx.resume();

    window.__auraNativeCaptureError = null;
    if (lingerTimer) {
      // Still warm from the last consumer — keep it running rather than restarting.
      clearTimeout(lingerTimer);
      lingerTimer = null;
    } else if (activeStreams === 0) {
      native.startCapture();
    }
    activeStreams++;

    // Each caller gets its own clone so one consumer stopping doesn't kill the others.
    const stream = destination.stream.clone();
    let released = false;
    const releaseOnce = () => {
      if (released) return;
      released = true;
      releaseOne();
    };

    stream.getTracks().forEach((track) => {
      const originalStop = track.stop.bind(track);
      track.stop = function () {
        originalStop();
        releaseOnce();
      };
      track.addEventListener("ended", releaseOnce);
    });

    return stream;
  }

  if (!navigator.mediaDevices) navigator.mediaDevices = {};
  navigator.mediaDevices.getUserMedia = nativeGetUserMedia;
  window.__auraNativeAudioActive = true;
  console.log("[aura] native audio bridge active at " + SAMPLE_RATE + " Hz");
})();
