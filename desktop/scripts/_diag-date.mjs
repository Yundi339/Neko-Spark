/**
 * 验证「日期气泡跟着滚动条滑块跑」：
 *   ① 气泡位置随滚动单调下移（= 跟着滑块）
 *   ② 气泡显示的日期 == 气泡中线那一行「最左边那张图」的日期
 *   ③ 停止滚动 1.5 秒后消失
 *
 * 手法：文件名里编码天数（D01_03.jpg = 第 1 天第 3 张），
 *       于是可以独立读出「那一行最左边的图是哪天」再和气泡文案对比。
 *
 * 用法：node scripts/_diag-date.mjs
 */
import { createHash } from 'node:crypto'
import sharp from 'sharp'

const HUB = 'http://127.0.0.1:8801/api/v1'
const CDP = 9225
const DAYS = 24
const PER_DAY = 10
const BASE = Date.UTC(2026, 0, 5, 12, 0, 0) // 2026-01-05 起，每天一组

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

function evaluate(expression, timeoutMs = 5000) {
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

/** 和 src/renderer/src/utils/format.ts 的 formatDate 一致 */
function expectedLabel(dayIndex) {
  const d = new Date(BASE + dayIndex * 86400000)
  const now = new Date()
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
  const base =
    d.getFullYear() === now.getFullYear()
      ? `${d.getMonth() + 1}月${d.getDate()}日`
      : `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`
  return `${base} ${week}`
}

const READ_PROBE = `(() => {
  const bubble = document.querySelector('.scroll-date')
  if (!bubble) return { label: null }
  const br = bubble.getBoundingClientRect()
  const y = br.top + br.height / 2
  const row = [...document.querySelectorAll('.tile')]
    .map(t => ({ t, r: t.getBoundingClientRect() }))
    .filter(o => o.r.width > 20 && o.r.height > 20 && y >= o.r.top - 1 && y <= o.r.bottom + 1)
  row.sort((a, b) => a.r.left - b.r.left)
  return {
    label: bubble.textContent.trim(),
    bubbleTop: parseFloat(bubble.style.top) || 0,
    y: Math.round(y),
    gridTop: Math.round(document.querySelector('.vgrid').getBoundingClientRect().top),
    leftmostTitle: row[0] ? row[0].t.getAttribute('title') : null,
    rowPhotos: row.length
  }
})()`

async function main() {
  await connectCdp()
  console.log('CDP 已连接\n')

  console.log(`生成并上传 ${DAYS} 天 × ${PER_DAY} 张 = ${DAYS * PER_DAY} 张...`)
  const device = { deviceId: 'date-phone', name: '日期验证机', model: 'Date', androidVersion: '14' }
  const files = []
  const existing = await (await fetch(`${HUB}/info`)).json()
  if (existing.counts.media >= DAYS * PER_DAY) {
    console.log(`（电脑端已有 ${existing.counts.media} 项，跳过上传，直接验证）\n`)
    return verify()
  }
  for (let d = 0; d < DAYS; d += 1) {
    for (let i = 0; i < PER_DAY; i += 1) {
      const buf = await sharp({
        create: {
          width: 700,
          height: 525,
          channels: 3,
          noise: { type: 'gaussian', mean: 128, sigma: 55 }
        }
      })
        .jpeg({ quality: 80 })
        .toBuffer()
      const ts = BASE + d * 86400000 + i * 60000
      files.push({
        sha256: createHash('sha256').update(buf).digest('hex'),
        displayName: `D${String(d + 1).padStart(2, '0')}_${String(i).padStart(2, '0')}.jpg`,
        relativePath: 'DCIM/DateTest/',
        bucketId: 'DCIM/DateTest',
        bucketName: 'DateTest',
        mimeType: 'image/jpeg',
        size: buf.length,
        width: 700,
        height: 525,
        dateTaken: ts,
        dateModified: ts,
        buf
      })
    }
  }
  const items = files.map(({ buf, ...r }) => r)
  await fetch(`${HUB}/manifest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1, device, items })
  })
  for (const f of files) {
    await fetch(`${HUB}/blob/${f.sha256}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg', 'Content-Range': `bytes 0-${f.size - 1}/${f.size}` },
      body: f.buf
    })
  }
  await fetch(`${HUB}/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1, device, items })
  })
  console.log('上传完成，等待界面刷新...\n')
  await sleep(2500)
  await verify()
}

async function verify() {
  const vis = await evaluate(
    `JSON.stringify({ hidden: document.hidden, state: document.visibilityState })`
  )
  console.log(`窗口可见性 = ${vis}`)
  console.log('（窗口被遮挡时 Chromium 不派发 scroll 事件，脚本会补合成事件）\n')

  const maxScroll = await evaluate(
    `(() => { const g = document.querySelector('.vgrid'); return g ? Math.max(0, g.scrollHeight - g.clientHeight) : 0 })()`
  )
  console.log(`可滚动高度 = ${maxScroll}px\n`)

  console.log('  ── 逐个滚动位置检查 ──')
  let prevTop = -1
  let monotonic = true
  let mismatches = 0
  let checked = 0

  for (let p = 0; p <= 100; p += 20) {
    const target = Math.round((maxScroll * p) / 100)
    // 窗口被遮挡时 Chromium 不派发 scroll 事件，这里补一次合成事件——
    // 触发的是 React 同一个 onScroll 处理函数，逻辑路径完全一致
    await evaluate(
      `(() => {
         const g = document.querySelector('.vgrid')
         g.scrollTop = ${target}
         g.dispatchEvent(new Event('scroll'))
         return true
       })()`
    )
    await sleep(260)

    const probe = await evaluate(READ_PROBE)
    if (!probe || !probe.label) {
      console.log(`  ${String(p).padStart(3)}%  scrollTop=${String(target).padStart(5)}  →  气泡未显示`)
      continue
    }
    if (probe.bubbleTop < prevTop - 1) monotonic = false
    prevTop = probe.bubbleTop

    const dayFromTitle = probe.leftmostTitle ? Number(probe.leftmostTitle.slice(1, 3)) : null
    const expected = dayFromTitle ? expectedLabel(dayFromTitle - 1) : null
    const ok = expected === probe.label
    if (expected) {
      checked += 1
      if (!ok) mismatches += 1
    }
    console.log(
      `  ${String(p).padStart(3)}%  scrollTop=${String(target).padStart(5)}  气泡top=${String(Math.round(probe.bubbleTop)).padStart(4)}  显示「${probe.label}」  该行最左图=${probe.leftmostTitle ?? '?'}  ${expected ? (ok ? '✅ 一致' : `❌ 应为「${expected}」`) : '（未取到，跳过比对）'}`
    )
  }

  console.log('')
  console.log(`  气泡位置随滚动单调下移：${monotonic ? '✅ 是' : '❌ 否'}`)
  console.log(`  日期比对：共 ${checked} 次，${checked - mismatches} 次一致，${mismatches} 次不一致`)

  // 停止滚动后是否 1.5 秒消失
  await evaluate(`(() => { const g = document.querySelector('.vgrid'); g.scrollTop = ${Math.round(maxScroll * 0.4)}; return true })()`)
  await sleep(300)
  const during = await evaluate(`!!document.querySelector('.scroll-date')`)
  await sleep(2000)
  const after = await evaluate(`!!document.querySelector('.scroll-date')`)
  console.log('')
  console.log(`  滚动中气泡存在 = ${during}，停下 2 秒后存在 = ${after}  →  ${during && !after ? '✅ 符合预期（滚动显示、停下消失）' : '❌ 不符合预期'}`)
}

main().catch((e) => {
  console.error('验证失败：', e)
  process.exitCode = 1
})
