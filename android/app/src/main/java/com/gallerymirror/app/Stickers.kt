package com.gallerymirror.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory

/**
 * 打包进 APK 的角色贴图。
 *
 * 构建时由 Gradle 从 <仓库根>/GalleryMirrorData/stickers 复制到 assets/stickers
 * （源目录可用环境变量 GM_STICKERS_DIR 覆盖），随 APK 一起安装到手机。
 * 源目录不存在时那个 Sync 任务**静默跳过**，APK 里就没有 assets/stickers，
 * 界面回退到内置吉祥物 R.drawable.mascot_hi —— 排查"贴图没打进 APK"时先查这个路径。
 */
object Stickers {

    fun firstBitmap(context: Context): Bitmap? {
        return try {
            val names = context.assets.list("stickers")?.sorted() ?: return null
            for (name in names) {
                context.assets.open("stickers/$name").use { stream ->
                    val bitmap = BitmapFactory.decodeStream(stream)
                    if (bitmap != null) return bitmap
                }
            }
            null
        } catch (e: Exception) {
            null
        }
    }
}
