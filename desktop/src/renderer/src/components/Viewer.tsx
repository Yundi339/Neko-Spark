import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent
} from 'react'
import { TRASH_RETENTION_DAYS, type MediaRecord } from '@shared/types'
import { fileUrl, needsRenderedPreview, previewUrl } from '../api'
import { daysLeft, formatCount, formatDateTime, formatDuration, formatSize } from '../utils/format'
import {
  formatAspect,
  formatBitrate,
  formatFrameRate,
  formatMegapixels,
  probeVideoFrameRate
} from '../utils/mediaInfo'
import { setVideoThumbPaused } from '../utils/videoThumb'

interface ViewerProps {
  items: MediaRecord[]
  index: number
  base: string
  deviceName?: string
  /** trash = 在回收站里打开：工具栏换成"恢复 / 彻底删除" */
  mode?: 'library' | 'trash'
  onClose: () => void
  onIndexChange: (index: number) => void
  onToggleFavorite: (media: MediaRecord) => void
  /** Delete 键：库里 = 移入回收站；回收站里 = 彻底删除 */
  onDelete: (media: MediaRecord) => void
  /** 回收站里打开时的"恢复" */
  onRestore?: (media: MediaRecord) => void
}

function InfoRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="info-row">
      <span className="info-label">{label}</span>
      <span className="info-value">{value}</span>
    </div>
  )
}

export default function Viewer({
  items,
  index,
  base,
  deviceName,
  mode = 'library',
  onClose,
  onIndexChange,
  onToggleFavorite,
  onDelete,
  onRestore
}: ViewerProps): JSX.Element | null {
  const media = items[index]
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const [showInfo, setShowInfo] = useState(true)
  /**
   * 这张图是不是要用 Hub 生成的大预览图（而不是原文件）。
   * Chromium 解不了 DNG / HEIC / HEIF / TIFF —— 给 `<img>` 原始字节会**静默失败**，
   * 用户看到的就是"点开什么都没有"（2026-09-24 用户实测反馈）。
   * 预览图生成失败时（404）会退回去请求原文件，尽量别什么都不显示。
   */
  const [previewFailed, setPreviewFailed] = useState(false)
  /** 视频的平均帧率：要读文件的 moov 盒子才能算（清单里没这个字段），异步取、取不到就不显示 */
  const [frameRate, setFrameRate] = useState<number | null>(null)
  const stageRef = useRef<HTMLDivElement | null>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null)
  /** 原生监听里读得到最新的缩放值 */
  const scaleRef = useRef(1)
  /** 判断"点空白退出"用：按下的位置、有没有拖动过、是不是落在画面上 */
  const clickRef = useRef<{ x: number; y: number; moved: boolean; onImage: boolean } | null>(null)

  useEffect(() => {
    scaleRef.current = scale
  }, [scale])

  useEffect(() => {
    setScale(1)
    setOffset({ x: 0, y: 0 })
    setPreviewFailed(false)
  }, [index])

  /** 这张图该请求哪个 URL：能直接显示的走原文件，Chromium 解不了的走 Hub 生成的大预览图 */
  const imageSrc =
    media && !previewFailed && needsRenderedPreview(media.mime)
      ? previewUrl(base, media.id)
      : media
        ? fileUrl(base, media.id)
        : ''

  // 预取相邻几张（纯性能优化，没有任何视觉效果）：连续翻页时点开就是立刻有画面
  useEffect(() => {
    if (!media) return
    for (const delta of [-2, -1, 1, 2]) {
      const neighbor = items[index + delta]
      if (!neighbor || neighbor.kind === 'video') continue
      const img = new Image()
      img.decoding = 'async'
      img.src = needsRenderedPreview(neighbor.mime)
        ? previewUrl(base, neighbor.id)
        : fileUrl(base, neighbor.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base, index, media?.id])

  /**
   * 当前这张"真正画出来的矩形"（在舞台坐标系里）。
   * 图片/视频是 position:absolute + inset:0 + object-fit:contain —— 元素铺满整个舞台，
   * 画面只在中间一块，两侧（或上下）是留白。要知道鼠标点的是画面还是留白，只能自己算。
   */
  const contentBox = useCallback((): { left: number; top: number; right: number; bottom: number } | null => {
    const stage = stageRef.current
    if (!stage) return null
    const width = stage.clientWidth
    const height = stage.clientHeight
    const isVideo = media?.kind === 'video'
    const natural = isVideo
      ? { w: videoRef.current?.videoWidth ?? 0, h: videoRef.current?.videoHeight ?? 0 }
      : { w: imgRef.current?.naturalWidth ?? 0, h: imgRef.current?.naturalHeight ?? 0 }
    if (!natural.w || !natural.h || !width || !height) return null
    const fit = Math.min(width / natural.w, height / natural.h)
    const current = isVideo ? 1 : scaleRef.current
    const drawnW = natural.w * fit * current
    const drawnH = natural.h * fit * current
    const centerX = width / 2 + (isVideo ? 0 : offset.x)
    const centerY = height / 2 + (isVideo ? 0 : offset.y)
    return {
      left: centerX - drawnW / 2,
      right: centerX + drawnW / 2,
      top: centerY - drawnH / 2,
      bottom: centerY + drawnH / 2
    }
  }, [media?.kind, offset.x, offset.y])

  const isOnImage = useCallback(
    (clientX: number, clientY: number): boolean => {
      const stage = stageRef.current
      const box = contentBox()
      if (!stage || !box) return true // 尺寸还没拿到：当成点在画面上，宁可不关
      const rect = stage.getBoundingClientRect()
      const x = clientX - rect.left
      const y = clientY - rect.top
      return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom
    },
    [contentBox]
  )

  // 正在放视频时别在后台抽别的视频首帧（别跟播放抢解码器）；
  // 看图片不停 —— 串行抽帧不会影响翻图片，停了反而让用户等不到缩略图
  useEffect(() => {
    setVideoThumbPaused(media?.kind === 'video')
    return () => setVideoThumbPaused(false)
  }, [media?.kind])

  // 视频帧率：读文件的 moov 算平均帧率（有缓存，同一个视频只读一次）
  useEffect(() => {
    setFrameRate(null)
    if (!media || media.kind !== 'video') return
    let cancelled = false
    void probeVideoFrameRate(base, media.id, media.size)
      .then((fps) => {
        if (!cancelled) setFrameRate(fps)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [base, media?.id, media?.kind, media?.size])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const isVideo = media?.kind === 'video'

    /**
     * 滚轮 = 缩放（上滚放大、下滚缩小），**以鼠标指向的位置为中心** —— 这是"跟手"的关键。
     *
     * ⚠️ 滚轮**只管缩放，不做任何翻页**（2026-09-24 用户明确要求）。
     * 曾经试过"缩到最小还继续下滚 = 看下一张"，用户反馈和"滚轮缩放"冲突，已去掉。
     * 视频没法缩放：滚轮直接不响应（翻页请用方向键 / 两侧箭头）。
     */
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      if (isVideo) return
      const stage = stageRef.current
      if (!stage) return
      const rect = stage.getBoundingClientRect()
      const pointerX = event.clientX - rect.left - rect.width / 2
      const pointerY = event.clientY - rect.top - rect.height / 2
      const current = scaleRef.current
      const target = Math.min(8, Math.max(1, current * (event.deltaY < 0 ? 1.15 : 0.87)))
      if (target === current) return

      if (target <= 1) {
        setScale(1)
        setOffset({ x: 0, y: 0 })
        return
      }
      // 让指针底下那个点缩放前后不动：offset' = p − (p − offset) × 缩放比
      const ratio = target / current
      setScale(target)
      setOffset((value) => ({
        x: pointerX - (pointerX - value.x) * ratio,
        y: pointerY - (pointerY - value.y) * ratio
      }))
    }

    const preventPageZoom = (event: WheelEvent): void => {
      if (event.ctrlKey) event.preventDefault()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    window.addEventListener('wheel', preventPageZoom, { passive: false })
    return () => {
      el.removeEventListener('wheel', onWheel)
      window.removeEventListener('wheel', preventPageZoom)
    }
    // 滚轮只改缩放，不再依赖当前是第几张 —— 依赖里只留"换了一张没有"
  }, [media?.id])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (!media) return
      if (event.key === 'Escape') onClose()
      else if (event.key === 'Backspace') {
        // 和浏览器一样：退格键快速退出
        event.preventDefault()
        onClose()
      } else if (event.key === 'Delete') {
        // 直接删，不弹确认（用户明确要求）；删的是当前正在看的这一张
        event.preventDefault()
        onDelete(media)
      } else if (event.key === 'ArrowLeft' && event.altKey) {
        event.preventDefault()
        onClose()
      } else if (event.key === 'ArrowLeft') onIndexChange(Math.max(0, index - 1))
      else if (event.key === 'ArrowRight') onIndexChange(Math.min(items.length - 1, index + 1))
      else if (event.key === 'i' || event.key === 'I') setShowInfo((value) => !value)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [index, items.length, media, onClose, onIndexChange, onDelete])

  // 鼠标侧键由 App 统一处理（和浏览器一致）：后退=撤回上一步，前进=前进一步

  if (!media) return null
  const isVideo = media.kind === 'video'
  const left = daysLeft(media.purgeAt)
  const inTrash = mode === 'trash'

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    clickRef.current = {
      x: event.clientX,
      y: event.clientY,
      moved: false,
      onImage: isOnImage(event.clientX, event.clientY)
    }
    if (scale <= 1) return
    dragRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.x,
      originY: offset.y
    }
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const click = clickRef.current
    if (click && !click.moved) {
      if (Math.abs(event.clientX - click.x) > 4 || Math.abs(event.clientY - click.y) > 4) {
        click.moved = true
      }
    }
    const drag = dragRef.current
    if (!drag) return
    setOffset({
      x: drag.originX + (event.clientX - drag.startX),
      y: drag.originY + (event.clientY - drag.startY)
    })
  }

  const onPointerUp = (): void => {
    dragRef.current = null
    const click = clickRef.current
    clickRef.current = null
    // 点画面以外的留白 = 退出（和浏览器看图一样）；拖动过就不算点击。
    // ⚠️ 视频不参与这条规则（2026-09-24 用户反馈"视频里点到黑边就退出了"）：
    //   ① 看视频时在画面边上点一下太容易误触，一退就把进度丢了；
    //   ② 视频自己带全屏按钮，全屏之后舞台的几何完全变了，这套"留白判定"根本不成立。
    if (click && !click.moved && !click.onImage && !isVideo) onClose()
  }

  return (
    <div className="viewer">
      <div className="viewer-top">
        <div className="viewer-title">
          <strong>{media.displayName}</strong>
          <span>
            {index + 1} / {items.length}
          </span>
        </div>
        <div className="viewer-actions">
          {inTrash ? (
            <>
              <button type="button" className="btn btn-primary" onClick={() => onRestore?.(media)}>
                恢复
              </button>
              <button type="button" className="btn" onClick={() => onDelete(media)}>
                彻底删除
              </button>
            </>
          ) : (
            <button
              type="button"
              className={`btn ${media.isFavorite ? 'btn-primary' : ''}`}
              onClick={() => onToggleFavorite(media)}
            >
              {media.isFavorite ? '已收藏' : '收藏'}
            </button>
          )}
          <button type="button" className="btn" onClick={() => setShowInfo((value) => !value)}>
            信息
          </button>
          <button type="button" className="btn" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>

      <div className="viewer-body">
        <button
          type="button"
          className="viewer-nav"
          disabled={index === 0}
          onClick={() => onIndexChange(index - 1)}
          aria-label="上一张"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m14.5 5-7 7 7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>

        <div
          className="viewer-stage"
          ref={stageRef}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onDoubleClick={(event) => {
            // 双击画面本身才是缩放；双击留白会先被"点空白退出"接走，和浏览器一致
            if (!isOnImage(event.clientX, event.clientY)) return
            setScale((value) => (value > 1 ? 1 : 2.5))
            setOffset({ x: 0, y: 0 })
          }}
        >
          {isVideo ? (
            <video
              key={media.id}
              ref={videoRef}
              src={fileUrl(base, media.id)}
              controls
              autoPlay
              className="viewer-media"
            />
          ) : (
            <img
              key={media.id}
              ref={imgRef}
              src={imageSrc}
              alt={media.displayName}
              className="viewer-media"
              draggable={false}
              // 预览图生成失败（404）就退回去请求原文件 —— 尽量别什么都不显示
              onError={() => setPreviewFailed(true)}
              style={{
                transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                cursor: scale > 1 ? 'grab' : 'default'
              }}
            />
          )}
        </div>

        <button
          type="button"
          className="viewer-nav"
          disabled={index >= items.length - 1}
          onClick={() => onIndexChange(index + 1)}
          aria-label="下一张"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m9.5 5 7 7-7 7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {showInfo ? (
        <aside className="viewer-info">
          <h3>文件信息</h3>
          <InfoRow label="文件名" value={media.displayName} />
          <InfoRow label="相册" value={media.bucketName || '-'} />
          <InfoRow label="相对路径" value={media.relativePath || '(根目录)'} />
          <InfoRow label="类型" value={isVideo ? `视频 ${media.mime}` : `图片 ${media.mime}`} />
          <InfoRow label="大小" value={formatSize(media.size)} />
          {media.width && media.height ? (
            <>
              <InfoRow label="分辨率" value={`${media.width} × ${media.height}`} />
              <InfoRow label="宽高比" value={formatAspect(media.width, media.height)} />
              <InfoRow label="像素" value={formatMegapixels(media.width, media.height)} />
            </>
          ) : null}
          {isVideo ? (
            <>
              {media.durationMs ? (
                <InfoRow label="时长" value={formatDuration(media.durationMs)} />
              ) : null}
              <InfoRow label="平均码率" value={formatBitrate(media.size, media.durationMs)} />
              {/* 帧率得读文件才算得出来（清单里没这个字段）：算不出就整行不显示，不编数字 */}
              {frameRate ? <InfoRow label="帧率" value={formatFrameRate(frameRate)} /> : null}
            </>
          ) : null}
          <InfoRow label="拍摄时间" value={formatDateTime(media.dateTaken)} />
          <InfoRow label="修改时间" value={formatDateTime(media.dateModified)} />
          <InfoRow label="加入时间" value={formatDateTime(media.dateAdded)} />
          {inTrash ? (
            <>
              <InfoRow label="移入回收站" value={formatDateTime(media.deletedAt)} />
              <InfoRow
                label="自动清理"
                value={`${formatDateTime(media.purgeAt)}（还剩 ${left ?? 0} 天 / 共 ${TRASH_RETENTION_DAYS} 天）`}
              />
            </>
          ) : (
            <InfoRow label="收藏" value={media.isFavorite ? '是' : '否'} />
          )}
          {media.sourceDeleted ? (
            <InfoRow label="状态" value="手机上已删除（电脑保留这份备份）" />
          ) : null}
          <InfoRow label="设备" value={deviceName || media.deviceId} />
          <div className="viewer-info-tip">
            提示：<strong>滚轮缩放</strong>（以鼠标位置为中心，只缩放、不翻页）· 放大后拖动 · 双击切换 ·
            方向键 / 两侧箭头切换 ·
            {/* 视频没有"点空白退出"：看视频时容易误触，而且视频全屏后这套判定不成立 */}
            {isVideo ? 'Esc / 退格 / Alt+← 退出' : <strong>点画面外的空白 / Esc / 退格 / Alt+← 退出</strong>} ·
            {inTrash ? ' Delete 彻底删除 · 右上角"恢复"放回原处' : ' Delete 移入回收站'} ·
            鼠标侧键：后退＝撤回上一步、前进＝关闭（和浏览器一致，共 {formatCount(items.length)} 项）
          </div>
        </aside>
      ) : null}
    </div>
  )
}
