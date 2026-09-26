import { useEffect, useRef, type JSX } from 'react'
import type { AlbumRecord } from '@shared/types'
import { thumbUrl } from '../api'
import { formatCount } from '../utils/format'
import { ZOOM_STEP, useGridZoom } from '../hooks/useGridZoom'
import mascotThink from '../assets/stickers/mascot-think.svg'

interface AlbumsViewProps {
  albums: AlbumRecord[]
  base: string
  showDevice?: boolean
  deviceName?: (deviceId: string) => string
  emptyImage?: string
  pageBackground?: string
  onOpenAlbum: (album: AlbumRecord) => void
}

export default function AlbumsView({
  albums,
  base,
  showDevice = false,
  deviceName,
  emptyImage,
  pageBackground,
  onOpenAlbum
}: AlbumsViewProps): JSX.Element {
  // 相册卡片也吃 Ctrl+滚轮缩放，**和媒体网格共用同一档位**（同在 useGridZoom 里）。
  // 用户 2026-09-25 反馈："相册 tab 加鼠标滚轮无法放大放小" —— 之前只有媒体网格接了滚轮，
  // 相册视图没接。这里照 MediaGridView 的写法（原生监听 + passive:false，才能 preventDefault
  // 掉 Chromium 自带的整页缩放）。
  const { cell, zoomBy } = useGridZoom()
  const wrapRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey) return
      event.preventDefault()
      zoomBy(event.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomBy])

  // ⚠️ 必须是**单一 return**（空状态也要走同一个 `.grid-wrap`）：
  // 曾经写成"空的时候提前 return 另一个 div"，结果 `wrapRef` 在第一次渲染时挂不上，
  // 而下面那个 effect 只在挂载时跑一次 → **用户点"相册"时数据还没加载完（先渲染空状态）的情况下，
  // 滚轮监听永远没挂上**，Ctrl+滚轮怎么按都没反应（2026-09-25 用户实测反馈）。
  // 媒体网格（MediaGridView）一直是单一结构，所以它没有这个问题 —— 现在保持一致。
  return (
    <div className="grid-wrap" ref={wrapRef}>
      {pageBackground && albums.length > 0 ? (
        <img className="page-bg" src={pageBackground} alt="" aria-hidden="true" draggable={false} />
      ) : null}
      {albums.length === 0 ? (
        <div className="empty-state">
          <img className="empty-bg" src={emptyImage || mascotThink} alt="" aria-hidden="true" draggable={false} />
          <div className="empty-content">
            <h3>还没有相册</h3>
            <p>从手机备份或导入本地文件夹后，这里会按手机里的相册（文件夹）分组显示。</p>
          </div>
        </div>
      ) : (
        <div
          className="album-grid"
          // 卡片宽度跟着缩放档位走（+10 是和默认档 180 → 原设计 190px 对齐）
          style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${cell + 10}px, 1fr))` }}
        >
          {albums.map((album) => (
            <button
              key={`${album.deviceId}-${album.bucketId}`}
              type="button"
              className="album-card"
              onClick={() => onOpenAlbum(album)}
            >
              <div className="album-cover">
                {album.coverMediaId ? (
                  <img src={thumbUrl(base, album.coverMediaId)} alt={album.bucketName} loading="lazy" />
                ) : (
                  <div className="album-cover-empty" />
                )}
              </div>
              <div className="album-meta">
                <strong>{album.bucketName}</strong>
                <span>
                  {formatCount(album.count)} 项
                  {showDevice && deviceName ? ` · ${deviceName(album.deviceId)}` : ''}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
