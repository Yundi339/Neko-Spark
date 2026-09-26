import { useEffect, useState } from 'react'

/**
 * 读取用户自定义贴图（数据目录 stickers/ 里的图片）。
 * 有自定义贴图时优先使用，没有则用内置吉祥物。
 */
export function useUserStickers(base: string): string[] {
  const [stickers, setStickers] = useState<string[]>([])

  useEffect(() => {
    if (!base) return
    let alive = true
    fetch(`${base}/stickers`)
      .then((res) => (res.ok ? res.json() : { stickers: [] }))
      .then((data: { stickers?: string[] }) => {
        if (!alive) return
        setStickers((data.stickers ?? []).map((name) => `${base}/sticker/${encodeURIComponent(name)}`))
      })
      .catch(() => {
        /* 忽略：没有自定义贴图时用内置的 */
      })
    return () => {
      alive = false
    }
  }, [base])

  return stickers
}

/**
 * 空状态用的高清背景图（数据目录里的 background-1..4.webp）。
 * 每个页面用不同的一张，避免"点哪都是同一张图"。
 */
export function useBackgrounds(base: string, version: number): (string | null)[] {
  const [urls, setUrls] = useState<(string | null)[]>([null, null, null, null])

  useEffect(() => {
    if (!base) return
    let alive = true
    const candidates = [1, 2, 3, 4].map((n) => `${base}/background/${n}?v=${version || 0}`)
    Promise.all(
      candidates.map(async (url) => {
        try {
          const res = await fetch(url)
          return res.ok ? url : null
        } catch {
          return null
        }
      })
    ).then((results) => {
      if (alive) setUrls(results)
    })
    return () => {
      alive = false
    }
  }, [base, version])

  return urls
}
