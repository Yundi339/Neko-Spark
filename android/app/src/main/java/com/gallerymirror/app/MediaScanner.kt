package com.gallerymirror.app

import android.content.ContentUris
import android.content.Context
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore

data class MediaEntry(
    val id: Long,
    val kind: String,
    val uri: Uri,
    val displayName: String,
    val relativePath: String,
    val bucketId: String,
    val bucketName: String,
    val mimeType: String,
    val size: Long,
    val width: Int,
    val height: Int,
    val orientation: Int,
    val dateTaken: Long,
    val dateModified: Long,
    val dateAdded: Long,
    val isFavorite: Boolean,
    val durationMs: Long
)

/** 扫描系统相册（MediaStore），与手机相册里看到的数量保持一致 */
object MediaScanner {

    fun scan(context: Context): List<MediaEntry> {
        val result = ArrayList<MediaEntry>(2048)
        result += scanCollection(context, MediaStore.Images.Media.EXTERNAL_CONTENT_URI, true)
        result += scanCollection(context, MediaStore.Video.Media.EXTERNAL_CONTENT_URI, false)
        return result
    }

    private fun scanCollection(context: Context, collection: Uri, isImage: Boolean): List<MediaEntry> {
        val projection = mutableListOf(
            "_id",
            "_display_name",
            "mime_type",
            "_size",
            "date_added",
            "date_modified",
            "datetaken",
            "bucket_id",
            "bucket_display_name",
            "width",
            "height"
        )
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            projection += "relative_path"
            if (isImage) projection += "orientation"
        } else {
            projection += "_data"
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            projection += "is_favorite"
        }
        if (!isImage) {
            projection += "duration"
        }

        val entries = ArrayList<MediaEntry>()
        context.contentResolver.query(collection, projection.toTypedArray(), null, null, "datetaken DESC")?.use { cursor ->
            val idCol = cursor.getColumnIndexOrThrow("_id")
            val nameCol = cursor.getColumnIndexOrThrow("_display_name")
            val mimeCol = cursor.getColumnIndexOrThrow("mime_type")
            val sizeCol = cursor.getColumnIndexOrThrow("_size")
            val dateAddedCol = cursor.getColumnIndexOrThrow("date_added")
            val dateModifiedCol = cursor.getColumnIndexOrThrow("date_modified")
            val dateTakenCol = cursor.getColumnIndex("datetaken")
            val bucketIdCol = cursor.getColumnIndex("bucket_id")
            val bucketNameCol = cursor.getColumnIndex("bucket_display_name")
            val widthCol = cursor.getColumnIndex("width")
            val heightCol = cursor.getColumnIndex("height")
            val relativePathCol = cursor.getColumnIndex("relative_path")
            val dataCol = cursor.getColumnIndex("_data")
            val orientationCol = cursor.getColumnIndex("orientation")
            val favoriteCol = cursor.getColumnIndex("is_favorite")
            val durationCol = cursor.getColumnIndex("duration")

            while (cursor.moveToNext()) {
                val id = cursor.getLong(idCol)
                val size = if (sizeCol >= 0 && !cursor.isNull(sizeCol)) cursor.getLong(sizeCol) else 0L
                val dataPath = if (dataCol >= 0 && !cursor.isNull(dataCol)) cursor.getString(dataCol) else ""
                val rawRelative = when {
                    relativePathCol >= 0 && !cursor.isNull(relativePathCol) -> cursor.getString(relativePathCol) ?: ""
                    else -> legacyRelativePath(context, dataPath)
                }
                // Android 9 及以下只有绝对 DATA 路径；协议只允许相册相对路径，
                // 否则 Hub 会按路径穿越风险返回 400，整轮备份都会被拒绝。
                val relative = normalizeRelativePath(rawRelative)
                entries.add(
                    MediaEntry(
                        id = id,
                        kind = if (isImage) "image" else "video",
                        uri = ContentUris.withAppendedId(collection, id),
                        displayName = cursor.getString(nameCol) ?: "unknown",
                        relativePath = relative,
                        bucketId = if (bucketIdCol >= 0) (cursor.getString(bucketIdCol) ?: "") else "",
                        bucketName = if (bucketNameCol >= 0) (cursor.getString(bucketNameCol) ?: "") else "",
                        mimeType = cursor.getString(mimeCol) ?: "",
                        size = size,
                        width = if (widthCol >= 0) cursor.getInt(widthCol) else 0,
                        height = if (heightCol >= 0) cursor.getInt(heightCol) else 0,
                        orientation = if (orientationCol >= 0) cursor.getInt(orientationCol) else 0,
                        dateTaken = if (dateTakenCol >= 0 && cursor.getLong(dateTakenCol) > 0) {
                            cursor.getLong(dateTakenCol)
                        } else {
                            if (dateModifiedCol >= 0) cursor.getLong(dateModifiedCol) * 1000L else 0L
                        },
                        dateModified = if (dateModifiedCol >= 0) cursor.getLong(dateModifiedCol) * 1000L else 0L,
                        dateAdded = if (dateAddedCol >= 0) cursor.getLong(dateAddedCol) * 1000L else 0L,
                        isFavorite = favoriteCol >= 0 && cursor.getInt(favoriteCol) == 1,
                        durationMs = if (durationCol >= 0) cursor.getLong(durationCol) else 0L
                    )
                )
            }
        }
        return entries
    }

    /** 把旧版 MediaStore 的绝对路径转换为相册相对路径；无法确认根目录时安全地返回空路径。 */
    private fun legacyRelativePath(context: Context, dataPath: String): String {
        if (dataPath.isBlank()) return ""
        val normalized = dataPath.replace('\\', '/')
        val parent = normalized.substringBeforeLast('/', "")
        val roots = buildList {
            add(Environment.getExternalStorageDirectory().absolutePath.replace('\\', '/').trimEnd('/'))
            context.getExternalFilesDirs(null).forEach { file ->
                val path = file?.absolutePath?.replace('\\', '/') ?: return@forEach
                val marker = "/Android/"
                val index = path.indexOf(marker)
                if (index > 0) add(path.substring(0, index).trimEnd('/'))
            }
            add("/sdcard")
            add("/storage/emulated/0")
        }.distinct()
        val root = roots.firstOrNull { parent == it || parent.startsWith("$it/") } ?: return ""
        return parent.removePrefix(root).trim('/')
    }

    /** 只保留协议允许的相对目录，并统一为带尾斜杠的 MediaStore 形式。 */
    private fun normalizeRelativePath(raw: String): String {
        val value = raw.replace('\\', '/').trim()
        if (value.isEmpty() || value.startsWith('/') || Regex("^[A-Za-z]:").containsMatchIn(value)) return ""
        val parts = value.split('/').filter { it.isNotEmpty() }
        if (parts.any { it == "." || it == ".." || it.any { ch -> ch.code < 0x20 || ch.code == 0x7f } }) return ""
        return if (parts.isEmpty()) "" else parts.joinToString("/") + "/"
    }
}
