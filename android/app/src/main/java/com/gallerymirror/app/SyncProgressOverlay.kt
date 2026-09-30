package com.gallerymirror.app

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Build
import android.provider.Settings
import android.view.Gravity
import android.view.View
import android.view.WindowManager
import android.graphics.PixelFormat

/** 同步期间的可选悬浮进度窗：不接收触摸，避免挡住用户操作。 */
class SyncProgressOverlay(private val context: Context) {

    private val windowManager = context.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    private val view = ProgressView(context)
    private var attached = false

    fun show(percent: Int) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(context)) return
        view.update(percent)
        if (attached) return
        val size = (64 * context.resources.displayMetrics.density).toInt()
        val params = WindowManager.LayoutParams(
            size,
            size,
            WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
            WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE or
                WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
            PixelFormat.TRANSLUCENT
        ).apply {
            gravity = Gravity.BOTTOM or Gravity.END
            x = (12 * context.resources.displayMetrics.density).toInt()
            y = (120 * context.resources.displayMetrics.density).toInt()
        }
        try {
            windowManager.addView(view, params)
            attached = true
        } catch (_: Exception) {
            // 权限被系统撤回或 ROM 禁止覆盖层时，传输仍然正常进行。
            attached = false
        }
    }

    fun update(percent: Int) {
        view.post { view.update(percent) }
    }

    fun hide() {
        view.post {
            if (!attached) return@post
            try {
                windowManager.removeView(view)
            } catch (_: Exception) {
                // 进程退出时窗口可能已由系统移除。
            }
            attached = false
        }
    }

    private class ProgressView(context: Context) : View(context) {
        private val density = resources.displayMetrics.density
        private val ringPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeWidth = 5f * density
            strokeCap = Paint.Cap.ROUND
            color = Color.rgb(74, 159, 255)
        }
        private val trackPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.STROKE
            strokeWidth = 5f * density
            color = Color.argb(80, 255, 255, 255)
        }
        private val backgroundPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            style = Paint.Style.FILL
            color = Color.argb(235, 242, 248, 255)
        }
        private val percentPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.rgb(45, 66, 107)
            textAlign = Paint.Align.CENTER
            typeface = Typeface.DEFAULT_BOLD
            textSize = 11f * density
        }
        // adaptive icon 是 XML，BitmapFactory 在部分 Android 版本上会返回 null；前景位图跨 API 26+ 都可直接解码。
        private val icon: Bitmap? = BitmapFactory.decodeResource(resources, R.mipmap.ic_launcher_foreground)
        private var percent = -1

        fun update(value: Int) {
            percent = value.coerceIn(-1, 100)
            invalidate()
        }

        override fun onDraw(canvas: Canvas) {
            super.onDraw(canvas)
            val center = width / 2f
            val radius = center - 5f * density
            canvas.drawCircle(center, center, radius, backgroundPaint)
            val rect = RectF(center - radius, center - radius, center + radius, center + radius)
            canvas.drawArc(rect, 0f, 360f, false, trackPaint)
            val sweep = if (percent < 0) 90f else 360f * percent / 100f
            canvas.drawArc(rect, -90f, sweep, false, ringPaint)

            val bitmap = icon
            if (bitmap != null) {
                val side = radius * 1.15f
                val target = RectF(center - side / 2, center - side / 2, center + side / 2, center + side / 2)
                canvas.drawBitmap(bitmap, null, target, null)
            }
            if (percent >= 0) {
                canvas.drawText("$percent%", center, center + radius * 0.78f, percentPaint)
            }
        }
    }
}
