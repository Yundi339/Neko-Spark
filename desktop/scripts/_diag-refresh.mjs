/**
 * 测量「手机上传时，电脑端界面被要求重拉多少次全量列表」
 * 用法：node scripts/_diag-refresh.mjs <hubPort> <cdpPort> [文件数]
 *
 * 原理：在渲染进程里挂钩 window.fetch，数 /api/v1/media 被调用了几次。
 * 修复前：每落盘一个文件通知一次 → 次数 ≈ 文件数
 * 修复后：限流到最多每 1.2 秒一次 → 次数 ≈ 上传耗时 / 1.2
 */
import { createHash } from 'node:crypto'
import sharp from 'sharp'

const HUB_PORT = Number(process.argv[2] ?? 8801)
const CDP_PORT = Number(process.argv[3] ?? 9225)
const N = Number(process.argv[4] ?? 400)
const HUB = `https://127.0.0.1:${HUB_PORT}/api/v1`

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

async function main() {
  await connectCdp()
  console.log('CDP 已连接')

  // 挂钩 fetch，统计各类接口调用次数
  await evaluate(`(() => {
    if (window.__gmCount) return 'already'
    window.__gmCount = { media: 0, devices: 0, status: 0, thumb: 0, other: 0 }
    const orig = window.fetch.bind(window)
    window.fetch = (input, init) => {
      try {
        const url = String(typeof input === 'string' ? input : (input && input.url) || '')
        if (url.includes('/api/v1/media')) window.__gmCount.media++
        else if (url.includes('/api/v1/devices')) window.__gmCount.devices++
        else if (url.includes('/api/v1/status')) window.__gmCount.status++
        else if (url.includes('/api/v1/thumb')) window.__gmCount.thumb++
        else if (url.includes('/api/v1/')) window.__gmCount.other++
      } catch (e) {}
      return orig(input, init)
    }
    return 'hooked'
  })()`)

  console.log(`开始模拟手机上传 ${N} 个文件...`)
  const device = { deviceId: 'refresh-phone', name: '限流测试机', model: 'T', androidVersion: '14' }
  const files = []
  for (let i = 0; i < N; i += 1) {
    const buf = await sharp({
      create: { width: 400, height: 300, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 50 } }
    })
      .jpeg({ quality: 70 })
      .toBuffer()
    files.push({
      sha256: createHash('sha256').update(buf).digest('hex'),
      displayName: `R_${String(i).padStart(4, '0')}.jpg`,
      relativePath: 'DCIM/Refresh/',
      bucketId: 'DCIM/Refresh',
      bucketName: 'Refresh',
      mimeType: 'image/jpeg',
      size: buf.length,
      width: 400,
      height: 300,
      dateTaken: 1767225600000 + i * 1000,
      dateModified: 1767225600000 + i * 1000,
      buf
    })
  }
  const items = files.map(({ buf, ...r }) => r)
  await fetch(`${HUB}/manifest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1, device, items })
  })

  const t0 = Date.now()
  for (const f of files) {
    await fetch(`${HUB}/blob/${f.sha256}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg', 'Content-Range': `bytes 0-${f.size - 1}/${f.size}` },
      body: f.buf
    })
  }
  const uploadMs = Date.now() - t0
  console.log(`上传完成：${N} 个文件用了 ${(uploadMs / 1000).toFixed(1)} 秒`)

  await sleep(3000)
  const count = await evaluate(`JSON.stringify(window.__gmCount)`)
  const info = await (await fetch(`${HUB}/info`)).json()
  console.log('')
  console.log(`  /api/v1/media  被调用 = ${JSON.parse(count).media} 次`)
  console.log(`  /api/v1/thumb  被调用 = ${JSON.parse(count).thumb} 次`)
  console.log(`  电脑端实际媒体数 = ${info.counts.media}`)
  console.log('')
  console.log(`  对照：不修的话，每落盘一个文件通知一次 → 约 ${N} 次全量重拉（每次 1.7MB 级别）`)
  console.log(`  实际：${JSON.parse(count).media} 次`)
}

main().catch((e) => {
  console.error('测量失败：', e.message)
  process.exitCode = 1
})
