/**
 * 验证 Ctrl + 滚轮缩放缩略图
 * 用法：node scripts/_diag-zoom.mjs [hubPort] [cdpPort]
 */
import { createHash } from 'node:crypto'
import sharp from 'sharp'

const HUB_PORT = Number(process.argv[2] ?? 8805)
const CDP_PORT = Number(process.argv[3] ?? 9229)
const HUB = `http://127.0.0.1:${HUB_PORT}/api/v1`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let ws = null
let msgId = 0
const pending = new Map()

async function connectCdp() {
  const deadline = Date.now() + 30000
  let target = null
  while (Date.now() < deadline && !target) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      target = list.find((t) => t.type === 'page') ?? null
    } catch {
      /* 还没起来 */
    }
    if (!target) await sleep(500)
  }
  if (!target) throw new Error('找不到 CDP page target')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('CDP 连接超时')), 10000)
    ws.onopen = () => {
      clearTimeout(timer)
      res()
    }
    ws.onerror = () => {
      clearTimeout(timer)
      rej(new Error('CDP 连接失败'))
    }
  })
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    const h = pending.get(m.id)
    if (h) {
      pending.delete(m.id)
      h(m)
    }
  }
}

function evaluate(expression, timeoutMs = 8000) {
  return new Promise((res, rej) => {
    const id = ++msgId
    const timer = setTimeout(() => {
      pending.delete(id)
      rej(new Error('evaluate 超时'))
    }, timeoutMs)
    pending.set(id, (m) => {
      clearTimeout(timer)
      if (m.error) rej(new Error(JSON.stringify(m.error)))
      else res(m.result?.result?.value)
    })
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
  })
}

const PROBE = `(() => {
  const grid = document.querySelector('.vgrid-cells')
  if (!grid) return JSON.stringify({ cols: 0, w: 0, tiles: 0 })
  // 注意：不能切 grid.style.gridTemplateColumns —— 它是 "repeat(N, minmax(0, 1fr))"，
  // 按空格切永远得到 3 段。必须用计算样式，那里已经把 1fr 解析成了实际像素。
  const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length
  const t = document.querySelector('.tile:not(.tile-empty)')
  const r = t ? t.getBoundingClientRect() : { width: 0 }
  return JSON.stringify({ cols, w: Math.round(r.width), tiles: document.querySelectorAll('.tile:not(.tile-empty)').length })
})()`

const probe = async () => String(await evaluate(PROBE))

async function wheel(ctrl, up, times) {
  for (let i = 0; i < times; i += 1) {
    await evaluate(
      `(() => {
         const el = document.querySelector('.grid-wrap')
         el.dispatchEvent(new WheelEvent('wheel', {
           deltaY: ${up ? -100 : 100}, ctrlKey: ${ctrl}, bubbles: true, cancelable: true
         }))
         return true
       })()`
    )
    await sleep(130)
  }
  await sleep(450)
}

async function main() {
  await connectCdp()
  const info = await (await fetch(`${HUB}/info`)).json()
  console.log(`电脑端媒体数 = ${info.counts.media}`)
  if (info.counts.media === 0) {
    console.log('没有数据，先上传一些...')
    const device = { deviceId: 'zoom', name: '缩放测试', model: 'Z', androidVersion: '14' }
    const files = []
    for (let i = 0; i < 30; i += 1) {
      const buf = await sharp({
        create: { width: 500, height: 375, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 50 } }
      })
        .jpeg({ quality: 70 })
        .toBuffer()
      const ts = 1767225600000 + i * 3600000
      files.push({
        sha256: createHash('sha256').update(buf).digest('hex'),
        displayName: `Z_${i}.jpg`,
        relativePath: 'DCIM/Z/',
        bucketId: 'DCIM/Z',
        bucketName: 'Z',
        mimeType: 'image/jpeg',
        size: buf.length,
        width: 500,
        height: 375,
        dateTaken: ts,
        dateModified: ts,
        buf
      })
    }
    const items = files.map(({ buf, ...r }) => r)
    await fetch(`${HUB}/manifest`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ protocolVersion: 1, device, items }) })
    for (const f of files) {
      await fetch(`${HUB}/blob/${f.sha256}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg', 'Content-Range': `bytes 0-${f.size - 1}/${f.size}` },
        body: f.buf
      })
    }
    await fetch(`${HUB}/commit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ protocolVersion: 1, device, items }) })
    await sleep(3000)
  }

  console.log(`初始       ${await probe()}`)
  await wheel(true, true, 1)
  console.log(`Ctrl+上 x1 ${await probe()}`)
  await wheel(true, true, 3)
  console.log(`Ctrl+上 x3 ${await probe()}   ← 缩略图变大、每屏更少`)
  await wheel(true, false, 6)
  console.log(`Ctrl+下 x6 ${await probe()}`)
  await wheel(true, false, 8)
  console.log(`Ctrl+下 x8 ${await probe()}   ← 缩略图变小、每屏更多`)
  console.log('')
  console.log(`localStorage 记住的尺寸: ${await evaluate("localStorage.getItem('gm.cellSize')")}`)

  const before = await probe()
  await wheel(false, true, 3)
  const after = await probe()
  console.log(`不带 Ctrl 的滚轮: ${before} → ${after}  ${before === after ? '✅ 未受影响' : '❌ 被误触发'}`)
}

main().catch((e) => {
  console.error('失败：', e.message)
  process.exitCode = 1
})
