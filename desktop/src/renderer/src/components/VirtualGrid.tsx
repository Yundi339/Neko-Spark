import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type JSX,
  type MouseEvent as ReactMouseEvent
} from 'react'
import type { MediaRecord } from '@shared/types'
import { thumbUrl } from '../api'
import { daysLeft } from '../utils/format'
import { requestVideoThumb } from '../utils/videoThumb'
import {
  clearSelection,
  selectRange,
  selectionHas,
  selectionList,
  setSelection,
  toggleSelection,
  useSelectionVersion
} from '../hooks/useSelection'
import MediaTile from './MediaTile'

export interface GridRow {
  key: string
  height: number
  items?: MediaRecord[]
  title?: string
  count?: number
  /** 该图片行所属的日期（滚动时在滚动条左侧显示） */
  dateLabel?: string
}

interface VirtualGridProps {
  rows: GridRow[]
  columns: number
  base: string
  onOpen: (media: MediaRecord) => void
  overscan?: number
  headerClassName?: string
  /** trash = 回收站视图：右上角显示"剩 N 天"倒计时 */
  variant?: 'library' | 'trash'
}

/** 框选时鼠标离视口上下边多远开始自动滚动、每帧最多滚多少像素 */
const MARQUEE_EDGE = 46
const MARQUEE_MAX_STEP = 26
/** 位移超过这个距离才算"拖动"，否则当成一次点击 */
const MARQUEE_THRESHOLD = 4

export default function VirtualGrid({
  rows,
  columns,
  base,
  onOpen,
  overscan = 2,
  headerClassName = '',
  variant = 'library'
}: VirtualGridProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const marqueeRef = useRef<HTMLDivElement | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewport, setViewport] = useState(600)
  const [contentHeight, setContentHeight] = useState(0)
  const [scrollDate, setScrollDate] = useState('')
  // 订阅选中集合：变化时触发重渲染，只影响视口内的这些格子（虚拟滚动，量很小）
  useSelectionVersion()

  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const onScroll = (): void => setScrollTop(el.scrollTop)
    const measure = (): void => {
      setViewport(el.clientHeight)
      setContentHeight(el.scrollHeight)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    measure()
    return () => {
      el.removeEventListener('scroll', onScroll)
      observer.disconnect()
    }
  }, [])

  // 行内容变化（切筛选、图片加载完）会改变可滚动高度，重新量一次
  useEffect(() => {
    const el = containerRef.current
    if (el) setContentHeight(el.scrollHeight)
  }, [rows])

  const { offsets, totalHeight } = useMemo(() => {
    const result = new Array<number>(rows.length)
    let sum = 0
    for (let i = 0; i < rows.length; i += 1) {
      result[i] = sum
      sum += rows[i].height
    }
    return { offsets: result, totalHeight: sum }
  }, [rows])

  const firstVisible = useMemo(() => {
    if (rows.length === 0) return 0
    let lo = 0
    let hi = rows.length - 1
    let answer = 0
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (offsets[mid] + rows[mid].height > scrollTop) {
        answer = mid
        hi = mid - 1
      } else {
        lo = mid + 1
      }
    }
    return answer
  }, [offsets, rows, scrollTop])

  const lastVisible = useMemo(() => {
    if (rows.length === 0) return 0
    let index = firstVisible
    while (index < rows.length && offsets[index] < scrollTop + viewport) index += 1
    return Math.min(rows.length - 1, index)
  }, [firstVisible, offsets, rows.length, scrollTop, viewport])

  const start = Math.max(0, firstVisible - overscan)
  const end = Math.min(rows.length - 1, lastVisible + overscan)

  /** 网格顺序的 id 列表（Shift 范围选要按屏幕顺序来）+ 按 id 找回记录 */
  const orderedIds = useMemo(
    () => rows.flatMap((row) => row.items?.map((item) => item.id) ?? []),
    [rows]
  )
  const itemById = useMemo(() => {
    const map = new Map<number, MediaRecord>()
    for (const row of rows) {
      for (const item of row.items ?? []) map.set(item.id, item)
    }
    return map
  }, [rows])

  /**
   * 预取：把视口上下各约两屏的缩略图提前拉进浏览器缓存。
   * 缩略图才 2~3KB，多拉这点代价极低；换来的是快速滑动时图片已经在缓存里，
   * 不会一格一格等加载。从 lastVisible 向两侧扩展，不遍历整个列表。
   */
  const prefetchItems = useMemo(() => {
    const budget = viewport * 2
    const out: MediaRecord[] = []
    let used = 0
    for (let i = firstVisible - 1; i >= 0 && used < budget; i -= 1) {
      used += rows[i].height
      const items = rows[i].items
      if (items) out.push(...items)
    }
    used = 0
    for (let i = lastVisible + 1; i < rows.length && used < budget; i += 1) {
      used += rows[i].height
      const items = rows[i].items
      if (items) out.push(...items)
    }
    return out
  }, [firstVisible, lastVisible, rows, viewport])

  /**
   * 视频首帧：**只给当前真正渲染出来的视频格子**排队抽帧（限流逻辑在 utils/videoThumb 里，
   * 一次只跑一个）。滚动到哪儿抽到哪儿，不会一上来把整个库的视频全解码一遍。
   *
   * ⚠️ 条件是"只要还没有首帧就试"（`!== 'ready'`），**不能只认 `none`**：
   * 用户库里 368 个视频的 thumb_state 是 `failed` —— 那是 2026-09-24 闪退 bug 留下的旧标记
   * （当年视频被送进 sharp 解码失败），只认 none 的话这些视频永远不会被抽帧。
   * 每个视频每会话只试一次（attempted 集合），真解不了的不会反复重试。
   */
  useEffect(() => {
    if (!base) return
    for (const row of rows.slice(start, end + 1)) {
      for (const item of row.items ?? []) {
        if (item.kind === 'video' && item.thumbState !== 'ready') requestVideoThumb(item.id, base)
      }
    }
  }, [base, rows, start, end])

  const prefetched = useRef(new Set<string>())
  useEffect(() => {
    if (prefetchItems.length === 0) return
    if (prefetched.current.size > 8000) prefetched.current.clear()
    for (const item of prefetchItems) {
      // 视频没有缩略图（格子显示的是播放标记），预取它只会白白请求一次 404 ——
      // 更糟的是服务端会拿这个 id 去解码视频文件（实测能把 sharp 搞崩）
      if (item.kind !== 'image') continue
      const url = thumbUrl(base, item.id)
      if (prefetched.current.has(url)) continue
      prefetched.current.add(url)
      const img = new Image()
      img.decoding = 'async'
      img.src = url
    }
  }, [base, prefetchItems])

  /** 点空白 = 取消选中；点格子 = 打开（带修饰键时改为加选/范围选） */
  const suppressClick = useRef(false)
  const onGridClick = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (suppressClick.current) {
        suppressClick.current = false
        return
      }
      const tile = (event.target as HTMLElement).closest<HTMLElement>('.tile[data-id]')
      if (!tile) {
        if (selectionList().length > 0) clearSelection()
        return
      }
      const id = Number(tile.dataset.id)
      if (!Number.isFinite(id)) return
      if (event.ctrlKey || event.metaKey) {
        toggleSelection(id)
        return
      }
      if (event.shiftKey) {
        selectRange(orderedIds, id)
        return
      }
      // 打开的那张自动算选中：这样 Delete 永远有明确目标（和查看器里删的是同一张）
      setSelection([id], id)
      const media = itemById.get(id)
      if (media) onOpen(media)
    },
    [itemById, onOpen, orderedIds]
  )

  /** 拖出到资源管理器：选中了就拖一整批，没选中就只拖这一张（和资源管理器一致） */
  const onGridDragStart = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    const tile = (event.target as HTMLElement).closest<HTMLElement>('.tile[data-id]')
    if (!tile) return
    // ⚠️ 必须先 preventDefault：Electron 里不这么做，startDrag 会把渲染进程一起卡死
    event.preventDefault()
    const id = Number(tile.dataset.id)
    if (!Number.isFinite(id)) return
    const current = selectionList()
    const ids = current.includes(id) ? current : [id]
    if (!current.includes(id)) setSelection([id], id)
    // 主进程负责把它落成带扩展名的真实文件再交给系统（只复制，不移动）
    window.gm.startDrag(ids)
  }, [])

  // ---------- 框选（橡皮筋）----------

  const marquee = useRef<{
    startX: number
    startY: number
    base: Set<number>
    moved: boolean
    pointerX: number
    pointerY: number
    frame: number | null
  } | null>(null)

  const drawMarquee = useCallback(
    (left: number, top: number, width: number, height: number): void => {
      const el = marqueeRef.current
      if (!el) return
      el.style.display = 'block'
      el.style.left = `${left}px`
      el.style.top = `${top}px`
      el.style.width = `${width}px`
      el.style.height = `${height}px`
    },
    []
  )

  const endMarquee = useCallback(() => {
    const state = marquee.current
    if (!state) return
    if (state.frame !== null) cancelAnimationFrame(state.frame)
    marquee.current = null
    if (marqueeRef.current) marqueeRef.current.style.display = 'none'
    if (state.moved) {
      // 拖完紧接着会来一次 click，别让它把刚框选的结果清掉
      suppressClick.current = true
      window.setTimeout(() => {
        suppressClick.current = false
      }, 0)
    }
  }, [])

  const onGridMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      if (event.button !== 0) return
      const target = event.target as HTMLElement
      // 落在图片/按钮上：交给点击与拖出逻辑，不要当成框选起点
      if (target.closest('.tile[data-id]')) return
      if (target.closest('button, input, select, textarea, a')) return
      const wrap = wrapRef.current
      const scroller = containerRef.current
      if (!wrap || !scroller) return

      const wrapRect = wrap.getBoundingClientRect()
      marquee.current = {
        startX: event.clientX - wrapRect.left,
        startY: event.clientY - wrapRect.top,
        base: event.ctrlKey || event.metaKey ? new Set(selectionList()) : new Set<number>(),
        moved: false,
        pointerX: event.clientX,
        pointerY: event.clientY,
        frame: null
      }
      event.preventDefault() // 免得拖出文字选区

      /**
       * 按"最新指针位置 + 当前滚动位置"重算一次框选（矩形、命中集合、自动滚动）。
       * 每帧调一次（rAF），鼠标一动也立刻调一次 —— 不把跟手性完全押在 rAF 上：
       * 窗口被遮挡 / 最小化时 Chromium 根本不产帧，rAF 永远不触发（实测坑）。
       */
      const update = (): void => {
        const state = marquee.current
        const wrapEl = wrapRef.current
        const scrollEl = containerRef.current
        if (!state || !wrapEl || !scrollEl) return

        // 1) 真的在框选了、且指针贴近上下边缘时才自动滚动（资源管理器的手感）。
        //    要求 moved：否则在底部空白处点一下都会让列表自己滚起来。
        const rect = wrapEl.getBoundingClientRect()
        let delta = 0
        if (state.moved && state.pointerY < rect.top + MARQUEE_EDGE) {
          delta = -Math.ceil(((rect.top + MARQUEE_EDGE - state.pointerY) / MARQUEE_EDGE) * MARQUEE_MAX_STEP)
        } else if (state.moved && state.pointerY > rect.bottom - MARQUEE_EDGE) {
          delta = Math.ceil(((state.pointerY - (rect.bottom - MARQUEE_EDGE)) / MARQUEE_EDGE) * MARQUEE_MAX_STEP)
        }
        if (delta !== 0) {
          scrollEl.scrollTop += delta
        }

        // 2) 先读 DOM 尺寸（读在写之前，避免每帧强制重排）
        const left = Math.min(state.startX, state.pointerX - rect.left)
        const top = Math.min(state.startY, state.pointerY - rect.top)
        const right = Math.max(state.startX, state.pointerX - rect.left)
        const bottom = Math.max(state.startY, state.pointerY - rect.top)
        if (!state.moved && (right - left > MARQUEE_THRESHOLD || bottom - top > MARQUEE_THRESHOLD)) {
          state.moved = true
        }

        const hitLeft = rect.left + left
        const hitTop = rect.top + top
        const hitRight = rect.left + right
        const hitBottom = rect.top + bottom
        const hits = new Set<number>(state.base)
        if (state.moved) {
          const inner = scrollEl.firstElementChild
          if (inner) {
            for (const rowEl of inner.querySelectorAll<HTMLElement>('.vgrid-row[data-row]')) {
              for (const tile of rowEl.querySelectorAll<HTMLElement>('.tile[data-id]')) {
                const box = tile.getBoundingClientRect()
                if (
                  box.right > hitLeft &&
                  box.left < hitRight &&
                  box.bottom > hitTop &&
                  box.top < hitBottom
                ) {
                  hits.add(Number(tile.dataset.id))
                }
              }
            }
          }
        }

        // 3) 再写样式（矩形框 + 选中集合）
        drawMarquee(left, top, right - left, bottom - top)
        if (state.moved) setSelection(hits, null)
      }
      const step = (): void => {
        if (!marquee.current) return
        marquee.current.frame = requestAnimationFrame(step)
        update()
      }
      marquee.current.frame = requestAnimationFrame(step)

      const onMove = (moveEvent: MouseEvent): void => {
        if (marquee.current) {
          marquee.current.pointerX = moveEvent.clientX
          marquee.current.pointerY = moveEvent.clientY
          update() // 鼠标一动就立刻更新（不依赖 rAF）
        }
      }
      const onUp = (): void => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        window.removeEventListener('blur', onUp)
        endMarquee()
      }
      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
      window.addEventListener('blur', onUp)
    },
    [drawMarquee, endMarquee]
  )

  // 组件卸载时别把 rAF / 监听留在外面
  useEffect(() => endMarquee, [endMarquee])

  /**
   * 滚动条滑块（thumb）中点在轨道里的纵向位置。
   * 浏览器不暴露原生滚动条的几何信息，只能按标准公式反推（与 Chromium 的实现近似）：
   *   滑块长度 = 轨道长 × 视口 / 内容长（且有最小长度，超长列表的滑块也不会小到看不见）
   *   滑块顶端 = 滚动进度 × (轨道长 − 滑块长度)
   */
  const thumbCenter = useMemo(() => {
    const trackHeight = viewport
    const maxScroll = contentHeight - trackHeight
    if (maxScroll <= 0) return null // 内容不足一屏，没有滚动条
    const thumbHeight = Math.min(
      trackHeight,
      Math.max(24, (trackHeight * trackHeight) / Math.max(contentHeight, 1))
    )
    return (scrollTop / maxScroll) * (trackHeight - thumbHeight) + thumbHeight / 2
  }, [contentHeight, scrollTop, viewport])

  /** 滑块中点这条横线落在哪一行上（二分查找，行的高度不等） */
  const midRowIndex = useMemo(() => {
    if (thumbCenter === null || rows.length === 0) return -1
    const lineY = scrollTop + thumbCenter
    let lo = 0
    let hi = rows.length - 1
    let answer = rows.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (offsets[mid] + rows[mid].height > lineY) {
        answer = mid
        hi = mid - 1
      } else {
        lo = mid + 1
      }
    }
    return answer
  }, [offsets, rows, scrollTop, thumbCenter])

  /** 那一行最左边图片所属的日期（行的 dateLabel 即该行所属的那一天） */
  const visibleLabel = useMemo(() => {
    if (midRowIndex < 0) return ''
    const labelAt = (i: number): string => rows[i].dateLabel ?? rows[i].title ?? ''
    const here = labelAt(midRowIndex)
    if (here) return here
    // 落点正好是日期标题行（没有图片）时，就近找一张图
    for (let i = midRowIndex + 1; i < rows.length; i += 1) {
      const label = labelAt(i)
      if (label) return label
    }
    for (let i = midRowIndex - 1; i >= 0; i -= 1) {
      const label = labelAt(i)
      if (label) return label
    }
    return ''
  }, [midRowIndex, rows])

  useEffect(() => {
    if (!visibleLabel) return
    setScrollDate(visibleLabel)
  }, [visibleLabel])

  // 停止滚动 1.5 秒后隐去（每次滚动都重新计时，不然同一天内连续滚动会中途消失）
  useEffect(() => {
    if (!visibleLabel) return
    const timer = window.setTimeout(() => setScrollDate(''), 1500)
    return () => window.clearTimeout(timer)
  }, [scrollTop, visibleLabel])

  const body =
    rows.length === 0 ? (
      <div className="empty-hint">这里还没有内容</div>
    ) : (
      <div className="vgrid-inner" style={{ height: totalHeight }}>
        {rows.slice(start, end + 1).map((row, offset) => {
          const index = start + offset
          return (
            <div
              key={row.key}
              className="vgrid-row"
              data-row={index}
              style={{ top: offsets[index], height: row.height }}
            >
              {row.items ? (
                <div
                  className="vgrid-cells"
                  style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
                >
                  {row.items.map((media) => (
                    <MediaTile
                      key={media.id}
                      media={media}
                      base={base}
                      selected={selectionHas(media.id)}
                      expireDays={variant === 'trash' ? daysLeft(media.purgeAt) : undefined}
                    />
                  ))}
                  {Array.from({ length: Math.max(0, columns - row.items.length) }).map((_, i) => (
                    <div key={`empty-${i}`} className="tile tile-empty" />
                  ))}
                </div>
              ) : (
                <div className={`row-header ${headerClassName}`}>
                  <strong>{row.title}</strong>
                  <span>{row.count} 项</span>
                </div>
              )}
            </div>
          )
        })}
      </div>
    )

  return (
    <div className="vgrid-wrap" ref={wrapRef}>
      <div
        className="vgrid"
        ref={containerRef}
        onClick={onGridClick}
        onMouseDown={onGridMouseDown}
        onDragStart={onGridDragStart}
      >
        {body}
      </div>
      {/* 框选用的橡皮筋框：位置每帧直接写 DOM（不动 React 状态），跟手且不触发重渲染 */}
      <div className="marquee" ref={marqueeRef} style={{ display: 'none' }} />
      {scrollDate ? (
        <div
          className="scroll-date"
          style={{
            // 跟着滚动条滑块中点走；上下留点余量，免得贴边溢出
            top:
              thumbCenter === null
                ? 12
                : Math.min(Math.max(thumbCenter, 22), Math.max(22, viewport - 22))
          }}
        >
          {scrollDate}
        </div>
      ) : null}
    </div>
  )
}
