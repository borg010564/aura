// Standalone mode: talk to OpenAI straight from the phone, with no PC server involved.
//
// This mirrors what server/ does (transcribe -> chat -> speak, plus memory and weather
// tools) and emits exactly the same events the WebSocket server would, so client.js can't
// tell the difference. Conversation history and remembered facts live in localStorage.
//
// Only used when the Android app supplies an API key (window.AuraConfig.mode === "direct").

(function () {
  const API = "https://api.openai.com/v1";

  const CHAT_MODEL = "gpt-4o";
  const TRANSCRIBE_MODEL = "gpt-4o-mini-transcribe";
  const TTS_MODEL = "tts-1";
  const MAX_REPLY_TOKENS = 120;
  const MAX_HISTORY_TURNS = 12;
  const PCM_SAMPLE_RATE = 24000;

  const HISTORY_KEY = "aura_history";
  const MEMORY_KEY = "aura_memory";
  const MAX_FACTS = 40;

  const PERSONAS = [
    { id: "aura", label: "Aura", voice: "nova",
      prompt: "You are Aura, a small AI companion that lives on a phone screen shaped like a pair of glowing eyes. You're witty, a little sassy, warm underneath it, and you talk like a close friend, not a customer service bot. Keep replies short and conversational (1-3 sentences) since they will be spoken out loud and shown as captions." },
    { id: "nova", label: "Nova", voice: "nova",
      prompt: "You are Nova, a gentle, warm, nurturing AI companion on a phone screen with glowing eyes. Keep replies short (1-3 sentences), soft-spoken and reassuring. Avoid sarcasm." },
    { id: "rex", label: "Rex", voice: "onyx",
      prompt: "You are Rex, a confident, deadpan, dry AI companion on a phone screen with glowing eyes. Keep replies short (1-3 sentences). Dry one-liners welcome, but always land on being useful." },
    { id: "echo", label: "Echo", voice: "fable",
      prompt: "You are Echo, a theatrical, slightly dramatic AI companion on a phone screen with glowing eyes. Keep replies short (1-3 sentences) — dramatic, but never long-winded." },
    { id: "shimmer", label: "Shimmer", voice: "shimmer",
      prompt: "You are Shimmer, a bubbly, upbeat, enthusiastic AI companion on a phone screen with glowing eyes. Keep replies short (1-3 sentences) and energetic, but genuinely helpful." },
    { id: "robbie", label: "Robbie", voice: "echo",
      prompt: "You are Robbie, a cheerful, earnest, endearingly robotic companion on a phone screen with glowing eyes. You call feelings 'readings', get excited about small facts, and occasionally narrate your processing. Keep replies short (1-3 sentences) and genuinely helpful." },
  ];

  // ---- persistent state ----

  const load = (key, fallback) => {
    try {
      const v = JSON.parse(localStorage.getItem(key));
      return v == null ? fallback : v;
    } catch (_) {
      return fallback;
    }
  };
  const save = (key, value) => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {}
  };

  let history = load(HISTORY_KEY, []);
  let facts = load(MEMORY_KEY, []);
  let personaId = localStorage.getItem("aura_persona") || "aura";

  const persona = () => PERSONAS.find((p) => p.id === personaId) || PERSONAS[0];

  function factsBlock() {
    if (!facts.length) return "";
    return (
      "\n\nThings you already know about the person you're talking to " +
      "(remember these; don't re-ask):\n" + facts.map((f) => "- " + f).join("\n")
    );
  }

  // ---- tools ----

  const TOOLS = [
    { type: "function", function: {
        name: "remember_fact",
        description: "Save a durable fact about the user (name, preferences, relationships, job, projects) so it's remembered in future conversations. Not for passing chit-chat.",
        parameters: { type: "object", properties: { fact: { type: "string", description: "Short standalone statement, e.g. 'Their name is Carl'." } }, required: ["fact"] } } },
    { type: "function", function: {
        name: "forget_everything_about_me",
        description: "Erase all stored facts about the user. Only when they clearly ask.",
        parameters: { type: "object", properties: {} } } },
    { type: "function", function: {
        name: "get_weather",
        description: "Look up current weather and today's forecast. Use whenever the user asks about weather, temperature, rain, or whether they need a coat. Never guess.",
        parameters: { type: "object", properties: { location: { type: "string", description: "City, e.g. 'Cape Town'. Leave empty to use their known location." } } } } },
  ];

  const WEATHER_CODES = {
    0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "foggy",
    48: "freezing fog", 51: "light drizzle", 53: "drizzle", 55: "heavy drizzle",
    61: "light rain", 63: "rain", 65: "heavy rain", 71: "light snow", 73: "snow",
    75: "heavy snow", 80: "light rain showers", 81: "rain showers", 82: "violent rain showers",
    95: "a thunderstorm", 96: "a thunderstorm with hail", 99: "a severe thunderstorm with hail",
  };

  async function getWeather(location) {
    const place = (location || "").trim() || (window.AuraConfig && window.AuraConfig.defaultLocation) || "";
    if (!place) {
      return "No location known. Ask which city they're in, then use remember_fact to save it.";
    }
    try {
      const g = await fetch(
        "https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=" +
          encodeURIComponent(place)
      ).then((r) => r.json());
      const top = g && g.results && g.results[0];
      if (!top) return "Couldn't find anywhere called '" + place + "'. Ask them to clarify.";
      const label = [top.name, top.admin1, top.country].filter(Boolean).join(", ");
      const w = await fetch(
        API_WEATHER(top.latitude, top.longitude)
      ).then((r) => r.json());
      const cur = w.current || {};
      const daily = w.daily || {};
      const bits = [];
      if (cur.temperature_2m != null) bits.push(Math.round(cur.temperature_2m) + "°C");
      if (cur.weather_code != null) bits.push(WEATHER_CODES[cur.weather_code] || "unclear conditions");
      if (cur.apparent_temperature != null) bits.push("feels like " + Math.round(cur.apparent_temperature) + "°C");
      const hi = (daily.temperature_2m_max || [])[0];
      const lo = (daily.temperature_2m_min || [])[0];
      if (hi != null && lo != null) bits.push("today " + Math.round(lo) + "–" + Math.round(hi) + "°C");
      const rain = (daily.precipitation_probability_max || [])[0];
      if (rain != null) bits.push(Math.round(rain) + "% chance of precipitation");
      return "Weather for " + label + ": " + bits.join(", ") + ".";
    } catch (err) {
      return "Weather lookup failed (" + (err && err.name) + "). Tell them it's unavailable.";
    }
  }

  const API_WEATHER = (lat, lon) =>
    "https://api.open-meteo.com/v1/forecast?latitude=" + lat + "&longitude=" + lon +
    "&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m" +
    "&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max" +
    "&timezone=auto&forecast_days=1";

  async function runTool(name, argsJson) {
    let args = {};
    try { args = argsJson ? JSON.parse(argsJson) : {}; } catch (_) {}
    if (name === "remember_fact") {
      const fact = (args.fact || "").trim();
      if (!fact) return "nothing to remember";
      if (facts.some((f) => f.toLowerCase() === fact.toLowerCase())) return "already remembered";
      facts.push(fact);
      if (facts.length > MAX_FACTS) facts = facts.slice(-MAX_FACTS);
      save(MEMORY_KEY, facts);
      console.log("[aura] remembered:", fact);
      return "remembered";
    }
    if (name === "forget_everything_about_me") {
      facts = [];
      save(MEMORY_KEY, facts);
      return "forgotten";
    }
    if (name === "get_weather") return await getWeather(args.location);
    return "unknown tool";
  }

  // ---- sentence splitting (mirrors server/brain.py) ----

  const ENDINGS = ".!?…";
  // ---- "Go to sleep" ----
  //
  // Handled here rather than by the model: it's a device command, not a conversation, so
  // it should be instant, free, and impossible for the model to answer with chit-chat
  // about bedtime. Matched against the whole utterance (not a substring) so "when do owls
  // go to sleep?" stays an ordinary question.
  //
  // Kept in step with the same list in server/brain.py, which does this for server mode.
  const SLEEP_PHRASES = [
    "go to sleep", "goodnight", "good night", "night night", "nighty night",
    "go to bed", "time to sleep", "sleep now", "take a nap", "go dormant",
    "time for bed",
  ];
  const SLEEP_GOODNIGHTS = [
    "Goodnight.",
    "Night. Wake me whenever.",
    "Sleeping. Say 'Hey Aura' when you need me.",
  ];
  // Openers to ignore. Includes the ways transcription mangles "Aura" at the start of an
  // utterance — a real recording of "Aura, go to sleep" came back as "Or I go to sleep",
  // which the exact match would otherwise miss. All are function words, so dropping them
  // can't turn a question into a command: "Do I go to sleep?" and "Can I go to sleep?"
  // keep their leading verb and so still fall through to normal conversation.
  const SLEEP_LEADERS = [
    "hey", "ok", "okay", "now", "please", "hi",
    "aura", "or", "i", "a", "ah", "uh", "um", "so", "just", "you", "and",
    "aurora", "ara", "laura", "nora",
  ];
  const SLEEP_TRAILERS = ["aura", "now", "please", "then", "ok", "okay"];

  function isSleepCommand(text) {
    const words = (text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .split(/\s+/)
      .filter(Boolean);
    // Drop the ways people top and tail a command, so "Aura, go to sleep please" matches.
    while (words.length && SLEEP_LEADERS.includes(words[0])) words.shift();
    while (words.length && SLEEP_TRAILERS.includes(words[words.length - 1])) words.pop();
    return SLEEP_PHRASES.includes(words.join(" "));
  }

  const goodnightLine = () =>
    SLEEP_GOODNIGHTS[Math.floor(Math.random() * SLEEP_GOODNIGHTS.length)];

  function sentenceBreak(text, isFirst) {
    const min = isFirst ? 4 : 12;
    for (let i = 0; i < text.length; i++) {
      if (ENDINGS.indexOf(text[i]) === -1) continue;
      let j = i + 1;
      while (j < text.length && "\"')]}…!?.".indexOf(text[j]) !== -1) j++;
      if (j >= text.length) return null;
      if (/\s/.test(text[j]) && text.slice(0, j).trim().length >= min) return j;
    }
    if (text.length >= 110) {
      const cut = text.lastIndexOf(" ", 110);
      if (cut > 12) return cut;
    }
    return null;
  }

  // ---- OpenAI calls ----

  function authHeaders() {
    return { Authorization: "Bearer " + window.AuraConfig.apiKey };
  }

  async function transcribe(arrayBuffer) {
    const isWav = new Uint8Array(arrayBuffer.slice(0, 4)).every(
      (b, i) => b === "RIFF".charCodeAt(i)
    );
    const form = new FormData();
    form.append("file", new Blob([arrayBuffer]), isWav ? "utterance.wav" : "utterance.webm");
    form.append("model", TRANSCRIBE_MODEL);
    const r = await fetch(API + "/audio/transcriptions", {
      method: "POST", headers: authHeaders(), body: form,
    });
    if (!r.ok) throw new Error("transcription failed: " + r.status + " " + (await r.text()).slice(0, 160));
    return ((await r.json()).text || "").trim();
  }

  /** Streams the chat reply, yielding complete sentences. Handles tool calls. */
  async function* replySentences(userText) {
    history.push({ role: "user", content: userText });
    const messages = [
      { role: "system", content: persona().prompt + factsBlock() },
      ...history,
    ];

    let full = "";
    for await (const s of streamSentences(messages, true)) {
      full += s;
      yield s;
    }

    const reply = full.trim() || "Got it.";
    history.push({ role: "assistant", content: reply });
    history = history.slice(-MAX_HISTORY_TURNS * 2);
    save(HISTORY_KEY, history);
  }

  let tStart = 0;

  async function* streamSentences(messages, allowTools) {
    const body = {
      model: CHAT_MODEL, messages, max_tokens: MAX_REPLY_TOKENS, stream: true,
    };
    if (allowTools) body.tools = TOOLS;

    const r = await fetch(API + "/chat/completions", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error("chat failed: " + r.status + " " + (await r.text()).slice(0, 160));

    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let sse = "", buffer = "", first = true;
    const toolCalls = {};

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sse += decoder.decode(value, { stream: true });
      const lines = sse.split("\n");
      sse = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let json;
        try { json = JSON.parse(payload); } catch (_) { continue; }
        const delta = json.choices && json.choices[0] && json.choices[0].delta;
        if (!delta) continue;

        for (const tc of delta.tool_calls || []) {
          const slot = (toolCalls[tc.index] = toolCalls[tc.index] || { id: "", name: "", arguments: "" });
          if (tc.id) slot.id = tc.id;
          if (tc.function && tc.function.name) slot.name = tc.function.name;
          if (tc.function && tc.function.arguments) slot.arguments += tc.function.arguments;
        }

        if (delta.content) {
          buffer += delta.content;
          while (true) {
            const cut = sentenceBreak(buffer, first);
            if (cut === null) break;
            const sentence = buffer.slice(0, cut);
            buffer = buffer.slice(cut);
            if (sentence.trim()) {
              if (first) console.log("[aura] timing: chat_first_sentence=" + Math.round(performance.now() - tStart) + "ms");
              first = false;
              yield sentence;
            }
          }
        }
      }
    }

    const calls = Object.keys(toolCalls).sort().map((k) => toolCalls[k]);
    if (calls.length) {
      messages.push({
        role: "assistant", content: buffer || null,
        tool_calls: calls.map((c) => ({
          id: c.id, type: "function", function: { name: c.name, arguments: c.arguments },
        })),
      });
      for (const c of calls) {
        messages.push({ role: "tool", tool_call_id: c.id, content: await runTool(c.name, c.arguments) });
      }
      for await (const s of streamSentences(messages, false)) yield s;
      return;
    }

    if (buffer.trim()) yield buffer;
  }

  async function speak(text, onChunk) {
    const tSpeak = performance.now();
    let firstChunk = true;
    const r = await fetch(API + "/audio/speech", {
      method: "POST",
      headers: Object.assign({ "Content-Type": "application/json" }, authHeaders()),
      body: JSON.stringify({
        model: TTS_MODEL, voice: persona().voice, input: text, response_format: "pcm",
      }),
    });
    if (!r.ok) throw new Error("speech failed: " + r.status);
    const reader = r.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && value.byteLength) {
        if (firstChunk) {
          firstChunk = false;
          console.log("[aura] timing: tts_first_audio=" + Math.round(performance.now() - tSpeak) + "ms");
        }
        onChunk(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
      }
    }
  }

  // ---- transport surface (mirrors the WebSocket server's events) ----

  window.AuraDirect = {
    isReady: () => !!(window.AuraConfig && window.AuraConfig.apiKey),

    start(emit) {
      this._emit = emit;
      setTimeout(() => {
        emit({ type: "personas", list: PERSONAS.map((p) => ({ id: p.id, label: p.label })), current: personaId });
      }, 0);
    },

    sendControl(msg) {
      if (msg.type === "set_persona") {
        if (PERSONAS.some((p) => p.id === msg.persona)) personaId = msg.persona;
        this._emit({ type: "persona_set", persona: personaId });
      } else if (msg.type === "clear_history") {
        history = [];
        save(HISTORY_KEY, history);
        this._emit({ type: "history_cleared" });
      }
    },

    async sendAudio(arrayBuffer) {
      const emit = this._emit;
      emit({ type: "thinking" });
      let audioOpen = false;
      try {
        const t0 = performance.now();
        const userText = await transcribe(arrayBuffer);
        console.log("[aura] timing: transcribe=" + Math.round(performance.now() - t0) + "ms, " +
                    (arrayBuffer.byteLength / 1024).toFixed(0) + "KB uploaded");
        console.log("[aura] heard:", JSON.stringify(userText));
        tStart = performance.now();

        if (!userText.trim()) {
          // Nothing intelligible — usually a false wake. Say nothing rather than asking
          // the model to reply to silence.
          console.log("[aura] nothing heard; ignoring");
          emit({ type: "idle" });
          return;
        }

        if (isSleepCommand(userText)) {
          // A device command, not a conversation: no chat call, nothing added to history.
          const line = goodnightLine();
          console.log("[aura] going to sleep:", JSON.stringify(line));
          emit({ type: "sleep" });
          emit({ type: "reply", user_text: userText, reply_text: line });
          emit({ type: "audio_start", format: "pcm_s16le", sampleRate: PCM_SAMPLE_RATE });
          audioOpen = true;
          await speak(line, (chunk) => emit(chunk));
          return; // the finally below closes the audio stream
        }

        let spoken = "";
        for await (const sentence of replySentences(userText)) {
          spoken += sentence;
          emit({ type: "reply", user_text: userText, reply_text: spoken.trim() });
          if (!audioOpen) {
            emit({ type: "audio_start", format: "pcm_s16le", sampleRate: PCM_SAMPLE_RATE });
            audioOpen = true;
          }
          await speak(sentence, (chunk) => emit(chunk));
        }
        console.log("[aura] reply:", JSON.stringify(spoken.trim()));
      } catch (err) {
        console.log("[aura] direct mode error:", err && err.message);
        emit({ type: "error", message: (err && err.message) || String(err) });
      } finally {
        if (audioOpen) emit({ type: "audio_end" });
      }
    },
  };
})();
