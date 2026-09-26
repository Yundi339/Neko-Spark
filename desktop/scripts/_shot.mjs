/** 用 CDP 给当前窗口截图，存成 PNG。用法：node scripts/_shot.mjs <cdpPort> <输出文件> */
import { writeFileSync } from 'node:fs'

const CDP_PORT = Number(process.argv[2] ?? 9333)
const OUT = process.argv[3] ?? 'D:/shot.png'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
const target = list.find((t) => t.type === 'page' && String(t.title).includes('相册镜像'))
if (!target) {
  console.error(`端口 ${CDP_PORT} 上找不到相册镜像（当前页面标题：${list.map((t) => t.title).join(' / ')}）`)
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
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  const h = pending.get(m.id)
  if (h) {
    pending.delete(m.id)
    h(m)
  }
}
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++msgId
    const t = setTimeout(() => rej(new Error(`${method} 超时`)), 20000)
    pending.set(id, (m) => {
      clearTimeout(t)
      m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
    })
    ws.send(JSON.stringify({ id, method, params }))
  })

await sleep(1500)
const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(OUT, Buffer.from(shot.data, 'base64'))
console.log(`已截图 → ${OUT}`)
process.exit(0)
