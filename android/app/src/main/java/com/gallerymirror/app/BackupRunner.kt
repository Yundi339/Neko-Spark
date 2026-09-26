package com.gallerymirror.app

import android.content.Context
import android.provider.Settings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.security.MessageDigest

/** 备份流程：扫描 → 哈希 → 清单比对 → 上传 → 入库 */
class BackupRunner(private val context: Context) {

    private val prefs = context.getSharedPreferences("gallery_mirror", Context.MODE_PRIVATE)

    fun deviceId(): String {
        // 手机端可以"认领"电脑上已有的设备，避免同一台手机重复建号
        prefs.getString("bound_device_id", null)?.takeIf { it.isNotBlank() }?.let { return it }
        val androidId = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID) ?: "unknown"
        return "android-$androidId"
    }

    fun deviceName(): String {
        prefs.getString("device_name", null)?.takeIf { it.isNotBlank() }?.let { return it }
        return "${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL}".trim()
    }

    data class Result(
        val total: Int,
        val uploaded: Int,
        val skipped: Int,
        val needed: Int,
        val commit: String
    )

    suspend fun run(
        baseUrl: String,
        onLog: (String) -> Unit,
        onProgress: (current: Int, total: Int, label: String, bytesDone: Long, bytesTotal: Long) -> Unit
    ): Result = withContext(Dispatchers.IO) {
        val client = HubClient(baseUrl)

        onLog("连接电脑端：$baseUrl")
        onLog("健康检查：${withRetry(onLog, "连接电脑端") { client.health() }}")

        val deviceId = deviceId()
        val deviceName = deviceName()

        val entries = MediaScanner.scan(context)
        onLog("扫描到 ${entries.size} 个媒体文件（与手机相册数量一致）")
        if (entries.isEmpty()) return@withContext Result(0, 0, 0, 0, "没有媒体文件")

        val totalBytes = entries.sumOf { it.size }
        // 先跟电脑端打个招呼：算指纹这段时间（大库可能十几分钟）一个字节都不会传，
        // 电脑端如果不显示"正在准备"，看起来就和没连上一样
        client.syncPrepare(deviceId, deviceName, entries.size, totalBytes, 0, 0)
        onLog("计算文件指纹（首次较慢，之后会走缓存）...")
        val hashed = ArrayList<Pair<MediaEntry, String>>(entries.size)
        var hashedBytes = 0L
        var lastPing = System.currentTimeMillis()
        entries.forEachIndexed { index, entry ->
            hashed.add(entry to sha256Of(entry))
            hashedBytes += entry.size
            onProgress(index + 1, entries.size, entry.displayName, hashedBytes, totalBytes)
            // 准备进度最多每 2 秒上报一次：够电脑端看，又不至于刷爆网络和界面
            val now = System.currentTimeMillis()
            if (now - lastPing >= 2000 || index == entries.size - 1) {
                lastPing = now
                client.syncPrepare(deviceId, deviceName, entries.size, totalBytes, index + 1, hashedBytes)
            }
        }
        onLog("指纹计算完成")

        val manifest = withRetry(onLog, "上报清单") { client.manifest(deviceId, deviceName, hashed) }
        val needed = manifest.needed
        onLog("服务端已有 ${manifest.known} 个；需要上传 ${needed.size} 个")
        if (manifest.changed > 0) {
            onLog("检测到手机端变化：${manifest.changed} 个文件状态更新（新增/删除）")
        }
        if (manifest.missing > 0) {
            onLog("手机上已删除但电脑保留：${manifest.missing} 个（电脑端会标记为\"已删除\"，文件不删）")
        }

        var uploaded = 0
        var uploadedBytes = 0L
        val neededBytes = hashed.filter { it.second in needed }.sumOf { it.first.size }
        if (needed.isNotEmpty()) {
            for ((entry, sha) in hashed) {
                if (sha !in needed) continue
                onLog("上传 ${entry.displayName} (${entry.size / 1024}KB)")
                withRetry(onLog, "上传 ${entry.displayName}") {
                    client.upload(context.contentResolver, entry, sha) { bytes ->
                        uploadedBytes += bytes
                        onProgress(uploaded, needed.size, entry.displayName, uploadedBytes, neededBytes)
                    }
                }
                uploaded++
                onProgress(uploaded, needed.size, entry.displayName, uploadedBytes, neededBytes)
            }
        }

        val commit = withRetry(onLog, "提交入库") { client.commit(deviceId, deviceName, hashed) }
        onLog("入库结果：$commit")
        Result(entries.size, uploaded, entries.size - needed.size, needed.size, commit)
    }

    /** 计算 SHA-256，带缓存（同一文件不变则不重复计算） */

    /** 计算 SHA-256，带缓存（同一文件不变则不重复计算） */
    private fun sha256Of(entry: MediaEntry): String {
        val key = "sha:${entry.id}:${entry.size}:${entry.dateModified}"
        prefs.getString(key, null)?.let { return it }

        val digest = MessageDigest.getInstance("SHA-256")
        context.contentResolver.openInputStream(entry.uri)?.use { input ->
            val buffer = ByteArray(1024 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read <= 0) break
                digest.update(buffer, 0, read)
            }
        } ?: return ""
        val hex = digest.digest().joinToString("") { "%02x".format(it) }
        prefs.edit().putString(key, hex).apply()
        return hex
    }
}
