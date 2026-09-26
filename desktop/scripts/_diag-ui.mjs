/**
 * 界面验证：以受控速度模拟手机上传，同时通过 CDP 读真实界面
 * 验证两件事：① 照片是否逐个出现在网格里 ② 上传横幅是否真的显示
 * 用法：node scripts/_diag-ui.mjs
 */
import { createHash } from 'node:crypto'
import sharp from 'sharp'

const HUB = 'http://127.0.0.1:8801/api/v1'
const CDP = 9225
const N = 60

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const stamp = () => `t=${((Date.now() - t0) / 1000).toFixed(1)}s`

let ws = null
let msgId = 0
const pending = new Map()

async function connectCdp() {
  const deadline = Date.now() + 30000
  let target = null
  while (Date.now() < deadline && !target) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()
      target = list.find((t) => t.type === 'page') ?? null
    } catch {
      /* 还没起来 */
    }
    if (!target) await sleep(500)
  }
  if (!target) throw new Error('找不到 CDP page target')

  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    const timer = setTimeout(() => rej(new Error('CDP WebSocket 连接超时')), 10000)
    ws.onopen = () => {
      clearTimeout(timer)
      res()
    }
    ws.onerror = () => {
      clearTimeout(timer)
      rej(new Error('CDP WebSocket 连接失败'))
    }
  })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    const handler = pending.get(msg.id)
    if (handler) {
      pending.delete(msg.id)
      handler(msg)
    }
  }
}

function evaluate(expression, timeoutMs = 5000) {
  return new Promise((res, rej) => {
    const id = ++msgId
    const timer = setTimeout(() => {
      pending.delete(id)
      rej(new Error('evaluate 超时'))
    }, timeoutMs)
    pending.set(id, (msg) => {
      clearTimeout(timer)
      if (msg.error) rej(new Error(JSON.stringify(msg.error)))
      else res(msg.result?.result?.value)
    })
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
  })
}

const mediaCount = async () => (await (await fetch(`${HUB}/info`)).json()).counts.media

async function main() {
  await connectCdp()
  console.log('CDP 已连接\n')

  const start = await mediaCount()
  console.log(`${stamp()}  电脑端起始媒体数 = ${start}`)

  // 造 N 张互不相同的图（用噪声保证内容唯一，避免字节重复）
  console.log(`${stamp()}  生成 ${N} 张不重复的测试图...`)
  const device = { deviceId: 'ui-phone', name: '界面验证机', model: 'UI', androidVersion: '14' }
  const files = []
  for (let i = 0; i < N; i += 1) {
    const buf = await sharp({
      create: { width: 800 + i, height: 600, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 60 } }
    })
      .jpeg({ quality: 82 })
      .toBuffer()
    files.push({
      sha256: createHash('sha256').update(buf).digest('hex'),
      displayName: `UI_${String(i).padStart(3, '0')}.jpg`,
      relativePath: 'DCIM/UITest/',
      bucketId: 'DCIM/UITest',
      bucketName: 'UITest',
      mimeType: 'image/jpeg',
      size: buf.length,
      width: 800 + i,
      height: 600,
      dateTaken: 1767225600000 + i * 1000,
      dateModified: 1767225600000 + i * 1000,
      buf
    })
  }
  const items = files.map(({ buf, ...rest }) => rest)

  await fetch(`${HUB}/manifest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1, device, items })
  })
  console.log(`${stamp()}  清单已上报，开始逐个上传（每个间隔 250ms，模拟真实速度）`)
  console.log('')
  console.log('  ── 观察真实界面 ──')

  let bannerSamples = 0
  let bannerText = ''
  let lastTiles = -1

  for (let i = 0; i < N; i += 1) {
    const f = files[i]
    await fetch(`${HUB}/blob/${f.sha256}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg', 'Content-Range': `bytes 0-${f.size - 1}/${f.size}` },
      body: f.buf
    })
    await sleep(250)

    if (i % 10 === 9 || i === N - 1) {
      const media = await mediaCount()
      const tiles = await evaluate(`document.querySelectorAll('.tile').length`)
      const banner = await evaluate(
        `(() => { const el = document.querySelector('.sync-banner-text'); return el ? el.textContent.replace(/\\s+/g,' ').trim() : '' })()`
      )
      if (banner) {
        bannerSamples += 1
        bannerText = banner
      }
      console.log(
        `${stamp()}  已传 ${String(i + 1).padStart(2)}/${N}  →  后端媒体数=${String(media).padStart(3)}  界面格子=${String(tiles).padStart(2)}  ${banner ? `横幅「${banner}」` : '横幅（无）'}`
      )
      lastTiles = tiles
    }
  }

  await fetch(`${HUB}/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1, device, items })
  })
  await sleep(800)

  const end = await mediaCount()
  const tilesAfter = await evaluate(`document.querySelectorAll('.tile').length`)
  const bannerAfter = await evaluate(
    `(() => { const el = document.querySelector('.sync-banner-text'); return el ? el.textContent.trim() : '' })()`
  )
  console.log('')
  console.log(`${stamp()}  最终媒体数 = ${end}（起始 ${start}，本次 ${end - start}）`)
  console.log(`${stamp()}  界面上出现的照片格子 = ${tilesAfter}（传输中最后一次采样 ${lastTiles}）`)
  console.log(`${stamp()}  横幅在传输中出现采样数 = ${bannerSamples}`)
  if (bannerText) console.log(`  横幅文案示例：${bannerText}`)
  console.log(`${stamp()}  传输结束后横幅 = ${bannerAfter ? `「${bannerAfter}」（可能刚结束还没消失）` : '已消失 ✅'}`)
}

main().catch((err) => {
  console.error('验证失败：', err)
  process.exitCode = 1
})
