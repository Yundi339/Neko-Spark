/** 通过 CDP 触发一次"导入文件夹"，把示例照片预置进数据目录。用法：node scripts/_diag-import.mjs <cdpPort> <文件夹> */
const CDP_PORT = Number(process.argv[2] ?? 9333)
const FOLDER = process.argv[3] ?? 'G:/111/示例照片'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
const target = list.find((t) => t.type === 'page' && String(t.title).includes('相册镜像'))
if (!target) {
  console.error(`端口 ${CDP_PORT} 上找不到相册镜像（当前：${list.map((t) => t.title).join(' / ')}）`)
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
const ev = (expr, ms = 180000) => {
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

console.log(`导入「${FOLDER}」...`)
const result = await ev(
  `window.gm.importFolder(${JSON.stringify(FOLDER)}).then((p) => JSON.stringify({ phase: p.phase, total: p.total, imported: p.imported, skipped: p.skipped, failed: p.failed }))`
)
console.log('导入结果:', result)
await sleep(1500)
const info = await (await fetch(`https://127.0.0.1:${Number(process.env.HUB_PORT ?? 8809)}/api/v1/info`)).json()
console.log('电脑端统计:', JSON.stringify(info.counts))
process.exit(0)
