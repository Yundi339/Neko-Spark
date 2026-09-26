package com.gallerymirror.app

import android.content.ContentValues
import android.content.Context
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException

/**
 * 从电脑恢复（迁移）回手机：
 * 下载原始文件 → 写入系统相册（MediaStore）→ 相册自动收录。
 *
 * 两种方式：
 * - MERGE：按电脑上的相对路径合并进手机同名文件夹（例如 DCIM/Camera/）
 * - NEW_FOLDER：所有文件放进一个新建文件夹（DCIM/Neko_Spark恢复-时间/）
 */
class RestoreRunner(private val context: Context) {

    enum class Mode { MERGE, NEW_FOLDER }

    data class Result(
        val total: Int,
        val restored: Int,
        val skipped: Int,
        val failed: Int,
        val folder: String
    )

    private val resolver get() = context.contentResolver

    suspend fun run(
        baseUrl: String,
        deviceId: String,
        mode: Mode,
        folderName: String,
        onLog: (String) -> Unit,
        onProgress: (current: Int, total: Int, label: String, bytesDone: Long, bytesTotal: Long) -> Unit
    ): Result = withContext(Dispatchers.IO) {
        val client = HubClient(baseUrl)
        // 拉列表这一下失败会让整轮恢复作废，所以断线要自动等重连。
        // 单个文件下载失败本来就只记一笔 failed 然后继续；重跑恢复时
        // "同名同大小自动跳过"会让它从断点接着来，不会重复复制。
        val remotes =
            withRetry(onLog, "读取电脑端媒体列表") { client.media(deviceId) }
        val deletedCount = remotes.count { it.sourceDeleted }
        val extra = if (deletedCount > 0) "（其中 $deletedCount 个是手机上已删除、电脑保留的备份）" else ""
        onLog("电脑端可恢复 ${remotes.size} 个文件$extra")
        if (remotes.isEmpty()) return@withContext Result(0, 0, 0, 0, "")

        val folder = if (mode == Mode.NEW_FOLDER) "DCIM/${folderNameFor(folderName)}" else ""
        onLog(
            if (folder.isEmpty()) "恢复方式：合并到手机里同名的相册文件夹"
            else "恢复方式：新建文件夹 → $folder/"
        )

        // 手机上已有的媒体（同名同大小视为已存在，自动跳过，避免重复复制）
        val existing = HashMap<String, Long>()
        MediaScanner.scan(context).forEach { entry ->
            existing[key(normalizeDir(entry.relativePath), entry.displayName)] = entry.size
        }
        onLog("手机上现有 ${existing.size} 个媒体（同名同大小的会自动跳过）")

        var settledBytes = 0L
        var receivedBytes = 0L
        val bytesTotal = remotes.sumOf { it.size }
        var restored = 0
        var skipped = 0
        var failed = 0

        for ((index, remote) in remotes.withIndex()) {
            val label = remote.displayName
            try {
                val dir = if (mode == Mode.NEW_FOLDER) "$folder/" else targetDirFor(remote)
                val finalName = pickName(dir, remote, existing)
                if (finalName == null) {
                    skipped += 1
                    onLog("跳过（手机里已有）：${remote.displayName}")
                } else {
                    receivedBytes = 0L
                    insertMedia(client, remote, dir, finalName) { delta ->
                        receivedBytes += delta
                        onProgress(
                            index + 1, remotes.size, label,
                            minOf(settledBytes + receivedBytes, bytesTotal), bytesTotal
                        )
                    }
                    existing[key(dir, finalName)] = remote.size
                    restored += 1
                    onLog("已恢复：$dir$finalName（${remote.size / 1024}KB）")
                }
            } catch (e: Exception) {
                failed += 1
                onLog("恢复失败：${remote.displayName}（${e.message}）")
            }
            // 每个文件处理完（含跳过/失败）都按整项大小结算，进度条最终能到 100%
            settledBytes += remote.size
            onProgress(
                index + 1, remotes.size, label,
                minOf(settledBytes, bytesTotal), bytesTotal
            )
        }

        onLog("恢复完成：成功 $restored，跳过 $skipped，失败 $failed")
        Result(remotes.size, restored, skipped, failed, folder)
    }

    /** 合并模式的目标路径：保持手机上的同名文件夹；不安全的顶层目录自动放进 Pictures/Movies */
    private fun targetDirFor(remote: HubClient.RemoteMedia): String {
        val path = normalizeDir(remote.relativePath)
        if (path.isEmpty()) {
            return if (remote.kind == "video") "Movies/Neko_Spark/" else "Pictures/Neko_Spark/"
        }
        val first = path.substringBefore('/').lowercase()
        val allowed = if (remote.kind == "video") VIDEO_TOP_DIRS else IMAGE_TOP_DIRS
        if (first in allowed) return "$path/"
        return if (remote.kind == "video") "Movies/$path/" else "Pictures/$path/"
    }

    /** 同名同大小 → 返回 null（跳过）；同名不同大小 → 加序号后缀避免覆盖 */
    private fun pickName(
        dir: String,
        remote: HubClient.RemoteMedia,
        existing: Map<String, Long>
    ): String? {
        val original = sanitizeName(remote.displayName)
        var candidate = original
        var counter = 0
        while (true) {
            val size = existing[key(dir, candidate)]
            if (size == null) return candidate
            if (size == remote.size) return null
            counter += 1
            if (counter > 999) throw IOException("同名文件太多")
            candidate = appendCounter(original, counter)
        }
    }

    private fun appendCounter(name: String, counter: Int): String {
        val dot = name.lastIndexOf('.')
        return if (dot > 0) {
            "${name.substring(0, dot)} ($counter)${name.substring(dot)}"
        } else {
            "$name ($counter)"
        }
    }

    /** 下载并写入系统相册 */
    private fun insertMedia(
        client: HubClient,
        remote: HubClient.RemoteMedia,
        dir: String,
        name: String,
        onBytes: (Long) -> Unit
    ) {
        val mime = remote.mimeType.ifBlank { guessMime(name) }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val collection = if (remote.kind == "video") {
                MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            } else {
                MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
            }
            val values = ContentValues().apply {
                put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                put(MediaStore.MediaColumns.MIME_TYPE, mime)
                put(MediaStore.MediaColumns.RELATIVE_PATH, dir)
                put(MediaStore.MediaColumns.IS_PENDING, 1)
            }
            val uri = resolver.insert(collection, values) ?: throw IOException("无法创建相册条目")
            try {
                resolver.openOutputStream(uri, "w")?.use { out ->
                    client.download(remote.id, out, onBytes)
                } ?: throw IOException("无法写入相册条目")

                val done = ContentValues().apply {
                    put(MediaStore.MediaColumns.IS_PENDING, 0)
                    if (remote.dateTaken > 0) put(MediaStore.MediaColumns.DATE_TAKEN, remote.dateTaken)
                    if (remote.isFavorite && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                        put(MediaStore.MediaColumns.IS_FAVORITE, 1)
                    }
                }
                resolver.update(uri, done, null, null)
                // 修改时间尽力还原（部分系统不允许改，失败不影响恢复）
                if (remote.dateModified > 0) {
                    try {
                        resolver.update(
                            uri,
                            ContentValues().apply {
                                put(MediaStore.MediaColumns.DATE_MODIFIED, remote.dateModified / 1000)
                            },
                            null,
                            null
                        )
                    } catch (_: Exception) {
                        // 忽略
                    }
                }
            } catch (e: Exception) {
                try {
                    resolver.delete(uri, null, null)
                } catch (_: Exception) {
                    // 忽略清理失败
                }
                throw e
            }
        } else {
            // Android 9 及以下：直接写文件，再通知系统相册扫描
            val file = File(Environment.getExternalStorageDirectory(), dir + name)
            file.parentFile?.mkdirs()
            file.outputStream().use { out -> client.download(remote.id, out, onBytes) }
            if (remote.dateModified > 0) file.setLastModified(remote.dateModified)
            @Suppress("DEPRECATION")
            MediaScannerConnection.scanFile(context, arrayOf(file.absolutePath), null, null)
        }
    }

    private fun normalizeDir(path: String): String {
        val segments = path.replace('\\', '/').split('/')
            .map { it.trim() }
            .filter { it.isNotEmpty() && it != "." && it != ".." }
        return segments.joinToString("/")
    }

    private fun sanitizeName(name: String): String {
        val cleaned = name.replace(Regex("[\\\\/:*?\"<>|]"), "_").trim().trim('.')
        return cleaned.ifEmpty { "未命名" }
    }

    /** 新文件夹名字：去掉不允许的字符；空白则用默认名 */
    private fun folderNameFor(raw: String): String {
        val cleaned = raw.replace(Regex("[\\\\/:*?\"<>|]"), "_").trim().trim('.')
        return cleaned.ifBlank { "Neko_Spark恢复" }
    }

    private fun key(dir: String, name: String): String =
        "${dir.trim('/').lowercase()}/${name.lowercase()}"

    private fun guessMime(name: String): String = when (name.substringAfterLast('.', "").lowercase()) {
        "jpg", "jpeg" -> "image/jpeg"
        "png" -> "image/png"
        "gif" -> "image/gif"
        "webp" -> "image/webp"
        "heic", "heif" -> "image/heic"
        "avif" -> "image/avif"
        "bmp" -> "image/bmp"
        "mp4" -> "video/mp4"
        "mov" -> "video/quicktime"
        "mkv" -> "video/x-matroska"
        "webm" -> "video/webm"
        "3gp" -> "video/3gpp"
        "avi" -> "video/x-msvideo"
        else -> "application/octet-stream"
    }

    companion object {
        private val IMAGE_TOP_DIRS = setOf("dcim", "pictures", "download", "downloads", "documents")
        private val VIDEO_TOP_DIRS = setOf("dcim", "movies", "download", "downloads", "documents")
    }
}
