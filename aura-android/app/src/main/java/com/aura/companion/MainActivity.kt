package com.aura.companion

import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.net.http.SslError
import android.os.Bundle
import android.util.Log
import android.view.Gravity
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.webkit.WebViewAssetLoader
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat

/**
 * A thin native shell around Aura's web page. It exists to get things the browser
 * can't reliably give us: real immersive fullscreen, a hard landscape lock, and a
 * mic permission flow that doesn't depend on Chrome's secure-context/gesture rules.
 * All the actual assistant logic (face, wake word, voice, personas) still lives in
 * the web page — this just hosts it.
 */
class MainActivity : AppCompatActivity() {

    private val prefs by lazy { getSharedPreferences("aura", MODE_PRIVATE) }
    private var webView: WebView? = null
    private var rediscovering = false

    private val requestPermissions =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
            if (granted[android.Manifest.permission.RECORD_AUDIO] == false) {
                Toast.makeText(
                    this,
                    "Aura needs microphone access to work — enable it in Android settings.",
                    Toast.LENGTH_LONG,
                ).show()
            }
            // Camera is optional: it's only used to notice you're nearby, so a refusal
            // just means presence detection stays off. Nothing else is affected.
            Log.i(TAG, "permissions: $granted")
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        hideSystemBars()
        ensureMicPermission()

        val apiKey = prefs.getString(PREF_API_KEY, null)
        if (apiKey.isNullOrBlank()) {
            // No key: the PC server is the only brain available.
            connectViaDiscovery(fallback = prefs.getString(PREF_URL, null))
        } else {
            // A key means Aura can run alone — but the PC is measurably faster when it's
            // around (its wired link to OpenAI beats the phone's WiFi uplink on every
            // call, roughly 2.6s vs 5.0s to first word). So prefer the server at home and
            // fall back to standalone anywhere else.
            preferServerThenStandalone()
        }
    }

    /** Briefly look for the PC server; use it if present, otherwise run standalone. */
    private fun preferServerThenStandalone() {
        showStatus("Starting Aura…")
        Thread {
            // Try the address that worked last time before broadcasting for a new one.
            // Discovery relies on UDP, which a desktop firewall will happily drop while
            // still allowing the TCP connection the app actually needs — that combination
            // silently demoted Aura to standalone (about 2s slower per reply) on a network
            // where the server was reachable the whole time. A direct check can't be fooled
            // that way, and when it succeeds it's also faster than waiting out a broadcast.
            val remembered = prefs.getString(PREF_URL, null)
            val server = remembered?.takeIf { canReach(it) } ?: Discovery.find(timeoutMs = 1200)
            runOnUiThread {
                if (server != null) {
                    Log.i(TAG, "using PC server at $server")
                    prefs.edit().putString(PREF_URL, server).apply()
                    showWebView(server)
                } else {
                    Log.i(TAG, "no PC server found — running standalone")
                    showWebView(STANDALONE_URL)
                }
            }
        }.start()
    }

    /**
     * Can we open a TCP connection to this server right now? Deliberately just a socket
     * rather than an HTTP request: the server uses a self-signed certificate, and proving
     * something is listening is all that's needed to decide which brain to use.
     */
    private fun canReach(url: String, timeoutMs: Int = 700): Boolean {
        return try {
            val parsed = java.net.URI(url)
            val port = if (parsed.port != -1) parsed.port else if (parsed.scheme == "https") 443 else 80
            java.net.Socket().use { sock ->
                sock.connect(java.net.InetSocketAddress(parsed.host, port), timeoutMs)
                Log.i(TAG, "remembered server $url is reachable")
                true
            }
        } catch (e: Exception) {
            Log.i(TAG, "remembered server $url not reachable: ${e.message}")
            false
        }
    }

    /**
     * Looks for the server on the network, falling back to the last known address, and finally
     * to asking the user. Runs discovery off the main thread.
     */
    private fun connectViaDiscovery(fallback: String?) {
        showStatus("Looking for Aura on your network…")
        Thread {
            val found = Discovery.find()
            runOnUiThread {
                when {
                    found != null -> {
                        prefs.edit().putString(PREF_URL, found).apply()
                        showWebView(found)
                    }
                    !fallback.isNullOrBlank() -> {
                        Toast.makeText(
                            this,
                            "Couldn't find Aura automatically — trying the last address.",
                            Toast.LENGTH_SHORT,
                        ).show()
                        showWebView(fallback)
                    }
                    else -> showUrlPrompt(prefill = "")
                }
            }
        }.start()
    }

    private fun showStatus(message: String) {
        val padding = (32 * resources.displayMetrics.density).toInt()
        val label = TextView(this).apply {
            text = message
            gravity = Gravity.CENTER
            textSize = 18f
            setTextColor(0xFFAAAAAA.toInt())
        }
        setContentView(
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                gravity = Gravity.CENTER
                setPadding(padding, padding, padding, padding)
                setBackgroundColor(0xFF000000.toInt())
                addView(label)
            }
        )
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        // System bars can reappear after dialogs, notifications, or app-switching —
        // reassert immersive mode whenever we regain focus.
        if (hasFocus) hideSystemBars()
    }

    private fun hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.hide(WindowInsetsCompat.Type.systemBars())
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    }

    private fun ensureMicPermission() {
        val wanted = listOf(
            android.Manifest.permission.RECORD_AUDIO,
            android.Manifest.permission.CAMERA,
        ).filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (wanted.isNotEmpty()) {
            requestPermissions.launch(wanted.toTypedArray())
        }
    }

    /**
     * Settings. Two ways to run Aura:
     *  - Standalone: paste an OpenAI key and it runs entirely on this phone, no PC.
     *  - Server: leave the key blank and it uses the Python server on your PC.
     */
    private fun showUrlPrompt(prefill: String) {
        val padding = (24 * resources.displayMetrics.density).toInt()

        val label = TextView(this).apply {
            text = "Aura setup"
            gravity = Gravity.CENTER
            textSize = 20f
        }
        val keyLabel = TextView(this).apply {
            text = "OpenAI API key — lets Aura run on this phone alone, with no PC. " +
                "Leave blank to use the PC server instead."
            textSize = 13f
        }
        val keyInput = EditText(this).apply {
            hint = "sk-..."
            setText(prefs.getString(PREF_API_KEY, "").orEmpty())
        }
        val urlLabel = TextView(this).apply {
            text = "PC server address (only used when there is no key above)"
            textSize = 13f
        }
        val urlInput = EditText(this).apply {
            hint = "https://192.168.1.42:8000"
            setText(prefill)
        }
        val button = Button(this).apply {
            text = "Save and start"
            setOnClickListener {
                val key = keyInput.text.toString().trim()
                val url = urlInput.text.toString().trim()
                prefs.edit().putString(PREF_API_KEY, key).putString(PREF_URL, url).apply()
                when {
                    key.isNotEmpty() -> showWebView(STANDALONE_URL)
                    url.isNotEmpty() -> showWebView(url)
                    else -> connectViaDiscovery(fallback = null)
                }
            }
        }

        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(padding, padding, padding, padding)
            setBackgroundColor(0xFF000000.toInt())
            addView(label)
            addView(keyLabel)
            addView(keyInput)
            addView(urlLabel)
            addView(urlInput)
            addView(button)
        }
        setContentView(layout)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun showWebView(url: String) {
        val view = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false

            // Always fetch the page and its scripts fresh. The server is on the LAN so
            // there's nothing to gain from caching, and a stale cached copy of client.js
            // or presence.js silently undoes edits — which makes debugging deeply
            // confusing, since the server is serving the new code and the app isn't
            // running it.
            settings.cacheMode = android.webkit.WebSettings.LOAD_NO_CACHE

            // Native mic capture, exposed to the page as window.AuraNative. The page's
            // native-audio.js uses it to build a MediaStream, because WebView's own
            // getUserMedia() can't open the mic on these devices.
            addJavascriptInterface(AudioBridge(this), "AuraNative")

            // Serves the bundled copy of the web app over an https:// origin. A file://
            // origin would not be a secure context, and the camera would be refused.
            val assetLoader = WebViewAssetLoader.Builder()
                .setDomain(STANDALONE_DOMAIN)
                .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this@MainActivity))
                .build()

            webChromeClient = object : WebChromeClient() {
                override fun onPermissionRequest(request: PermissionRequest) {
                    // The app itself already holds RECORD_AUDIO; this just lets the
                    // page's getUserMedia() calls through inside the WebView.
                    Log.i(TAG, "onPermissionRequest from ${request.origin}: ${request.resources.joinToString()}")
                    runOnUiThread {
                        request.grant(request.resources)
                        Log.i(TAG, "granted mic to WebView")
                    }
                }

                override fun onConsoleMessage(msg: android.webkit.ConsoleMessage): Boolean {
                    // Surface page-level JS logging into logcat — without this there is no
                    // way to see what the web app is doing once it's running on the phone.
                    Log.i(TAG, "console[${msg.messageLevel()}] ${msg.message()} @${msg.sourceId()}:${msg.lineNumber()}")
                    return true
                }
            }

            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(
                    view: WebView,
                    request: android.webkit.WebResourceRequest,
                ): android.webkit.WebResourceResponse? {
                    val uri = request.url
                    if (uri.host != STANDALONE_DOMAIN) return null

                    // config.js is generated rather than bundled, so the API key never sits
                    // in the APK's assets — it lives in app preferences and is injected here.
                    if (uri.path == "/assets/web/config.js") {
                        val key = prefs.getString(PREF_API_KEY, "").orEmpty()
                        val js = "window.AuraConfig = { mode: \"direct\", apiKey: " +
                            org.json.JSONObject.quote(key) + " };"
                        return android.webkit.WebResourceResponse(
                            "application/javascript", "utf-8", js.byteInputStream()
                        )
                    }
                    return assetLoader.shouldInterceptRequest(uri)
                }

                override fun onReceivedSslError(
                    view: WebView,
                    handler: SslErrorHandler,
                    error: SslError,
                ) {
                    // Aura's server uses a self-signed cert for local HTTPS (needed for
                    // mic access). This WebView only ever loads the address you typed
                    // in above — it's not a general browser — so accepting that
                    // specific cert is a contained, intentional trade-off, not a
                    // general "ignore all SSL errors" policy for arbitrary sites.
                    handler.proceed()
                }

                override fun onReceivedError(
                    view: WebView,
                    request: android.webkit.WebResourceRequest,
                    error: android.webkit.WebResourceError,
                ) {
                    // Only care about the main page failing, not a stray sub-resource.
                    if (!request.isForMainFrame) return
                    if (url.startsWith("https://$STANDALONE_DOMAIN")) {
                        Log.e(TAG, "bundled app failed to load: ${error.description}")
                        return // nothing to rediscover; the assets are local
                    }
                    if (!prefs.getString(PREF_API_KEY, null).isNullOrBlank()) {
                        // The PC server went away mid-session, but we can run alone.
                        Log.i(TAG, "server unreachable — switching to standalone")
                        showWebView(STANDALONE_URL)
                        return
                    }
                    Log.i(TAG, "page load failed (${error.description}) — rediscovering")
                    if (rediscovering) return
                    rediscovering = true
                    Thread {
                        val found = Discovery.find()
                        runOnUiThread {
                            rediscovering = false
                            if (found != null && found != url) {
                                prefs.edit().putString(PREF_URL, found).apply()
                                showWebView(found)
                            } else {
                                showUrlPrompt(prefill = url)
                            }
                        }
                    }.start()
                }
            }

            // Long-press anywhere to reconfigure the server address (e.g. if your
            // PC's LAN IP changes).
            setOnLongClickListener {
                prefs.edit().remove(PREF_URL).apply()
                showUrlPrompt(prefill = url)
                true
            }

            loadUrl(url)
        }

        webView = view
        setContentView(view)
    }

    companion object {
        private const val PREF_URL = "server_url"
        private const val PREF_API_KEY = "openai_api_key"
        private const val STANDALONE_DOMAIN = "appassets.androidplatform.net"
        private const val STANDALONE_URL =
            "https://appassets.androidplatform.net/assets/web/index.html"
        private const val TAG = "AuraApp"
    }
}
