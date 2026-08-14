package com.aura.companion

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebView
import kotlin.concurrent.thread

/**
 * Captures microphone audio natively and streams it into the WebView as base64 PCM.
 *
 * Why this exists: WebView's own getUserMedia() fails with NotReadableError on the devices
 * we tested, because WebView captures audio from a sandboxed isolated renderer process,
 * which doesn't satisfy the RECORD_AUDIO app-op's "foreground" requirement. Recording from
 * the app's own process works fine, so we do that here and hand the samples to JS, where
 * native-audio.js reassembles them into a real MediaStream.
 */
class AudioBridge(private val webView: WebView) {

    /**
     * One capture run. Each worker thread watches only its *own* flag.
     *
     * A single shared "recording" boolean was not enough: stopCapture() would clear it
     * while the worker sat blocked inside AudioRecord.read(), and if startCapture() ran
     * again before the worker woke up, the flag was already back to true — so the old
     * thread kept looping and never released its AudioRecord. That leaked a live
     * microphone stream on every wake/talk cycle (20 of them were open when we checked)
     * and kept the system mic indicator lit permanently.
     */
    private class Session {
        @Volatile
        var active = true
    }

    private val lock = Any()
    private var current: Session? = null

    @JavascriptInterface
    fun isAvailable(): Boolean = true

    @JavascriptInterface
    fun sampleRate(): Int = SAMPLE_RATE

    @JavascriptInterface
    @SuppressLint("MissingPermission")
    fun startCapture() {
        val session: Session
        synchronized(lock) {
            if (current != null) return // already capturing
            session = Session()
            current = session
        }
        thread(start = true, name = "aura-audio") {
            val minBuf = AudioRecord.getMinBufferSize(SAMPLE_RATE, CHANNEL, ENCODING)
            if (minBuf <= 0) {
                finish(session, "getMinBufferSize returned $minBuf")
                return@thread
            }
            val record = try {
                AudioRecord(
                    MediaRecorder.AudioSource.VOICE_RECOGNITION,
                    SAMPLE_RATE,
                    CHANNEL,
                    ENCODING,
                    maxOf(minBuf, CHUNK_BYTES * 4),
                )
            } catch (e: Throwable) {
                finish(session, "AudioRecord constructor threw: ${e.message}")
                return@thread
            }

            if (record.state != AudioRecord.STATE_INITIALIZED) {
                record.release()
                finish(session, "AudioRecord failed to initialise")
                return@thread
            }

            try {
                record.startRecording()
            } catch (e: Throwable) {
                record.release()
                finish(session, "startRecording threw: ${e.message}")
                return@thread
            }

            Log.i(TAG, "native capture started at $SAMPLE_RATE Hz")
            val buf = ByteArray(CHUNK_BYTES)
            var error: String? = null
            // Watch this session's own flag — never a shared one, so a newly started
            // capture can't accidentally keep this thread alive.
            while (session.active) {
                val n = record.read(buf, 0, buf.size)
                if (n > 0) {
                    val b64 = Base64.encodeToString(buf.copyOf(n), Base64.NO_WRAP)
                    post("window.__auraAudioChunk && window.__auraAudioChunk('$b64')")
                } else if (n < 0) {
                    error = "AudioRecord.read error $n"
                    break
                }
            }
            try {
                record.stop()
            } catch (_: Throwable) {
            }
            record.release()
            Log.i(TAG, "native capture stopped")
            finish(session, error)
        }
    }

    /** Releases this session's claim, and reports an error to the page if there was one. */
    private fun finish(session: Session, error: String?) {
        session.active = false
        synchronized(lock) {
            if (current === session) current = null
        }
        if (error != null) {
            Log.e(TAG, "capture failed: $error")
            post("window.__auraAudioError && window.__auraAudioError('${error.replace("'", "")}')")
        }
    }

    @JavascriptInterface
    fun stopCapture() {
        synchronized(lock) {
            // Clearing `current` here (rather than waiting for the worker to notice) means
            // a fresh startCapture() can begin immediately without reviving this one.
            current?.active = false
            current = null
        }
    }

    private fun post(js: String) {
        webView.post { webView.evaluateJavascript(js, null) }
    }

    companion object {
        private const val TAG = "AuraAudio"

        // 44100 matches what TensorFlow.js speech-commands expects, so its spectrogram
        // framing lines up without resampling.
        const val SAMPLE_RATE = 44100
        private const val CHANNEL = AudioFormat.CHANNEL_IN_MONO
        private const val ENCODING = AudioFormat.ENCODING_PCM_16BIT
        private const val CHUNK_BYTES = 4096
    }
}
