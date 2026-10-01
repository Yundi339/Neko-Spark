package com.gallerymirror.app

import android.content.ContentResolver
import android.net.Uri
import android.os.Build
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import org.json.JSONArray
import org.json.JSONObject
import java.io.IOException
import java.net.URI
import java.security.MessageDigest
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import javax.net.ssl.HostnameVerifier
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import java.util.concurrent.TimeUnit

/** 协议 v1 客户端：与电脑端 Hub 通信 */
class HubClient(
    baseUrl: String,
    private val accessToken: String = "",
    certificateFingerprint: String = ""
) {

    private val normalizedBaseUrl = validateBaseUrl(baseUrl)
    private val pinnedFingerprint = normalizeFingerprint(certificateFingerprint)

    private val client = buildClient()

    private val jsonType = "application/json; charset=utf-8".toMediaType()

    private fun url(path: String) = normalizedBaseUrl + path

    private fun request(path: String): Request.Builder = Request.Builder()
        .url(url(path))
        .apply {
            if (accessToken.isNotBlank()) header("X-Gallery-Mirror-Token", accessToken.trim())
        }

    private fun requestAbsolute(rawUrl: String): Request.Builder = Request.Builder()
        .url(rawUrl)
        .apply {
            if (accessToken.isNotBlank()) header("X-Gallery-Mirror-Token", accessToken.trim())
        }

    private fun buildClient(): OkHttpClient {
        if (pinnedFingerprint.length != 64) {
            throw IllegalArgumentException("请填写电脑端 HTTPS 证书 SHA-256 指纹")
        }
        val trustManager = PinnedTrustManager(pinnedFingerprint)
        val sslContext = SSLContext.getInstance("TLS")
        sslContext.init(null, arrayOf<X509TrustManager>(trustManager), SecureRandom())
        val hostnameVerifier = HostnameVerifier { _, _ -> true }
        return OkHttpClient.Builder()
            .sslSocketFactory(sslContext.socketFactory, trustManager)
            .hostnameVerifier(hostnameVerifier)
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(120, TimeUnit.SECONDS)
            .writeTimeout(120, TimeUnit.SECONDS)
            .build()
    }

    fun health(): String {
        val request = request("/api/v1/health").build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("HTTP ${response.code}")
            return response.body?.string().orEmpty()
        }
    }

    private fun deviceJson(deviceId: String, deviceName: String): JSONObject = JSONObject()
        .put("deviceId", deviceId)
        .put("name", deviceName)
        .put("model", Build.MODEL)
        .put("androidVersion", Build.VERSION.RELEASE)

    private fun itemJson(entry: MediaEntry, sha: String): JSONObject = JSONObject().apply {
        put("sha256", sha)
        put("displayName", entry.displayName)
        put("relativePath", entry.relativePath)
        put("bucketId", entry.bucketId)
        put("bucketName", entry.bucketName)
        put("mimeType", entry.mimeType)
        put("size", entry.size)
        put("width", entry.width)
        put("height", entry.height)
        put("orientation", entry.orientation)
        put("dateTaken", entry.dateTaken)
        put("dateModified", entry.dateModified)
        put("dateAdded", entry.dateAdded)
        put("isFavorite", entry.isFavorite)
        put("durationMs", entry.durationMs)
    }

    /** 清单比对结果 */
    data class ManifestResult(
        val needed: Set<String>,
        val known: Int,
        val total: Int,
        val missing: Int,
        val changed: Int
    )

    /** 上报清单，返回服务端缺失（需要上传）的 sha256 集合等信息 */
    fun manifest(deviceId: String, deviceName: String, hashed: List<Pair<MediaEntry, String>>): ManifestResult {
        val items = JSONArray()
        for ((entry, sha) in hashed) items.put(itemJson(entry, sha))
        val body = JSONObject()
            .put("protocolVersion", 1)
            .put("device", deviceJson(deviceId, deviceName))
            .put("items", items)
            .toString()
            .toRequestBody(jsonType)

        val request = request("/api/v1/manifest").post(body).build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                val detail = response.body?.string().orEmpty().take(240)
                throw IOException("manifest HTTP ${response.code}: $detail")
            }
            val json = JSONObject(response.body?.string().orEmpty())
            val neededArray = json.optJSONArray("needed") ?: JSONArray()
            val needed = HashSet<String>()
            for (i in 0 until neededArray.length()) needed.add(neededArray.getString(i))
            return ManifestResult(
                needed = needed,
                known = json.optInt("known", 0),
                total = json.optInt("total", 0),
                missing = json.optInt("missing", 0),
                changed = json.optInt("changed", 0)
            )
        }
    }

    /**
     * 上报「手机正在准备」（扫描相册 / 计算文件指纹阶段）。
     * 这个阶段可能长达十几分钟且一个字节都还没传，不打招呼的话电脑端一片空白，
     * 看起来和"没连上/卡死"一模一样。
     * 纯通知性质：失败绝不能影响备份主流程，所以异常全部吞掉。
     */
    fun syncPrepare(
        deviceId: String,
        deviceName: String,
        total: Int,
        totalBytes: Long,
        hashed: Int,
        hashedBytes: Long
    ) {
        val body = JSONObject()
            .put("protocolVersion", 1)
            .put("device", deviceJson(deviceId, deviceName))
            .put("total", total)
            .put("totalBytes", totalBytes)
            .put("hashed", hashed)
            .put("hashedBytes", hashedBytes)
            .toString()
            .toRequestBody(jsonType)
        val request = request("/api/v1/sync/prepare").post(body).build()
        runCatching { client.newCall(request).execute().use { it.body?.string() } }
    }

    fun uploadStatus(sha256: String): Long {
        val request = request("/api/v1/upload-status?sha256=$sha256").build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) return 0L
            val json = JSONObject(response.body?.string().orEmpty())
            return json.optLong("received", 0L)
        }
    }

    /** 分块上传（支持断点续传），返回是否成功 */
    fun upload(
        resolver: ContentResolver,
        entry: MediaEntry,
        sha256: String,
        onBytes: (Long) -> Unit
    ) {
        val chunkSize = 8L * 1024 * 1024
        var offset = uploadStatus(sha256)
        if (entry.size == 0L) {
            // 空文件也要落成一个已校验的 blob；直接 return 会让 commit 永远找不到它。
            val request = request("/api/v1/blob/$sha256")
                .put(RangeRequestBody(resolver, entry.uri, entry.mimeType, 0L, 0L))
                .build()
            client.newCall(request).execute().use { response ->
                val text = response.body?.string().orEmpty()
                if (!response.isSuccessful || !JSONObject(text).optBoolean("complete")) {
                    throw IOException("上传空文件失败 HTTP ${response.code}")
                }
            }
            return
        }
        if (offset >= entry.size) return
        offset = (offset / chunkSize) * chunkSize

        while (offset < entry.size) {
            val length = minOf(chunkSize, entry.size - offset)
            val requestBody = RangeRequestBody(resolver, entry.uri, entry.mimeType, offset, length)
            val request = request("/api/v1/blob/$sha256")
                .header("Content-Range", "bytes $offset-${offset + length - 1}/${entry.size}")
                .put(requestBody)
                .build()
            client.newCall(request).execute().use { response ->
                val text = response.body?.string().orEmpty()
                if (!response.isSuccessful) throw IOException("上传失败 HTTP ${response.code}: $text")
                val json = JSONObject(text)
                offset += length
                onBytes(length)
                if (json.optBoolean("complete")) return
            }
        }
    }

    fun commit(deviceId: String, deviceName: String, hashed: List<Pair<MediaEntry, String>>): String {        val items = JSONArray()
        for ((entry, sha) in hashed) items.put(itemJson(entry, sha))
        val body = JSONObject()
            .put("protocolVersion", 1)
            .put("device", deviceJson(deviceId, deviceName))
            .put("items", items)
            .toString()
            .toRequestBody(jsonType)

        val request = request("/api/v1/commit").post(body).build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                val detail = response.body?.string().orEmpty().take(240)
                throw IOException("commit HTTP ${response.code}: $detail")
            }
            return response.body?.string().orEmpty()
        }
    }

    /** 电脑端已有的设备列表（手机端用来"认领"自己是哪一台，避免重复建号） */
    data class DeviceSummary(val id: String, val name: String, val mediaCount: Int)

    fun devices(): List<DeviceSummary> {
        val request = request("/api/v1/devices").build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) return emptyList()
            val json = JSONObject(response.body?.string().orEmpty())
            val array = json.optJSONArray("devices") ?: return emptyList()
            val result = ArrayList<DeviceSummary>(array.length())
            for (i in 0 until array.length()) {
                val item = array.getJSONObject(i)
                result.add(
                    DeviceSummary(
                        id = item.optString("id"),
                        name = item.optString("name"),
                        mediaCount = item.optInt("mediaCount")
                    )
                )
            }
            return result
        }
    }

    /** 电脑端媒体条目（用于恢复回手机） */
    data class RemoteMedia(
        val id: Long,
        val displayName: String,
        val relativePath: String,
        val bucketName: String,
        val kind: String,
        val mimeType: String,
        val size: Long,
        val dateTaken: Long,
        val dateModified: Long,
        val isFavorite: Boolean,
        val sourceDeleted: Boolean
    )

    /** 拉取电脑端媒体列表（deviceId 会包含其副设备） */
    fun media(deviceId: String?): List<RemoteMedia> {
        val suffix = if (deviceId.isNullOrBlank()) "" else "?deviceId=${Uri.encode(deviceId)}"
        val request = request("/api/v1/media$suffix").build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("media HTTP ${response.code}")
            val json = JSONObject(response.body?.string().orEmpty())
            val array = json.optJSONArray("media") ?: return emptyList()
            val result = ArrayList<RemoteMedia>(array.length())
            for (i in 0 until array.length()) {
                val item = array.getJSONObject(i)
                result.add(
                    RemoteMedia(
                        id = item.optLong("id"),
                        displayName = item.optString("displayName"),
                        relativePath = item.optString("relativePath"),
                        bucketName = item.optString("bucketName"),
                        kind = if (item.optString("kind") == "video") "video" else "image",
                        mimeType = item.optString("mime"),
                        size = item.optLong("size"),
                        dateTaken = item.optLong("dateTaken", 0L),
                        dateModified = item.optLong("dateModified", 0L),
                        isFavorite = item.optBoolean("isFavorite", false),
                        sourceDeleted = item.optBoolean("sourceDeleted", false)
                    )
                )
            }
            return result
        }
    }

    /** 流式下载原始文件到输出流（恢复回手机用） */
    fun download(mediaId: Long, output: java.io.OutputStream, onBytes: (Long) -> Unit) {
        val request = request("/api/v1/file/$mediaId").build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("下载失败 HTTP ${response.code}")
            val body = response.body ?: throw IOException("响应为空")
            body.byteStream().use { input ->
                val buffer = ByteArray(256 * 1024)
                while (true) {
                    val read = input.read(buffer)
                    if (read <= 0) break
                    output.write(buffer, 0, read)
                    onBytes(read.toLong())
                }
            }
            output.flush()
        }
    }

    /** 修改电脑端上的设备显示名 */
    fun renameDevice(deviceId: String, name: String) {
        val body = JSONObject().put("deviceId", deviceId).put("name", name).toString().toRequestBody(jsonType)
        val request = request("/api/v1/device/rename").post(body).build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) throw IOException("rename HTTP ${response.code}")
        }
    }

    /** 电脑端设置里的本地贴图列表（用于让手机端和电脑端用同一套图） */
    fun stickerUrls(): List<String> {
        val request = request("/api/v1/stickers").build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) return emptyList()
            val json = JSONObject(response.body?.string().orEmpty())
            val array = json.optJSONArray("stickers") ?: return emptyList()
            val result = ArrayList<String>(array.length())
            for (i in 0 until array.length()) {
                result.add(url("/api/v1/sticker/${Uri.encode(array.getString(i))}"))
            }
            return result
        }
    }

    fun fetchBitmap(imageUrl: String): android.graphics.Bitmap? {
        val request = requestAbsolute(imageUrl).build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) return null
            return android.graphics.BitmapFactory.decodeStream(response.body?.byteStream())
        }
    }

    /** 从 ContentResolver 按区间读取上传内容 */
    private class RangeRequestBody(
        private val resolver: ContentResolver,
        private val uri: Uri,
        private val contentType: String,
        private val start: Long,
        private val length: Long
    ) : RequestBody() {

        override fun contentType() = contentType.toMediaType()

        override fun contentLength(): Long = length

        override fun writeTo(sink: BufferedSink) {
            val input = resolver.openInputStream(uri) ?: throw IOException("无法打开文件流")
            input.use { stream ->
                var skipped = 0L
                while (skipped < start) {
                    val step = stream.skip(start - skipped)
                    if (step > 0) {
                        skipped += step
                    } else {
                        // ContentResolver 的 skip() 允许返回 0，即使尚未到 EOF；不能因此从错误偏移上传。
                        if (stream.read() < 0) throw IOException("文件流短于断点偏移")
                        skipped += 1
                    }
                }
                val buffer = ByteArray(256 * 1024)
                var remaining = length
                while (remaining > 0) {
                    val read = stream.read(buffer, 0, minOf(buffer.size.toLong(), remaining).toInt())
                    if (read <= 0) throw IOException("文件流长度不足")
                    sink.write(buffer, 0, read)
                    remaining -= read
                }
            }
        }
    }

    data class PairResult(val token: String)

    /** 用桌面端设置页显示的一次性配对码换取局域网访问密钥。 */
    fun pair(code: String, deviceId: String, deviceName: String): PairResult {
        val body = JSONObject()
            .put("protocolVersion", 1)
            .put("code", code.trim())
            .put("device", deviceJson(deviceId, deviceName))
            .toString()
            .toRequestBody(jsonType)
        val request = request("/api/v1/pair").post(body).build()
        client.newCall(request).execute().use { response ->
            if (!response.isSuccessful) {
                throw IOException("配对失败 HTTP ${response.code}")
            }
            val token = JSONObject(response.body?.string().orEmpty()).optString("token").trim()
            if (token.isBlank()) throw IOException("电脑端没有返回有效的配对结果")
            return PairResult(token)
        }
    }

    companion object {
        private fun normalizeFingerprint(value: String): String =
            value.replace(Regex("[^0-9a-fA-F]"), "").uppercase()

        private class PinnedTrustManager(private val expected: String) : X509TrustManager {
            override fun checkClientTrusted(chain: Array<out X509Certificate>, authType: String) = Unit

            override fun checkServerTrusted(chain: Array<out X509Certificate>, authType: String) {
                val leaf = chain.firstOrNull() ?: throw CertificateException("电脑端没有提供证书")
                val actual = MessageDigest.getInstance("SHA-256")
                    .digest(leaf.encoded)
                    .joinToString("") { "%02X".format(it) }
                if (!MessageDigest.isEqual(actual.toByteArray(), expected.toByteArray())) {
                    throw CertificateException("电脑端 HTTPS 证书指纹不匹配")
                }
            }

            override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
        }

        private fun validateBaseUrl(raw: String): String {
            val value = raw.trim().trimEnd('/')
            val parsed = runCatching { URI(value) }.getOrNull()
                ?: throw IllegalArgumentException("电脑端地址格式不正确")
            val scheme = parsed.scheme?.lowercase()
            val host = parsed.host?.lowercase()
            if (scheme != "https" || host.isNullOrBlank() || parsed.userInfo != null) {
                throw IllegalArgumentException("电脑端地址必须是 HTTPS 地址，且不能包含账号密码")
            }
            if (!isPrivateOrLocalHost(host)) {
                throw IllegalArgumentException("电脑端地址必须是本机或局域网地址")
            }
            return value
        }

        private fun isPrivateOrLocalHost(host: String): Boolean {
            val normalized = host.trim().removePrefix("[").removeSuffix("]").lowercase()
            val withoutZone = normalized.substringBefore('%')
            if (withoutZone == "localhost" || withoutZone.endsWith(".local") || withoutZone == "::1") return true
            if (withoutZone.startsWith("fe80:") || withoutZone.startsWith("fc") || withoutZone.startsWith("fd")) return true
            val parts = withoutZone.split('.')
            if (parts.size != 4 || parts.any { it.toIntOrNull() !in 0..255 }) return false
            val first = parts[0].toInt()
            val second = parts[1].toInt()
            return first == 127 || first == 10 || (first == 192 && second == 168) ||
                (first == 172 && second in 16..31)
        }
    }
}
