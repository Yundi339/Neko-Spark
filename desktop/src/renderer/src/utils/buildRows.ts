import type { MediaRecord } from '@shared/types'
import type { GridRow } from '../components/VirtualGrid'
import { formatDate } from './format'

function dayKey(media: MediaRecord): string {
  const ts = media.dateTaken ?? media.dateModified ?? media.dateAdded ?? 0
  const d = new Date(ts)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

/**
 * 生成虚拟行列表。
 *
 * @param showDateHeaders true（默认）= 按天分组，每天一个标题行；
 *   false = 紧凑模式，**不插入标题行、也不按天分块**，图片一路排下去。
 *   紧凑模式下日期看滚动条气泡，那个显示的是"该行最左边那张图"的日期
 *   （见 VirtualGrid 的 thumbCenter / midRowIndex），所以两种模式都取 items[0] 的日期。
 */
export function buildTimelineRows(
  media: MediaRecord[],
  columns: number,
  cellSize: number,
  gap: number,
  showDateHeaders = true
): GridRow[] {
  const rowHeight = cellSize + gap
  const rows: GridRow[] = []

  const labelOf = (m: MediaRecord): string =>
    formatDate(m.dateTaken ?? m.dateModified ?? m.dateAdded)

  if (!showDateHeaders) {
    for (let i = 0; i < media.length; i += columns) {
      const items = media.slice(i, i + columns)
      rows.push({
        key: `flat-${i}`,
        height: rowHeight,
        items,
        dateLabel: labelOf(items[0])
      })
    }
    return rows
  }

  let currentKey = ''
  let bucket: MediaRecord[] = []

  const flush = (): void => {
    if (bucket.length === 0) return
    const first = bucket[0]
    const label = formatDate(first.dateTaken ?? first.dateModified ?? first.dateAdded)
    rows.push({
      key: `header-${currentKey}`,
      height: 46,
      title: label,
      count: bucket.length
    })
    for (let i = 0; i < bucket.length; i += columns) {
      rows.push({
        key: `row-${currentKey}-${i}`,
        height: rowHeight,
        items: bucket.slice(i, i + columns),
        dateLabel: label
      })
    }
    bucket = []
  }

  for (const item of media) {
    const key = dayKey(item)
    if (key !== currentKey) {
      flush()
      currentKey = key
    }
    bucket.push(item)
  }
  flush()

  return rows
}
