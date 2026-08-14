// Presence detection: notice when someone is in front of Aura, so it wakes as you
// approach and drifts off to sleep when you leave.
//
// Runs entirely on the phone. Camera frames are analysed locally by a small face-detection
// model (TensorFlow.js BlazeFace, vendored in web/blazeface/) and are never uploaded,
// stored, or sent to any API. Only a true/false "someone is there" ever leaves this file.
//
// If the camera is unavailable or refused, everything else carries on working as normal.

(function () {
  const MODEL_URL = "blazeface/model.json";

  // Look often while someone's actually there, so the eyes can track them; drop to a lazy
  // poll when the room is empty, since nothing needs to be responsive then.
  const DETECT_INTERVAL_ACTIVE_MS = 400;
  const DETECT_INTERVAL_IDLE_MS = 1500;
  const ABSENT_AFTER_MS = 25000; // no face for this long -> treat as "gone"
  const CONFIRM_SIGHTINGS = 1; // detections needed to count as "present"

  // The front camera's image is left-right reversed relative to how you're actually
  // standing, so a face on the image's right belongs to someone on Aura's left. Flip this
  // if the eyes end up following you the wrong way.
  const MIRROR_HORIZONTAL = true;

  let video = null;
  let model = null;
  let stream = null;
  let timer = null;
  let lastSeenAt = 0;
  // null = not yet determined. Starting at false would mean the first "nobody is here"
  // never gets reported, because setPresent short-circuits on an unchanged value.
  let present = null;
  let started = false;
  let consecutiveHits = 0;
  let busy = false;
  let lastDetectAt = 0;
  let lastDetectResult = null;
  let lastGaze = null;

  function setPresent(next) {
    const changed = next !== present;
    present = next;
    if (changed) {
      console.log("[aura] presence: " + (present ? "someone is here" : "nobody around"));
    }
    // Push every cycle, not just on change. Talking to Aura also marks it awake, so if we
    // only reported transitions the camera's view and the face could drift out of sync
    // and it would never doze off again.
    // NB: face.js declares `const Face = {...}` at top level, which creates a script-scope
    // binding rather than a property on window — so `window.Face` is undefined here even
    // though `Face` resolves fine. Checking window.Face silently skipped every update.
    if (typeof Face !== "undefined" && typeof Face.setPresence === "function") {
      Face.setPresence(present);
    }
  }

  /** Turns a detected face box into a normalised position and hands it to the face. */
  function reportGaze(face) {
    if (!face || !face.topLeft || !face.bottomRight || !video.videoWidth) return;
    // blazeface gives [x, y] corners in video-pixel space.
    const cx = (face.topLeft[0] + face.bottomRight[0]) / 2 / video.videoWidth;
    const cy = (face.topLeft[1] + face.bottomRight[1]) / 2 / video.videoHeight;
    const x = MIRROR_HORIZONTAL ? 1 - cx : cx;
    lastGaze = { x: +x.toFixed(3), y: +cy.toFixed(3) };
    if (typeof Face !== "undefined" && typeof Face.setGaze === "function") {
      Face.setGaze(x, cy);
    }
  }

  async function detectOnce() {
    if (busy || !model || !video || video.readyState < 2) {
      lastDetectResult =
        "skipped(busy=" + busy + ",model=" + !!model + ",video=" + !!video +
        ",ready=" + (video ? video.readyState : "n/a") + ")";
      return;
    }
    lastDetectAt = performance.now();
    busy = true;
    try {
      const faces = await model.estimateFaces(video, false);
      const now = performance.now();
      lastDetectResult = "faces=" + (faces ? faces.length : "null");
      if (faces && faces.length > 0) {
        consecutiveHits++;
        lastSeenAt = now;
        if (consecutiveHits >= CONFIRM_SIGHTINGS) setPresent(true);
        reportGaze(faces[0]);
      } else {
        consecutiveHits = 0;
        if (now - lastSeenAt > ABSENT_AFTER_MS) setPresent(false);
      }
    } catch (err) {
      console.log("[aura] presence detect error:", err && err.message ? err.message : err);
    } finally {
      busy = false;
    }
  }

  async function start() {
    if (started) return;
    if (!window.tf || !window.blazeface) {
      console.log("[aura] presence unavailable: face model libraries not loaded");
      return;
    }
    started = true;

    try {
      // Low resolution and frame rate: we only need to know a face is there, and this
      // keeps the battery cost small.
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: "user",
          width: { ideal: 320 },
          height: { ideal: 240 },
          frameRate: { ideal: 10, max: 15 },
        },
      });
    } catch (err) {
      console.log("[aura] presence off: camera unavailable (" + err.name + ")");
      started = false;
      return;
    }

    video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    try {
      await video.play();
    } catch (err) {
      console.log("[aura] presence off: video play failed:", err && err.name);
    }

    try {
      model = await blazeface.load({ modelUrl: MODEL_URL, maxFaces: 1 });
    } catch (err) {
      console.log("[aura] presence off: model failed to load:", err && err.message);
      stopCamera();
      started = false;
      return;
    }

    lastSeenAt = performance.now();
    scheduleNextDetect();
    console.log("[aura] presence detection running");
  }

  function scheduleNextDetect() {
    if (timer) clearTimeout(timer);
    const delay = present ? DETECT_INTERVAL_ACTIVE_MS : DETECT_INTERVAL_IDLE_MS;
    timer = setTimeout(async () => {
      await detectOnce();
      if (started) scheduleNextDetect();
    }, delay);
  }

  function stopCamera() {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
    }
    if (video) {
      video.srcObject = null;
      video = null;
    }
  }

  // Release the camera while Aura is in the background, and pick it up again on return —
  // holding it open would waste battery and keep the privacy indicator lit for nothing.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      stopCamera();
      started = false;
    } else {
      start();
    }
  });

  window.__auraPresence = {
    isPresent: () => present,
    debug: () => ({
      started,
      hasModel: !!model,
      hasVideo: !!video,
      videoReadyState: video ? video.readyState : null,
      videoSize: video ? video.videoWidth + "x" + video.videoHeight : null,
      timerRunning: timer !== null,
      lastDetectAt: lastDetectAt ? Math.round(performance.now() - lastDetectAt) + "ms ago" : "never",
      lastDetectResult,
      lastGaze,
      busy,
    }),
    start,
    stop: () => {
      stopCamera();
      started = false;
    },
  };

  start();
})();
