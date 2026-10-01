package com.gallerymirror.app

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * 局域网搜索电脑端 Hub：mDNS 优先，UDP 广播兼容兜底；电脑端提供名称、端口和证书指纹。
 * 一个局域网里可以有多台电脑运行 Hub，搜索后由用户选择。
 */
object HubDiscovery {

    private const val DISCOVERY_PORT = 8788
    private const val REQUEST = "GALLERY_MIRROR_DISCOVER"
    private const val MDNS_SERVICE_TYPE = "_neko-spark._tcp."

    data class Found(val name: String, val host: String, val port: Int, val version: String, val fingerprint: String) {
        val url: String
            get() {
                val encodedHost = host.replace("%", "%25")
                val urlHost = if (encodedHost.contains(':') && !encodedHost.startsWith('[')) "[$encodedHost]" else encodedHost
                return "https://$urlHost:$port"
            }
    }

    fun search(context: Context, timeoutMs: Long = 3000): List<Found> {
        val results = LinkedHashMap<String, Found>()
        searchMdns(context, minOf(timeoutMs, 1800L)).forEach { results["${it.host}:${it.port}"] = it }
        searchUdp(context, timeoutMs).forEach { results["${it.host}:${it.port}"] = it }
        return results.values.toList()
    }

    /** mDNS 是首选发现方式；旧版电脑端仍由下面的 UDP 发现兜底。 */
    private fun searchMdns(context: Context, timeoutMs: Long): List<Found> {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.JELLY_BEAN) return emptyList()
        val manager = context.applicationContext.getSystemService(Context.NSD_SERVICE) as? NsdManager
            ?: return emptyList()
        val results = LinkedHashMap<String, Found>()
        val resolving = HashSet<String>()
        val latch = CountDownLatch(1)
        val mainHandler = Handler(Looper.getMainLooper())
        var multicastLock: WifiManager.MulticastLock? = null
        lateinit var listener: NsdManager.DiscoveryListener

        fun resolve(service: NsdServiceInfo) {
            val key = service.serviceName
            synchronized(resolving) {
                if (!resolving.add(key)) return
            }
            try {
                manager.resolveService(service, object : NsdManager.ResolveListener {
                    override fun onResolveFailed(serviceInfo: NsdServiceInfo, errorCode: Int) {
                        synchronized(resolving) { resolving.remove(key) }
                    }

                    override fun onServiceResolved(serviceInfo: NsdServiceInfo) {
                        val host = serviceInfo.host?.hostAddress
                        val attrs = serviceInfo.attributes
                        val fingerprint = attrs["fingerprint"]
                            ?.toString(Charsets.UTF_8)
                            ?.replace(Regex("[^0-9a-fA-F]"), "")
                            ?.uppercase()
                        if (!host.isNullOrBlank() && serviceInfo.port in 1..65535 && fingerprint?.length == 64) {
                            val name = attrs["name"]?.toString(Charsets.UTF_8)?.take(255)
                                ?.ifBlank { serviceInfo.serviceName }
                                ?: serviceInfo.serviceName
                            val version = attrs["version"]?.toString(Charsets.UTF_8)?.take(64).orEmpty()
                            synchronized(results) {
                                results["$host:${serviceInfo.port}"] = Found(
                                    name = name,
                                    host = host,
                                    port = serviceInfo.port,
                                    version = version,
                                    fingerprint = fingerprint
                                )
                            }
                        }
                        synchronized(resolving) { resolving.remove(key) }
                    }
                })
            } catch (_: Exception) {
                synchronized(resolving) { resolving.remove(key) }
            }
        }

        listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) = Unit
            override fun onServiceFound(serviceInfo: NsdServiceInfo) {
                if (serviceInfo.serviceType.trimEnd('.') == MDNS_SERVICE_TYPE.trimEnd('.')) resolve(serviceInfo)
            }
            override fun onServiceLost(serviceInfo: NsdServiceInfo) = Unit
            override fun onDiscoveryStopped(serviceType: String) { latch.countDown() }
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) { latch.countDown() }
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) { latch.countDown() }
        }

        try {
            // 部分厂商在没有 MulticastLock 时会过滤 mDNS 多播，导致 NSD 看起来永远没有服务。
            multicastLock = (context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager)
                ?.createMulticastLock("gm-mdns")
                ?.apply {
                    setReferenceCounted(false)
                    acquire()
                }
            // NSD 在部分厂商 ROM 上要求从主线程启动；发现本身仍然异步，不阻塞界面。
            mainHandler.post {
                try {
                    manager.discoverServices(MDNS_SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, listener)
                } catch (_: Exception) {
                    latch.countDown()
                }
            }
            latch.await(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (_: Exception) {
            // mDNS 失败时由 UDP 兜底，不让连接入口失效。
        } finally {
            mainHandler.post {
                try { manager.stopServiceDiscovery(listener) } catch (_: Exception) { /* 已停止 */ }
            }
            try { multicastLock?.release() } catch (_: Exception) { /* 忽略 */ }
        }
        return synchronized(results) { results.values.toList() }
    }

    private fun searchUdp(context: Context, timeoutMs: Long): List<Found> {
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
