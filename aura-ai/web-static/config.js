// Static-hosting config.
//
// In the other two modes this file doesn't exist: server/app.py serves it from a route and
// the Android app intercepts the request, both generating it on the fly so the API key never
// sits in a bundled file. Serving the web app as plain files from a web host means no such
// interception, so this stands in for both — and keeps the same rule.
//
// The key is read from this browser's localStorage. It's typed in once per phone by setup.js
// and never leaves the device, so nothing you upload to the host contains a secret.
(function () {
  var key = null;
  try {
    key = localStorage.getItem("aura_api_key");
  } catch (_) {
    // Private browsing with storage disabled — setup.js explains the problem.
  }

  window.AuraConfig = {
    mode: "direct",
    apiKey: key || null,
    // Used when you ask about the weather without naming a place. You can also just tell
    // Aura where you live and it'll remember.
    defaultLocation: "",
  };
})();
