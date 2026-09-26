import { useSyncExternalStore } from 'react'

/**
 * 网格里的多选集合（像资源管理器那样）。
 *
 * 沿用本项目已有的"模块级状态 + useSyncExternalStore"写法（见 useGridZoom / useCompactGrid），
 * 不引入任何状态管理库。
 *
 * 性能要点（大库要丝滑）：
 *   - 只存一个 id 集合 + 一个版本号，订阅的是版本号（数字），不会因为 Set 引用变化而白刷
 *   - 虚拟网格只渲染视口内的几十个格子，选中态变化最多重渲染这些格子
 *   - 框选时每帧算出的集合先和上一份比较，**没变就不发通知**，避免空转重渲染
 */
let selected = new Set<number>()
/** 范围选择（Shift 点选）的锚点 */
let anchor: number | null = null
let version = 0
const listeners = new Set<() => void>()

function emit(): void {
  version += 1
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function sameSet(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false
  for (const value of a) {
    if (!b.has(value)) return false
  }
  return true
}

/** 整体替换（框选、全选、清空都走它）；内容没变则完全不触发重渲染 */
export function setSelection(next: Iterable<number>, nextAnchor: number | null = anchor): void {
  const values = new Set(next)
  const anchorChanged = nextAnchor !== anchor
  if (sameSet(values, selected) && !anchorChanged) return
  selected = values
  anchor = nextAnchor
  emit()
}

export function toggleSelection(id: number): void {
  const next = new Set(selected)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  setSelection(next, id)
}

export function clearSelection(): void {
  setSelection([], null)
}

/** Shift 点选：按当前列表顺序选中锚点到目标之间的所有项 */
export function selectRange(ordered: number[], id: number): void {
  const to = ordered.indexOf(id)
  if (to < 0) return
  const from = anchor === null ? to : ordered.indexOf(anchor)
  if (from < 0) {
    setSelection([id], id)
    return
  }
  const [lo, hi] = from <= to ? [from, to] : [to, from]
  setSelection(ordered.slice(lo, hi + 1), anchor ?? id)
}

export function selectionHas(id: number): boolean {
  return selected.has(id)
}

export function selectionList(): number[] {
  return [...selected]
}

export function selectionSize(): number {
  return selected.size
}

export function useSelectionVersion(): number {
  return useSyncExternalStore(
    subscribe,
    () => version,
    () => 0
  )
}
