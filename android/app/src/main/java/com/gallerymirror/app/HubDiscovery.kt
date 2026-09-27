package com.gallerymirror.app

import android.content.Context
import android.net.wifi.WifiManager
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException

/**
 * 局域网搜索电脑端 Hub：UDP 广播口令，电脑端应答自己的名称与端口。
 * 一个局域网里可以有多台电脑运行 Hub，搜索后由用户选择。
 */
object HubDiscovery {

    private const val DISCOVERY_PORT = 8788
    private const val REQUEST = "GALLERY_MIRROR_DISCOVER"

    data class Found(val name: String, val host: String, val port: Int, val version: String, val fingerprint: String) {
        val url: String get() = "https://$host:$port"
    }

    fun search(context: Context, timeoutMs: Long = 3000): List<Found> {
        val results = LinkedHashMap<String, Found>()
        var lock: WifiManager.MulticastLock? = null
        try {
            val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
            lock = wifi?.createMulticastLock("gm-discovery")?.apply {
                setReferenceCounted(false)
                acquire()
            }
        } catch (_: Exception) {
            // 没有 WiFi 权限也不影响 UDP 单播回复
        }

        try {
            DatagramSocket().use { socket ->
                socket.broadcast = true
                socket.soTimeout = 400
                val payload = REQUEST.toByteArray()
                for (target in broadcastTargets()) {
                    try {
                        socket.send(DatagramPacket(payload, payload.size, target, DISCOVERY_PORT))
                    } catch (_: Exception) {
                        // 某个网卡发不出去就跳过
                    }
                }

                val deadline = System.currentTimeMillis() + timeoutMs
                val buffer = ByteArray(4096)
                while (System.currentTimeMillis() < deadline) {
                    try {
                        val packet = DatagramPacket(buffer, buffer.size)
                        socket.receive(packet)
                        val json = JSONObject(String(packet.data, 0, packet.length).trim())
                        val port = json.optInt("port", 8787)
                        if (port !in 1..65535) continue
                        val host = packet.address?.hostAddress ?: continue
                        val fingerprint = json.optString("fingerprint", "")
                            .replace(Regex("[^0-9a-fA-F]"), "")
                            .uppercase()
                        if (fingerprint.length != 64) continue
                        results["$host:$port"] = Found(
                            name = json.optString("name", "Neko_Spark").take(255),
                            host = host,
                            port = port,
                            version = json.optString("version", "").take(64),
                            fingerprint = fingerprint
                        )
                    } catch (_: SocketTimeoutException) {
                        // 继续等待其它电脑应答
                    } catch (_: Exception) {
                        break
                    }
                }
            }
        } finally {
            try {
                lock?.release()
            } catch (_: Exception) {
                // 忽略
            }
        }
        return results.values.toList()
    }

    /** 广播地址：255.255.255.255 + 各网卡所在子网的广播地址 */
    private fun broadcastTargets(): List<InetAddress> {
        val targets = ArrayList<InetAddress>()
        try {
            targets.add(InetAddress.getByName("255.255.255.255"))
        } catch (_: Exception) {
            // 忽略
        }
        try {
            for (nif in NetworkInterface.getNetworkInterfaces()) {
                if (!nif.isUp || nif.isLoopback) continue
                for (address in nif.interfaceAddresses) {
                    if (address.address is Inet4Address && address.broadcast != null) {
                        targets.add(address.broadcast)
                    }
                }
            }
        } catch (_: Exception) {
            // 忽略
        }
        // 安卓模拟器走 NAT，广播到不了宿主机；直接补一个宿主机别名（真机不受影响）
        try {
            val isEmulator = android.os.Build.FINGERPRINT.contains("generic") ||
                android.os.Build.MODEL.contains("sdk", ignoreCase = true)
            if (isEmulator) targets.add(InetAddress.getByName("10.0.2.2"))
        } catch (_: Exception) {
            // 忽略
        }
        return targets
    }
}
