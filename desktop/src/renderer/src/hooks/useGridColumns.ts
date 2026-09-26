import { useEffect, useRef, useState, type RefObject } from 'react'

/**
 * 根据容器宽度计算网格列数（自适应）。
 * 返回 ref 需要挂到测宽的容器上。
 */
export function useGridColumns(options?: {
  cell?: number
  min?: number
  max?: number
  gap?: number
}): { ref: RefObject<HTMLDivElement | null>; columns: number; cellSize: number; gap: number } {
  const cell = options?.cell ?? 180
  // max 放宽到 24：Ctrl+滚轮把缩略图缩到最小时要能一屏铺很多张
  const min = options?.min ?? 2
  const max = options?.max ?? 24
  const gap = options?.gap ?? 6

  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(1200)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(() => setWidth(el.clientWidth))
    observer.observe(el)
    setWidth(el.clientWidth)
    return () => observer.disconnect()
  }, [])

  const columns = Math.max(min, Math.min(max, Math.floor((width + gap) / (cell + gap))))
  const cellSize = Math.floor((width - gap * (columns - 1)) / columns)
  return { ref, columns, cellSize: Math.max(80, cellSize), gap }
}
