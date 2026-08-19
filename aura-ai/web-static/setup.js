// The key-entry screen for static hosting.
//
// direct.js needs an OpenAI key and, served as plain files, there's no server or Android
// shell to hand it one. So we ask for it once and keep it in localStorage on the phone.
// Visit with ?setup=1 to change or clear a key that's already stored.
(function () {
  var KEY = "aura_api_key";

  var stored = null;
  var storageWorks = true;
  try {
    stored = localStorage.getItem(KEY);
    localStorage.setItem("aura_storage_probe", "1");
    localStorage.removeItem("aura_storage_probe");
  } catch (_) {
    storageWorks = false;
  }

  var forced = /[?&]setup=1\b/.test(location.search);
  if (stored && !forced) return;

  // client.js has already picked its transport by now and, with no key, went looking for a
  // WebSocket that isn't there. Its retries are harmless behind the overlay, and the reload
  // below puts everything back in step once a key exists.
  function show() {
    var wrap = document.createElement("div");
    wrap.id = "aura-setup";
    wrap.innerHTML =
      '<div class="aura-setup-card">' +
      "<h1>Aura</h1>" +
      "<p>Paste an OpenAI API key to finish setup. It's stored on this phone only — it never " +
      "reaches the web server, and it isn't part of the site.</p>" +
      '<input id="aura-key" type="password" autocomplete="off" autocapitalize="off" ' +
      'autocorrect="off" spellcheck="false" placeholder="sk-..." />' +
      '<button id="aura-save">Save and start</button>' +
      '<p class="aura-setup-note">Calls are billed to this key. Revoke it any time at ' +
      "platform.openai.com.</p>" +
      (stored ? '<button id="aura-clear" class="aura-setup-link">Forget the stored key</button>' : "") +
      '<p id="aura-setup-error" class="aura-setup-error"></p>' +
      "</div>";
    document.body.appendChild(wrap);

    var input = document.getElementById("aura-key");
    var error = document.getElementById("aura-setup-error");
    input.focus();

    if (!storageWorks) {
      error.textContent =
        "This browser is blocking local storage, so the key can't be remembered. Turn off " +
        "private browsing, or allow storage for this site.";
    }

    function save() {
      var value = input.value.trim();
      if (!value) {
        error.textContent = "Paste a key first.";
        return;
      }
      // Not validation so much as catching the obvious paste mistake — a wrong-but-plausible
      // key still fails later, with OpenAI's own message.
      if (value.indexOf("sk-") !== 0) {
        error.textContent = "That doesn't look like an OpenAI key — they start with 'sk-'.";
        return;
      }
      try {
        localStorage.setItem(KEY, value);
      } catch (_) {
        error.textContent = "Couldn't save the key — local storage is blocked.";
        return;
      }
      // Reload so config.js reads the key before direct.js and client.js decide anything.
      location.replace(location.pathname);
    }

    document.getElementById("aura-save").addEventListener("click", save);
    input.addEventListener("keydown", function (e) {
      if (e.key === "Enter") save();
    });

    var clear = document.getElementById("aura-clear");
    if (clear) {
      clear.addEventListener("click", function () {
        try {
          localStorage.removeItem(KEY);
        } catch (_) {}
        location.replace(location.pathname);
      });
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", show);
  } else {
    show();
  }
})();
