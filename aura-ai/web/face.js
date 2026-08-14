// Draws Aura's face from the AURA Round Set 4 SVG asset pack (web/eyes/).
//
// The frames are 1024x1024 with transparent backgrounds and a fixed eye layout
// (left eye at x=352, right at x=672, both at y=512). Rather than swapping <img>
// elements — which flickers and can't react to audio — every frame is preloaded and
// drawn into the canvas, so we keep the amplitude-driven talking animation and
// smooth state changes.
//
// The public interface (Face.state, setState, setTalkLevel) is unchanged, so client.js
// drives this exactly as before.

const canvas = document.getElementById("face");
const ctx = canvas.getContext("2d");

let dpr = window.devicePixelRatio || 1;

function resize() {
  dpr = window.devicePixelRatio || 1;
  canvas.width = window.innerWidth * dpr;
  canvas.height = window.innerHeight * dpr;
  canvas.style.width = window.innerWidth + "px";
  canvas.style.height = window.innerHeight + "px";
}
window.addEventListener("resize", resize);
window.addEventListener("orientationchange", () => setTimeout(resize, 50));
resize();

// ---- Frame loading ----

const FRAME_NAMES = [
  "idle",
  "listening",
  "thinking",
  "happy",
  "sleep",
  "blink_01",
  "blink_02",
  "blink_03",
  "look_left",
  "look_right",
  "look_up",
  "look_down",
  "talking_01",
  "talking_02",
];

const frames = {};
let framesReady = false;
let framesFailed = false;

(function preload() {
  let remaining = FRAME_NAMES.length;
  FRAME_NAMES.forEach((name) => {
    const img = new Image();
    img.onload = () => {
      frames[name] = img;
      if (--remaining === 0) framesReady = true;
    };
    img.onerror = () => {
      console.log("[aura] failed to load eye frame:", name);
      framesFailed = true;
      if (--remaining === 0) framesReady = Object.keys(frames).length > 0;
    };
    img.src = "eyes/" + name + ".svg";
  });
})();

// ---- Layout ----

const ART_SIZE = 1024;
const EYE_DIAMETER_IN_ART = 156; // idle eye is r=78 in the source artwork
// Eye height as a fraction of screen height. Raise for bigger eyes, lower for smaller.
const EYE_HEIGHT_FRACTION = 0.34;

// Blink cadence suggested by the pack's metadata.
const BLINK_MIN_MS = 3000;
const BLINK_MAX_MS = 7000;
const BLINK_FRAME_MS = 55;
const BLINK_SEQUENCE = ["blink_01", "blink_02", "blink_03", "blink_02", "blink_01"];

// Occasional idle glances, so it doesn't feel frozen between blinks.
const GLANCE_MIN_MS = 6000;
const GLANCE_MAX_MS = 14000;
const GLANCE_HOLD_MS = 900;
const GLANCES = ["look_left", "look_right", "look_up", "look_down"];

// How long with no interaction before the eyes close.
const SLEEP_AFTER_MS = 5 * 60 * 1000;
// How long Aura stays awake after you interact, even if the camera can't see a face.
const PRESENCE_GRACE_MS = 45 * 1000;

// Eye tracking. A gaze reading older than this is stale (you've left, or detection
// stopped), so Aura goes back to its own idle glances rather than staring where you were.
const GAZE_FRESH_MS = 2500;
// How far off-centre you must be before the eyes commit to looking that way. Too small and
// they twitch constantly; too large and they never follow.
const GAZE_DEADZONE_X = 0.12;
const GAZE_DEADZONE_Y = 0.15;

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

const Face = {
  state: "idle", // idle | listening | thinking | talking

  _talkLevel: 0,
  _expression: "normal", // normal | happy — brief idle flourish
  _lastInteraction: performance.now(),

  _blinkUntil: 0,
  _blinkStartedAt: 0,
  _nextBlinkAt: performance.now() + randomBetween(BLINK_MIN_MS, BLINK_MAX_MS),

  _glanceFrame: null,
  _glanceUntil: 0,
  _nextGlanceAt: performance.now() + randomBetween(GLANCE_MIN_MS, GLANCE_MAX_MS),

  _talkFrame: 0,
  _lastTalkSwap: 0,

  // Driven by presence.js: false means nobody is in front of the camera, so Aura dozes
  // off rather than staring at an empty room. Defaults true so that a phone without a
  // camera (or with it refused) behaves exactly as before.
  _present: true,

  // Set by the "go to sleep" command. Distinct from dozing off on its own: being told to
  // sleep should stick until it's actually spoken to, so walking past the camera or a
  // stray noise can't bring it back.
  _toldToSleep: false,

  setPresence(isPresent) {
    if (isPresent === this._present) return;
    this._present = isPresent;
    if (isPresent && !this._toldToSleep) {
      this._lastInteraction = performance.now(); // wake up refreshed
    }
  },

  sleep() {
    this._toldToSleep = true;
    this._expression = "normal";
    this._glanceFrame = null;
    this._blinkUntil = 0;
    this.state = "idle";
  },

  // Where your face is, as fractions of the camera frame (0..1, already un-mirrored).
  _gazeX: 0.5,
  _gazeY: 0.5,
  _gazeAt: 0,

  setGaze(x, y) {
    this._gazeX = x;
    this._gazeY = y;
    this._gazeAt = performance.now();
  },

  setState(state) {
    // Being spoken to is the one thing that ends a commanded sleep — which covers both
    // ways of starting a turn ("Hey Aura" and press-and-hold), with nothing to remember
    // to call at either site.
    if (state === "listening") this._toldToSleep = false;
    if (state !== this.state) this._lastInteraction = performance.now();
    this.state = state;
    if (state !== "idle") {
      this._expression = "normal";
      this._glanceFrame = null;
      this._blinkUntil = 0;
    }
  },

  setTalkLevel(level) {
    this._talkLevel = level; // 0..1, driven by playing audio amplitude
  },
};

// ---- Frame selection ----

function pickFrame(now) {
  const f = Face;

  if (f.state === "listening") return "listening";
  if (f.state === "thinking") return "thinking";

  if (f.state === "talking") {
    // Alternate the two talking frames at a rate that follows how loud Aura is —
    // louder speech swaps faster, so the mouth-equivalent motion tracks the voice.
    const level = Math.min(1, Math.max(0, f._talkLevel));
    const interval = 190 - level * 120; // ~190ms when quiet, ~70ms when loud
    if (now - f._lastTalkSwap > interval) {
      f._talkFrame = f._talkFrame === 0 ? 1 : 0;
      f._lastTalkSwap = now;
    }
    return f._talkFrame === 0 ? "talking_01" : "talking_02";
  }

  // ---- idle ----
  // Asleep when nobody's been seen for a while, or after a long stretch with no
  // interaction. The grace period matters: a dark room or bad angle can hide your face
  // from the camera, and Aura shouldn't nod off seconds after you spoke to it.
  if (f._toldToSleep) return "sleep";
  const sinceInteraction = now - f._lastInteraction;
  if (sinceInteraction > SLEEP_AFTER_MS) return "sleep";
  if (!f._present && sinceInteraction > PRESENCE_GRACE_MS) return "sleep";

  if (now < f._blinkUntil) {
    const i = Math.min(
      BLINK_SEQUENCE.length - 1,
      Math.floor((now - f._blinkStartedAt) / BLINK_FRAME_MS)
    );
    return BLINK_SEQUENCE[i];
  }

  if (now >= f._nextBlinkAt) {
    f._blinkStartedAt = now;
    f._blinkUntil = now + BLINK_SEQUENCE.length * BLINK_FRAME_MS;
    f._nextBlinkAt = f._blinkUntil + randomBetween(BLINK_MIN_MS, BLINK_MAX_MS);
    // Every so often a blink resolves into a happy expression instead.
    f._expression = Math.random() < 0.25 ? "happy" : "normal";
    if (f._expression === "happy") {
      setTimeout(() => {
        if (Face.state === "idle") Face._expression = "normal";
      }, 1100);
    }
    return BLINK_SEQUENCE[0];
  }

  if (f._expression === "happy") return "happy";

  // Follow you around: if the camera has seen your face recently, look towards it. This
  // takes priority over the random idle glances, which only exist to stop Aura looking
  // frozen when it has nothing better to do.
  if (now - f._gazeAt < GAZE_FRESH_MS) {
    const dx = f._gazeX - 0.5;
    const dy = f._gazeY - 0.5;
    // Whichever axis you're further off-centre on wins, so it doesn't dither between two
    // directions when you're diagonal.
    if (Math.abs(dx) > Math.abs(dy)) {
      if (dx < -GAZE_DEADZONE_X) return "look_left";
      if (dx > GAZE_DEADZONE_X) return "look_right";
    } else {
      if (dy < -GAZE_DEADZONE_Y) return "look_up";
      if (dy > GAZE_DEADZONE_Y) return "look_down";
    }
    return "idle"; // you're roughly centred — look straight ahead
  }

  if (now < f._glanceUntil && f._glanceFrame) return f._glanceFrame;

  if (now >= f._nextGlanceAt) {
    f._glanceFrame = GLANCES[Math.floor(Math.random() * GLANCES.length)];
    f._glanceUntil = now + GLANCE_HOLD_MS;
    f._nextGlanceAt = f._glanceUntil + randomBetween(GLANCE_MIN_MS, GLANCE_MAX_MS);
    return f._glanceFrame;
  }

  return "idle";
}

// ---- Drawing ----

function drawFallback(W, H) {
  // Only used if the SVGs can't be fetched — better than a blank screen.
  const r = Math.min(W, H) * 0.09;
  ctx.fillStyle = "#19F0FF";
  [-1, 1].forEach((side) => {
    ctx.beginPath();
    ctx.arc(W / 2 + side * r * 2.05, H / 2, r, 0, Math.PI * 2);
    ctx.fill();
  });
}

function tick(now) {
  const W = window.innerWidth;
  const H = window.innerHeight;

  // Self-heal if the canvas was sized before the viewport had real dimensions (which
  // otherwise leaves it 0x0 forever, since no resize event follows).
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    resize();
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  if (!framesReady) {
    if (framesFailed) drawFallback(W, H);
    requestAnimationFrame(tick);
    return;
  }

  const name = pickFrame(now);
  const img = frames[name] || frames.idle;
  if (!img) {
    drawFallback(W, H);
    requestAnimationFrame(tick);
    return;
  }

  // Scale so the eyes are a consistent fraction of screen height regardless of device,
  // then centre the (square) artwork.
  const scale = (H * EYE_HEIGHT_FRACTION) / EYE_DIAMETER_IN_ART;
  const size = ART_SIZE * scale;
  ctx.drawImage(img, (W - size) / 2, (H - size) / 2, size, size);

  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
