/** 诊断查看器里图片的尺寸约束：竖长图是否被 max-height 正确限制 */
const CDP_PORT = Number(process.argv[2] ?? 9333)
const TARGET = process.argv[3] ?? 'tall.jpg'

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
const ev = (expr, ms = 60000) => {
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
  const tile = [...document.querySelectorAll('.tile:not(.tile-empty)')].find(t => t.getAttribute('title') === ${JSON.stringify(TARGET)})
  if (!tile) return JSON.stringify({ err: '找不到格子 ' + ${JSON.stringify(TARGET)} + '，现有: ' + [...document.querySelectorAll('.tile')].map(t=>t.getAttribute('title')).join(',') })
  tile.click()
  const dl = Date.now() + 4000
  let img = null
  while (Date.now() < dl) { img = document.querySelector('.viewer-media'); if (img) break; await new Promise(r=>setTimeout(r,8)) }
  if (!img) return JSON.stringify({ err: '查看器没打开' })
  await new Promise(r=>setTimeout(r,600))
  const stage = document.querySelector('.viewer-stage')
  const box = (el) => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) } }
  const cs = (el) => { const s = getComputedStyle(el); return { maxW: s.maxWidth, maxH: s.maxHeight, objectFit: s.objectFit, display: s.display, height: s.height } }
  return JSON.stringify({
    natural: { w: img.naturalWidth, h: img.naturalHeight },
    imgBox: box(img),
    stageBox: box(stage),
    stageCS: cs(stage),
    imgCS: cs(img),
    overflowY: Math.round(box(img).h - box(stage).h)
  })
})()`)))

if (out.err) {
  console.log('失败：', out.err)
} else {
  console.log(`图片原始尺寸 : ${out.natural.w} × ${out.natural.h}（宽高比 ${(out.natural.w / out.natural.h).toFixed(3)}）`)
  console.log(`舞台 (.viewer-stage) : ${out.stageBox.w} × ${out.stageBox.h}`)
  
  console.log(`图片实际渲染 : ${out.imgBox.w} × ${out.imgBox.h}`)
  console.log('')
  console.log(`图片是否溢出舞台：${out.overflowY > 0 ? `❌ 高出 ${out.overflowY}px` : '✅ 没有溢出'}`)
  console.log('')
  console.log('计算样式：')
  console.log('  stage  ', JSON.stringify(out.stageCS))

  console.log('  img    ', JSON.stringify(out.imgCS))
}
process.exit(0)
