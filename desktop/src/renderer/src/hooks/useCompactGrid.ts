import { useCallback, useSyncExternalStore } from 'react'

const STORAGE_KEY = 'gm.compactGrid'

function load(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

// 模块级状态：四个视图共用，Tab 键切换。
// false = 按日期分组（每天一个标题行）
// true  = 紧凑模式（不显示日期标题，图片连续排下去，日期靠滚动条气泡看）
let current = load()
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function setCompact(next: boolean): void {
  if (next === current) return
  current = next
  try {
    localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
  } catch {
    /* 写不了就算了，不影响本次会话 */
  }
  for (const listener of listeners) listener()
}

/** 紧凑模式（隐藏日期标题行）——Tab 键切换，跨视图共享并持久化 */
export function useCompactGrid(): { compact: boolean; toggleCompact: () => void } {
  const compact = useSyncExternalStore(
    subscribe,
    () => current,
    () => false
  )
  const toggleCompact = useCallback(() => setCompact(!current), [])
  return { compact, toggleCompact }
}
