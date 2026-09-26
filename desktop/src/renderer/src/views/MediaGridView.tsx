import { useEffect, useMemo, type JSX, type ReactNode } from 'react'
import type { MediaRecord } from '@shared/types'
import VirtualGrid from '../components/VirtualGrid'
import { useCompactGrid } from '../hooks/useCompactGrid'
import { useGridColumns } from '../hooks/useGridColumns'
import { ZOOM_STEP, useGridZoom } from '../hooks/useGridZoom'
import { buildTimelineRows } from '../utils/buildRows'

interface MediaGridViewProps {
  media: MediaRecord[]
  base: string
  onOpen: (media: MediaRecord) => void
  emptyTitle: string
  emptyHint: string
  emptyImage?: string
  /** 有内容时也铺一层很淡的背景图，保持风格统一 */
  pageBackground?: string
  action?: ReactNode
  /** 网格上方的一条工具条（回收站用它放"恢复 / 彻底删除"） */
  toolbar?: ReactNode
  /** trash = 回收站视图：格子右上角显示"剩 N 天"倒计时 */
  variant?: 'library' | 'trash'
}

export default function MediaGridView({
  media,
  base,
  onOpen,
  emptyTitle,
  emptyHint,
  emptyImage,
  pageBackground,
  action,
  toolbar,
  variant = 'library'
}: MediaGridViewProps): JSX.Element {
  const { cell, zoomBy } = useGridZoom()
  const { compact } = useCompactGrid()
  const { ref, columns, cellSize, gap } = useGridColumns({ cell })
  // 紧凑模式（Tab 切换）：不显示日期标题行，图片连续排下去
  const rows = useMemo(
    () => buildTimelineRows(media, columns, cellSize, gap, !compact),
    [media, columns, cellSize, gap, compact]
  )

  /**
   * Ctrl + 滚轮调整缩略图大小（上滚放大、下滚缩小），全视图共用并记忆。
   * 必须用原生监听且 passive:false —— 否则 preventDefault 拦不住
   * 浏览器/Electron 自带的整页缩放，界面会被一起放大。
   */
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey) return
      event.preventDefault()
      zoomBy(event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [ref, zoomBy])

  return (
    <div className="grid-wrap" ref={ref}>
      {media.length > 0 && pageBackground ? (
        <img className="page-bg" src={pageBackground} alt="" aria-hidden="true" draggable={false} />
      ) : null}
      {media.length === 0 ? (
        <div className="empty-state">
          {emptyImage ? (
            <img className="empty-bg" src={emptyImage} alt="" aria-hidden="true" draggable={false} />
          ) : null}
          <div className="empty-content">
            <h3>{emptyTitle}</h3>
            <p>{emptyHint}</p>
            {action}
          </div>
        </div>
      ) : (
        <>
          {toolbar ? <div className="grid-toolbar">{toolbar}</div> : null}
          <VirtualGrid rows={rows} columns={columns} base={base} onOpen={onOpen} variant={variant} />
        </>
      )}
    </div>
  )
}
