package com.aura.companion

import android.util.Log
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException

/**
 * Finds Aura's server on the local network by UDP broadcast, so the app doesn't depend on a
 * hardcoded IP. Home routers reassign DHCP addresses, which otherwise meant re-typing the
 * server URL every time it changed.
 *
 * Must not be called on the main thread — it blocks.
 */
object Discovery {

    private const val TAG = "AuraDiscovery"
    private const val PORT = 41234
    private val PROBE = "AURA_DISCOVER_V1".toByteArray()

    fun find(timeoutMs: Int = 3000): String? {
        return try {
            DatagramSocket().use { sock ->
                sock.broadcast = true
                sock.soTimeout = 500

                val targets = broadcastTargets()
                val buf = ByteArray(1024)
                val deadline = System.currentTimeMillis() + timeoutMs

                while (System.currentTimeMillis() < deadline) {
                    for (target in targets) {
                        try {
                            sock.send(DatagramPacket(PROBE, PROBE.size, target, PORT))
                        } catch (_: Exception) {
                            // some interfaces reject broadcast; just try the next one
                        }
                    }
                    try {
                        val reply = DatagramPacket(buf, buf.size)
                        sock.receive(reply)
                        val url = String(reply.data, 0, reply.length).trim()
                        if (url.startsWith("http://") || url.startsWith("https://")) {
                            Log.i(TAG, "discovered server at $url")
                            return url
                        }
                    } catch (_: SocketTimeoutException) {
                        // no answer yet — loop and probe again until the deadline
                    }
                }
                Log.i(TAG, "no server answered within ${timeoutMs}ms")
                null
            }
        } catch (e: Exception) {
            Log.e(TAG, "discovery failed: ${e.message}")
            null
        }
    }

    /** The global broadcast address plus each interface's own subnet broadcast. */
    private fun broadcastTargets(): List<InetAddress> {
        val targets = mutableListOf<InetAddress>()
        try {
            targets.add(InetAddress.getByName("255.255.255.255"))
        } catch (_: Exception) {
        }
        try {
            for (iface in NetworkInterface.getNetworkInterfaces()) {
                if (!iface.isUp || iface.isLoopback) continue
                for (addr in iface.interfaceAddresses) {
                    addr.broadcast?.let { targets.add(it) }
                }
            }
        } catch (_: Exception) {
        }
        return targets.distinct()
    }
}
