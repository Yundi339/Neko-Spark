/**
 * 验证"渐进式显示 + 预览器预取"
 * 用法：node scripts/_diag-viewer.mjs <cdpPort>
 *
 * 期望：
 *   ① 点开瞬间就有画面（模糊缩略图立刻可见），而不是白屏等原图
 *   ② 原图随后淡入
 *   ③ 打开后会预取相邻的原图（网络记录里能看到 ±1/±2 的 file 请求）
 */
const CDP_PORT = Number(process.argv[2] ?? 9333)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
const target = list.find((t) => t.type === 'page' && String(t.title).includes('相册镜像'))
if (!target) {
  console.error('端口上没有相册镜像')
  process.exit(1)
}
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = () => rej(new Error('ws fail'))
  setTimeout(() => rej(new Error('ws timeout')), 8000)
})
let msgId = 0
const pending = new Map()
ws.onmessage = (e) => {
  const m = JSON.parse(e.data)
  const h = pending.get(m.id)
  if (h) {
    pending.delete(m.id)
    h(m)
  }
}
const ev = (expr, ms = 120000) => {
  const id = ++msgId
  return new Promise((res, rej) => {
    const t = setTimeout(() => {
      pending.delete(id)
      rej(new Error('timeout'))
    }, ms)
    pending.set(id, (m) => {
      clearTimeout(t)
      if (m.error) rej(new Error(JSON.stringify(m.error)))
      else res(m.result?.result?.value)
    })
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }))
  })
}

console.log('媒体数:', await ev(`(() => { const e = [...document.querySelectorAll('.pill')].find(x => x.textContent.includes('项媒体')); return e ? e.textContent.replace(/\\s+/g,' ').trim() : '?' })()`))
console.log('')

const result = JSON.parse(String(await ev(`(async () => {
  const tiles = [...document.querySelectorAll('.tile:not(.tile-empty)')]
  if (tiles.length < 6) return JSON.stringify({ err: '格子不够: ' + tiles.length })
  const rows = []
  for (let i = 0; i < 5; i += 1) {
    const tile = tiles[i * 3]
    if (!tile) continue
    const t0 = performance.now()
    tile.click()
    let blurMs = -1
    let fullMs = -1
    const deadline = Date.now() + 12000
    while (Date.now() < deadline) {
      if (blurMs < 0) {
        const b = document.querySelector('.viewer-media-blur')
        if (b && b.complete && b.naturalWidth > 0) blurMs = performance.now() - t0
      }
      if (fullMs < 0) {
        const f = document.querySelector('.viewer-media-full')
        if (f && f.complete && f.naturalWidth > 0 && getComputedStyle(f).opacity === '1') fullMs = performance.now() - t0
      }
      if (blurMs >= 0 && fullMs >= 0) break
      await new Promise((r) => setTimeout(r, 8))
    }
    rows.push({ blur: Math.round(blurMs), full: Math.round(fullMs) })
    document.querySelector('.viewer-actions .btn:last-child')?.click()
    await new Promise((r) => setTimeout(r, 200))
  }
  return JSON.stringify({ rows })
})()`)))

if (result.err) {
  console.log('测量失败：', result.err)
} else {
  console.log('  序号   有画面(模糊缩略图)   完全清晰(原图)')
  result.rows.forEach((r, i) => {
    console.log(`   #${i + 1}      ${String(r.blur).padStart(5)}ms            ${String(r.full).padStart(5)}ms`)
  })
  const avgBlur = Math.round(result.rows.reduce((s, r) => s + Math.max(0, r.blur), 0) / result.rows.length)
  const avgFull = Math.round(result.rows.reduce((s, r) => s + Math.max(0, r.full), 0) / result.rows.length)
  console.log('')
  console.log(`  平均：有画面 ${avgBlur}ms   完全清晰 ${avgFull}ms`)
  console.log(`  → 观感 = 点开 ${avgBlur}ms 就有东西（不再是白屏干等 ${avgFull}ms）`)
}

// 预取验证
await ev(`(async () => { const t = document.querySelector('.tile:not(.tile-empty)'); t && t.click(); await new Promise(r=>setTimeout(r,1200)); return true })()`)
const prefetch = JSON.parse(String(await ev(`(() => {
  const files = performance.getEntriesByType('resource').filter(e => e.name.includes('/api/v1/file/')).length
  const thumbs = performance.getEntriesByType('resource').filter(e => e.name.includes('/api/v1/thumb/')).length
  return JSON.stringify({ files, thumbs })
})()`)))
console.log('')
console.log(`  网络记录：原图请求 ${prefetch.files} 个，缩略图请求 ${prefetch.thumbs} 个`)
console.log(`  → 原图请求 >1 说明相邻图片被预取了`)
process.exit(0)
