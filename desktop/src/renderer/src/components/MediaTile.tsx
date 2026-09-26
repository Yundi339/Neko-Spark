import { memo, useState, type JSX } from 'react'
import type { MediaRecord } from '@shared/types'
import { thumbUrl } from '../api'
import { formatDuration } from '../utils/format'

interface MediaTileProps {
  media: MediaRecord
  base: string
  /** 多选选中态（像资源管理器那样） */
  selected?: boolean
  /** 回收站里的条目：右上角显示"剩 N 天" */
  expireDays?: number
}

/**
 * 单个缩略图格子。
 *
 * ⚠️ 这里刻意**不挂 onClick** —— 点击/拖动都交给 VirtualGrid 在容器上统一处理（事件委托）：
 *   - 4000 张的库少挂几千个监听
 *   - 单击打开 / Ctrl 加选 / Shift 范围选 需要一起看修饰键，放在一处更清楚
 */
function MediaTile({ media, base, selected, expireDays }: MediaTileProps): JSX.Element {
  const [failed, setFailed] = useState(false)
  const isVideo = media.kind === 'video'
  // 视频的首帧是渲染端抽好之后存进来的（thumbState 会变成 ready）；
  // 还没有首帧就显示播放占位（原来一直是这样，用户反馈"全看不出是什么视频"才有了抽帧）
  const hasThumb = media.thumbState === 'ready'
  const showImage = !failed && media.thumbState !== 'failed' && (!isVideo || hasThumb)

  return (
    <button
      type="button"
      className={`tile ${selected ? 'is-selected' : ''}`}
      // 拖出到资源管理器时用来定位是哪一张（也是点击委托的定位锚点）
      data-id={media.id}
      title={media.displayName}
      draggable
    >
      {showImage ? (
        <img
          src={thumbUrl(base, media.id)}
          alt={media.displayName}
          loading="lazy"
          draggable={false}
          onError={() => setFailed(true)}
        />
      ) : (
        <div className={`tile-placeholder ${isVideo ? 'is-video' : ''}`}>
          {isVideo ? (
            <svg viewBox="0 0 24 24" className="tile-play" aria-hidden="true">
              <circle cx="12" cy="12" r="10" fill="rgba(0,0,0,0.45)" />
              <path d="M10 8.5v7l6-3.5-6-3.5Z" fill="#fff" />
            </svg>
          ) : (
            <span className="tile-placeholder-text">无法预览</span>
          )}
        </div>
      )}

      {isVideo ? <span className="tile-badge">{formatDuration(media.durationMs) || '视频'}</span> : null}

      {media.isFavorite ? (
        <span className="tile-fav" title="已收藏">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m12 4 2.4 5 5.5.8-4 3.9.9 5.5L12 16.6 7.2 19.4l.9-5.5-4-3.9 5.5-.8L12 4Z" />
          </svg>
        </span>
      ) : null}

      {typeof expireDays === 'number' ? (
        <span className={`tile-expire ${expireDays <= 3 ? 'is-soon' : ''}`} title="到期后自动彻底删除">
          剩 {expireDays} 天
        </span>
      ) : null}

      {media.sourceDeleted && typeof expireDays !== 'number' ? (
        <span className="tile-deleted" title="手机上已删除，电脑仍保留这份备份">
          已删除
        </span>
      ) : null}
    </button>
  )
}

// 大库要丝滑：选中态变化时只重渲染真正变了的格子
export default memo(MediaTile)
