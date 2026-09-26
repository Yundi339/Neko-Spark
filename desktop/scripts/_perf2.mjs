/**
 * 界面流畅度体检（不依赖窗口可见）
 *
 * 窗口最小化时 Chromium 不产帧，测不到真实 FPS。但卡顿的根因是**主线程耗时** ——
 * 滚动一步要做多少 JS 工作（React 渲染 + 布局）。这个数决定了帧率上限：
 *   每步 2ms  → 轻松 60fps
 *   每步 20ms → 必然掉到 30~40fps
 * 所以这里测的是"每滚一步的主线程耗时"，用 MessageChannel 卡在宏任务边界上量。
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
const ev = (expr, ms = 300000) => {
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

console.log('========== 界面流畅度 ==========')
console.log('媒体数:', await ev(`(() => { const e = [...document.querySelectorAll('.pill')].find(x => x.textContent.includes('项媒体')); return e ? e.textContent.replace(/\\s+/g,' ').trim() : '?' })()`))

// ---- 1. 每滚一步的主线程耗时 ----
const scroll = JSON.parse(String(await ev(`(async () => {
  const grid = document.querySelector('.vgrid')
  if (!grid) return JSON.stringify({ err: '没有网格' })
  const nextTask = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0) })
  const samples = []
  const maxY = Math.max(1, grid.scrollHeight - grid.clientHeight)
  grid.scrollTop = 0
  grid.dispatchEvent(new Event('scroll'))
  await nextTask()
  for (let i = 0; i < 80; i += 1) {
    const y = (maxY * i) / 80
    const t0 = performance.now()
    grid.scrollTop = y
    grid.dispatchEvent(new Event('scroll'))
    await nextTask()          // 让 React 在这一轮里渲染完
    void grid.offsetHeight    // 强制同步布局，把布局开销算进来
    samples.push(performance.now() - t0)
  }
  samples.sort((a, b) => a - b)
  const avg = samples.reduce((s, x) => s + x, 0) / samples.length
  return JSON.stringify({
    n: samples.length,
    avg: +avg.toFixed(2),
    p50: +samples[Math.floor(samples.length * 0.5)].toFixed(2),
    p95: +samples[Math.floor(samples.length * 0.95)].toFixed(2),
    worst: +samples[samples.length - 1].toFixed(2)
  })
})()`)))
if (scroll.err) console.log('滚动测量失败：', scroll.err)
else {
  console.log(`滚动一步主线程耗时：平均 ${scroll.avg}ms   中位 ${scroll.p50}ms   95分位 ${scroll.p95}ms   最差 ${scroll.worst}ms  （${scroll.n} 次采样）`)
  const budget = 16.7
  console.log(`  → 60fps 的预算是 ${budget}ms/帧；${scroll.p95 < budget ? '✅ 95分位在预算内，能稳住 60fps' : '❌ 95分位超预算，会掉帧'}`)
}

// ---- 2. 打开大图延迟（取还没加载过的图，量冷启动） ----
const viewer = JSON.parse(String(await ev(`(async () => {
  const tiles = [...document.querySelectorAll('.tile:not(.tile-empty)')].slice(30, 60)
  if (!tiles.length) return JSON.stringify({ err: '格子不够' })
  const results = []
  for (const tile of tiles.slice(0, 6)) {
    const t0 = performance.now()
    tile.click()
    const deadline = Date.now() + 12000
    let ok = false
    while (Date.now() < deadline) {
      const img = document.querySelector('.viewer-media')
      if (img && img.complete && img.naturalWidth > 0) { ok = true; break }
      await new Promise((r) => setTimeout(r, 8))
    }
    results.push(ok ? +(performance.now() - t0).toFixed(0) : -1)
    const close = document.querySelector('.viewer-close')
    if (close) close.click()
    await new Promise((r) => setTimeout(r, 250))
  }
  return JSON.stringify({ results })
})()`)))
if (viewer.err) console.log('打开大图测量失败：', viewer.err)
else {
  const ok = viewer.results.filter((r) => r >= 0)
  const avg = ok.length ? Math.round(ok.reduce((s, x) => s + x, 0) / ok.length) : -1
  console.log(`点击缩略图 → 大图可见：${viewer.results.join('ms / ')}ms   平均 ${avg}ms`)
}

// ---- 3. 长任务 ----
await ev(`(() => { window.__lt = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)) }).observe({ entryTypes: ['longtask'] }) } catch (e) {} return true })()`)
await ev(`(async () => {
  const grid = document.querySelector('.vgrid')
  const maxY = Math.max(1, grid.scrollHeight - grid.clientHeight)
  for (let i = 0; i < 200; i += 1) { grid.scrollTop = (maxY * i) / 200; grid.dispatchEvent(new Event('scroll')); await new Promise((r) => setTimeout(r, 12)) }
  return true
})()`)
const lt = await ev(`JSON.stringify(window.__lt || [])`)
console.log('长任务（>50ms 阻塞）:', lt)

process.exit(0)
