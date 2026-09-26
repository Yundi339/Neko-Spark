import type { JSX } from 'react'
import type { MediaRecord } from '@shared/types'
import { selectionList, selectionSize, useSelectionVersion } from '../hooks/useSelection'
import MediaGridView from './MediaGridView'

interface TrashViewProps {
  media: MediaRecord[]
  base: string
  retentionDays: number
  onOpen: (item: MediaRecord) => void
  onRestore: (ids: number[]) => void
  onPurge: (ids: number[]) => void
  emptyImage?: string
  pageBackground?: string
}

/**
 * 回收站。
 *
 * 语义（用户定的）：在这里再删一次 = 永久删除；30 天到期也会自动永久删除。
 * "永久"= 连磁盘上的原文件一起清掉（同一个内容还被别的相册/设备引用时不会误删）。
 */
export default function TrashView({
  media,
  base,
  retentionDays,
  onOpen,
  onRestore,
  onPurge,
  emptyImage,
  pageBackground
}: TrashViewProps): JSX.Element {
  // 工具条要知道选了哪些（订阅选中集合，框选时会跟着变）
  useSelectionVersion()
  const selected = selectionList()
  const count = selectionSize()

  const toolbar = (
    <>
      <button type="button" className="btn btn-primary" disabled={count === 0} onClick={() => onRestore(selected)}>
        恢复{count > 0 ? ` ${count} 项` : ''}
      </button>
      <button type="button" className="btn" disabled={count === 0} onClick={() => onPurge(selected)}>
        彻底删除{count > 0 ? ` ${count} 项` : ''}
      </button>
      <button type="button" className="btn" disabled={media.length === 0} onClick={() => onRestore(media.map((item) => item.id))}>
        全部恢复
      </button>
      <span className="grid-toolbar-tip">
        移入回收站 {retentionDays} 天后自动彻底删除（原文件也会删掉）；也可以随时在这里手动彻底删除。
        恢复会把照片放回原来的相册位置。
      </span>
    </>
  )

  return (
    <MediaGridView
      media={media}
      base={base}
      onOpen={onOpen}
      variant="trash"
      toolbar={media.length > 0 ? toolbar : null}
      emptyTitle="回收站是空的"
      emptyHint="在照片上按 Delete（或选中后删除）会先放到这里，30 天内都可以恢复。"
      emptyImage={emptyImage}
      pageBackground={pageBackground}
    />
  )
}
