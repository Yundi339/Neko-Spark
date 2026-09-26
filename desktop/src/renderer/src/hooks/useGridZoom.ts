import { useCallback, useSyncExternalStore } from 'react'

const STORAGE_KEY = 'gm.cellSize'
/** 缩略图目标边长（像素）。太小会看不清，太大一屏放不下几张 */
const MIN = 90
const MAX = 420
const DEFAULT = 180
/** 每一格滚轮的缩放步长 */
export const ZOOM_STEP = 30

const clamp = (value: number): number => Math.max(MIN, Math.min(MAX, value))

function load(): number {
  try {
    const raw = Number(localStorage.getItem(STORAGE_KEY))
    return Number.isFinite(raw) && raw > 0 ? clamp(raw) : DEFAULT
  } catch {
    return DEFAULT
  }
}

// 模块级状态：全部/收藏/视频/相册 四个视图共用同一份缩放级别，
// 用 useSyncExternalStore 订阅，避免为了共享而在 App 里层层传 props。
let current = load()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function setZoom(next: number): void {
  const value = clamp(next)
  if (value === current) return
  current = value
  try {
    localStorage.setItem(STORAGE_KEY, String(value))
  } catch {
    /* 隐私模式等写不了就算了，不影响本次会话 */
  }
  for (const listener of listeners) listener()
}

/** 缩略图尺寸：Ctrl + 滚轮调整，跨视图共享并持久化到 localStorage */
export function useGridZoom(): { cell: number; zoomBy: (delta: number) => void; atMin: boolean; atMax: boolean } {
  const cell = useSyncExternalStore(
    subscribe,
    () => current,
    () => DEFAULT
  )
  const zoomBy = useCallback((delta: number) => setZoom(current + delta), [])
  return { cell, zoomBy, atMin: cell <= MIN, atMax: cell >= MAX }
}
