/** 验证「从缩略图放大展开」动画：点开后 .viewer-motion 应从缩小+位移过渡到原位 */
const CDP_PORT = Number(process.argv[2] ?? 9333)

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

const out = JSON.parse(String(await ev(`(async () => {
  const tile = [...document.querySelectorAll('.tile:not(.tile-empty)')][5]
  if (!tile) return JSON.stringify({ err: '没有格子' })
  const tileRect = tile.getBoundingClientRect()
  tile.click()
  // React 渲染后才会有 .viewer-motion；等它出现再从那一刻起采样
  let el = null
  const waitDeadline = Date.now() + 3000
  while (Date.now() < waitDeadline) {
    el = document.querySelector('.viewer-motion')
    if (el) break
    await new Promise((r) => setTimeout(r, 4))
  }
  if (!el) return JSON.stringify({ err: '没有 .viewer-motion（查看器没打开？）' })
  const t0 = performance.now()
  const samples = []
  while (performance.now() - t0 < 520) {
    const m = getComputedStyle(el).transform
    samples.push({ t: Math.round(performance.now() - t0), m })
    await new Promise((r) => setTimeout(r, 16))
  }
  const parse = (s) => {
    if (!s || s === 'none') return null
    const nums = s.match(/-?[\\d.]+/g)
    if (!nums || nums.length < 6) return null
    return { scale: +Number(nums[0]).toFixed(3), tx: Math.round(Number(nums[4])), ty: Math.round(Number(nums[5])) }
  }
  const parsed = samples.map((s) => ({ t: s.t, ...(parse(s.m) || { scale: 1, tx: 0, ty: 0 }) }))
  const first = parsed[0]
  const last = parsed[parsed.length - 1]
  // 找出"偏离原位"的采样点个数
  const offOrigin = parsed.filter((p) => Math.abs(p.scale - 1) > 0.02 || Math.abs(p.tx) > 4 || Math.abs(p.ty) > 4).length
  return JSON.stringify({
    tileW: Math.round(tileRect.width),
    tileX: Math.round(tileRect.left),
    tileY: Math.round(tileRect.top),
    first,
    last,
    offOrigin,
    total: parsed.length,
    mid: parsed[Math.floor(parsed.length / 3)]
  })
})()`)))

if (out.err) {
  console.log('验证失败：', out.err)
} else {
  console.log(`来源格子：宽 ${out.tileW}px  位置 (${out.tileX}, ${out.tileY})`)
  console.log(`起始帧  ：scale=${out.first.scale}  位移 (${out.first.tx}, ${out.first.ty})`)
  console.log(`1/3 处  ：scale=${out.mid.scale}  位移 (${out.mid.tx}, ${out.mid.ty})`)
  console.log(`结束帧  ：scale=${out.last.scale}  位移 (${out.last.tx}, ${out.last.ty})`)
  console.log('')
  console.log(`过渡中偏离原位的帧数：${out.offOrigin} / ${out.total}`)
  const startScale = out.first.scale
  const ok = startScale < 0.95 && Math.abs(out.last.scale - 1) < 0.02
  console.log(ok ? '✅ 动画生效：从缩略图大小放大到原位' : '❌ 动画未按预期播放')
}
process.exit(0)
