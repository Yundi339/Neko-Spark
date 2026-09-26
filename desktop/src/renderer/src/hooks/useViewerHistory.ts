import { useCallback, useState } from 'react'
import type { MediaRecord } from '@shared/types'

export interface ViewerState {
  list: MediaRecord[]
  index: number
  /** 从回收站打开的查看器：工具栏换成"恢复 / 彻底删除"，Delete = 彻底删除 */
  mode?: 'library' | 'trash'
}

interface HistoryState {
  viewer: ViewerState | null
  past: (ViewerState | null)[]
  future: (ViewerState | null)[]
}

type NavigateTarget =
  | ViewerState
  | null
  | ((current: ViewerState | null) => ViewerState | null)

const EMPTY: HistoryState = { viewer: null, past: [], future: [] }

/**
 * 浏览器式浏览历史：
 * 打开查看器、切换图片、关闭查看器都记一步，鼠标侧键可像网页一样"撤回/前进"。
 */
export function useViewerHistory(): {
  viewer: ViewerState | null
  navigate: (next: NavigateTarget) => void
  replace: (updater: (current: ViewerState | null) => ViewerState | null) => void
  back: () => void
  forward: () => void
} {
  const [state, setState] = useState<HistoryState>(EMPTY)

  /** 记入历史的一步（前进后会清空重做栈，和浏览器一致） */
  const navigate = useCallback((next: NavigateTarget) => {
    setState((s) => {
      const value = typeof next === 'function' ? next(s.viewer) : next
      return { viewer: value, past: [...s.past, s.viewer], future: [] }
    })
  }, [])

  /** 只更新当前查看内容（如收藏状态），不产生历史步骤 */
  const replace = useCallback((updater: (current: ViewerState | null) => ViewerState | null) => {
    setState((s) => ({ ...s, viewer: updater(s.viewer) }))
  }, [])

  const back = useCallback(() => {
    setState((s) => {
      if (s.past.length === 0) return s
      return {
        viewer: s.past[s.past.length - 1],
        past: s.past.slice(0, -1),
        future: [s.viewer, ...s.future]
      }
    })
  }, [])

  const forward = useCallback(() => {
    setState((s) => {
      if (s.future.length === 0) return s
      const [next, ...rest] = s.future
      return { viewer: next, past: [...s.past, s.viewer], future: rest }
    })
  }, [])

  return { viewer: state.viewer, navigate, replace, back, forward }
}
