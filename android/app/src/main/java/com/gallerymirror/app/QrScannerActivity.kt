package com.gallerymirror.app

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.ImageFormat
import android.hardware.Camera
import android.net.Uri
import android.os.Bundle
import android.view.Gravity
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.widget.FrameLayout
import android.widget.TextView
import androidx.core.content.ContextCompat
import com.google.zxing.BinaryBitmap
import com.google.zxing.BarcodeFormat
import com.google.zxing.DecodeHintType
import com.google.zxing.MultiFormatReader
import com.google.zxing.PlanarYUVLuminanceSource
import com.google.zxing.common.HybridBinarizer
import java.util.EnumMap
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 轻量二维码扫描页，只依赖 Android 旧 Camera API 和 ZXing core，保持 minSdk 26 可用。
 * 扫描页只把二维码文本交回主界面，不保存照片、不上传相机画面。
 */
@Suppress("DEPRECATION")
class QrScannerActivity : Activity(), SurfaceHolder.Callback, Camera.PreviewCallback {

    private lateinit var surface: SurfaceView
    private var camera: Camera? = null
    private var previewSize: Camera.Size? = null
    private val executor: ExecutorService = Executors.newSingleThreadExecutor()
    private val decoding = AtomicBoolean(false)
    private var finished = false
    @Volatile private var shuttingDown = false

    private val hints = EnumMap<DecodeHintType, Any>(DecodeHintType::class.java).apply {
        put(DecodeHintType.POSSIBLE_FORMATS, listOf(BarcodeFormat.QR_CODE))
        put(DecodeHintType.TRY_HARDER, true)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        surface = SurfaceView(this)
        root.addView(surface, FrameLayout.LayoutParams(-1, -1))
        root.addView(
            TextView(this).apply {
                text = "将电脑端二维码放入取景框\n扫描结果只用于局域网配对"
                setTextColor(Color.WHITE)
                textSize = 16f
                gravity = Gravity.CENTER
                setShadowLayer(4f, 0f, 2f, Color.BLACK)
                setPadding(24, 32, 24, 32)
            },
            FrameLayout.LayoutParams(-1, -2, Gravity.TOP)
        )
        setContentView(root)
        surface.holder.addCallback(this)
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.CAMERA), REQUEST_CAMERA)
        }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQUEST_CAMERA) return
        if (grantResults.firstOrNull() != PackageManager.PERMISSION_GRANTED) {
            setResult(RESULT_CANCELED)
            finish()
        } else if (::surface.isInitialized) {
            // 权限返回后 Surface 可能已经创建过，主动补一次启动，避免黑屏/空白页。
            surface.post { if (!finished && camera == null) startCamera(surface.holder) }
        }
    }

    override fun surfaceCreated(holder: SurfaceHolder) {
        startCamera(holder)
    }

    private fun startCamera(holder: SurfaceHolder) {
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) return
        shuttingDown = false
        try {
            val opened = Camera.open()
            camera = opened
            opened.setPreviewDisplay(holder)
            opened.setDisplayOrientation(displayOrientation())
            val params = opened.parameters
            params.previewFormat = ImageFormat.NV21
            val supportedSizes = params.supportedPreviewSizes.orEmpty()
            val selected = supportedSizes
                .filter { it.width >= 640 && it.height >= 480 }
                .minByOrNull { it.width * it.height }
                ?: supportedSizes.firstOrNull()
            if (selected != null) {
                params.setPreviewSize(selected.width, selected.height)
                previewSize = selected
            }
            // 旧 Camera API 在部分国产 ROM 上不会自动连续对焦；优先使用连续拍照，
            // 否则二维码需要用户反复点屏幕才能清晰，扫描页看起来像没有反应。
            val focusModes = params.supportedFocusModes.orEmpty()
            val focusMode = when {
                focusModes.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE) ->
                    Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE
                focusModes.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_VIDEO) ->
                    Camera.Parameters.FOCUS_MODE_CONTINUOUS_VIDEO
                focusModes.contains(Camera.Parameters.FOCUS_MODE_AUTO) -> Camera.Parameters.FOCUS_MODE_AUTO
                else -> null
            }
            if (focusMode != null) params.focusMode = focusMode
            opened.parameters = params
            val size = opened.parameters.previewSize ?: previewSize
            if (size != null) {
                previewSize = size
                // NV21 4:2:0 需要约 1.5 倍宽高的回调缓冲区；准备两个，避免部分 ROM 复用首帧时崩溃。
                val bufferSize = size.width * size.height * 3 / 2 + 1
                repeat(2) { opened.addCallbackBuffer(ByteArray(bufferSize)) }
                opened.setPreviewCallbackWithBuffer(this)
            }
            opened.startPreview()
        } catch (_: Exception) {
            releaseCamera()
            setResult(RESULT_CANCELED)
            finish()
        }
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        releaseCamera()
    }

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) = Unit

    override fun onPreviewFrame(data: ByteArray?, source: Camera?) {
        val size = previewSize ?: return
        val frame = data ?: return
        if (finished || shuttingDown) return
        if (!decoding.compareAndSet(false, true)) {
            requeue(source, frame)
            return
        }
        try {
            executor.execute {
                val text = runCatching { decode(frame, size.width, size.height) }.getOrNull()
                decoding.set(false)
                if (text != null && !finished) {
                    runOnUiThread { finishWith(text) }
                } else {
                    requeue(source, frame)
                }
            }
        } catch (_: Exception) {
            decoding.set(false)
            requeue(source, frame)
        }
    }

    private fun requeue(source: Camera?, frame: ByteArray) {
        if (finished || shuttingDown) return
        runCatching { source?.addCallbackBuffer(frame) }
    }

    private fun decode(bytes: ByteArray, width: Int, height: Int): String? {
        val source = PlanarYUVLuminanceSource(bytes, width, height, 0, 0, width, height, false)
        val rotated90 = source.rotateCounterClockwise()
        val variants = listOf(
            source,
            rotated90,
            rotated90.rotateCounterClockwise(),
            rotated90.rotateCounterClockwise().rotateCounterClockwise()
        )
        for (variant in variants) {
            try {
                return MultiFormatReader().run { setHints(hints); decodeWithState(BinaryBitmap(HybridBinarizer(variant))).text }
            } catch (_: Exception) {
                // 取景框还没对准时继续等下一帧。
            }
        }
        return null
    }

    private fun finishWith(value: String) {
        if (finished) return
        finished = true
        setResult(RESULT_OK, Intent().setData(Uri.parse(value.trim())))
        finish()
    }

    private fun releaseCamera() {
        shuttingDown = true
        val current = camera
        camera = null
        if (current != null) {
            runCatching { current.setPreviewCallbackWithBuffer(null) }
            runCatching { current.stopPreview() }
            runCatching { current.release() }
        }
    }

    override fun onPause() {
        releaseCamera()
        super.onPause()
    }

    override fun onDestroy() {
        releaseCamera()
        executor.shutdownNow()
        super.onDestroy()
    }

    private fun displayOrientation(): Int {
        val info = Camera.CameraInfo().also { Camera.getCameraInfo(Camera.CameraInfo.CAMERA_FACING_BACK, it) }
        val rotation = when (windowManager.defaultDisplay.rotation) {
            android.view.Surface.ROTATION_90 -> 90
            android.view.Surface.ROTATION_180 -> 180
            android.view.Surface.ROTATION_270 -> 270
            else -> 0
        }
        return (info.orientation - rotation + 360) % 360
    }

    companion object {
        const val REQUEST_CAMERA = 1007
    }
}
