/**
 * 验证 Tab 键切换「按日期分组 ⇄ 紧凑模式」
 * 用法：node scripts/_diag-compact.mjs [hubPort] [cdpPort]
 *
 * 检查点：
 *   ① 默认有日期标题行（.row-header）
 *   ② 按 Tab 后标题行消失、图片连续排布
 *   ③ 紧凑模式下滚动条气泡显示的日期 = 该行最左边那张图的日期
 *   ④ 再按 Tab 恢复
 *   ⑤ 设置被 localStorage 记住
 */
import { createHash } from 'node:crypto'
import sharp from 'sharp'

const HUB_PORT = Number(process.argv[2] ?? 8806)
const CDP_PORT = Number(process.argv[3] ?? 9333)
const HUB = `https://127.0.0.1:${HUB_PORT}/api/v1`
const DAYS = 6
const PER_DAY = 8

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let ws = null
let msgId = 0
const pending = new Map()

async function connectCdp() {
  const deadline = Date.now() + 30000
  let target = null
  let sawWrongApp = false
  while (Date.now() < deadline && !target) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) {
        // ⚠️ 端口可能被别的 Electron 应用占着，必须校验连到的是本应用
        if (String(page.title).includes('相册镜像')) {
          target = page
        } else {
          sawWrongApp = true
          throw new Error(`端口 ${CDP_PORT} 上的不是相册镜像，而是「${page.title}」——换端口`)
        }
      }
    } catch (err) {
      if (sawWrongApp) throw err
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

/** 状态快照：标题行数、行数、每行首图的标题（文件名里编码了天数） */
const PROBE = `(() => {
  const headers = [...document.querySelectorAll('.row-header')].map((h) => h.innerText.replace(/\\s+/g, ' ').trim())
  const rows = [...document.querySelectorAll('.vgrid-row')].map((r) => {
    const first = r.querySelector('.tile:not(.tile-empty)')
    return first ? first.getAttribute('title') : null
  }).filter(Boolean)
  const bubble = document.querySelector('.scroll-date')
  return JSON.stringify({
    headers: headers.length,
    headerSample: headers.slice(0, 3),
    rows: rows.length,
    firstRowImgs: rows.slice(0, 4),
    bubble: bubble ? bubble.textContent.trim() : null
  })
})()`

const probe = async () => JSON.parse(String(await evaluate(PROBE)))

const pressTab = async () => {
  await evaluate(
    `(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })); return true })()`
  )
  await sleep(700)
}

async function main() {
  await connectCdp()
  console.log(`已连上目标（标题校验通过）`)

  const info = await (await fetch(`${HUB}/info`)).json()
  if (info.counts.media === 0) {
    console.log(`上传 ${DAYS} 天 × ${PER_DAY} 张 ...`)
    const device = { deviceId: 'compact', name: '紧凑模式测试', model: 'C', androidVersion: '14' }
    const files = []
    for (let d = 0; d < DAYS; d += 1) {
      for (let i = 0; i < PER_DAY; i += 1) {
        const buf = await sharp({
          create: { width: 420, height: 315, channels: 3, noise: { type: 'gaussian', mean: 128, sigma: 45 } }
        })
          .jpeg({ quality: 70 })
          .toBuffer()
        const ts = Date.UTC(2026, 2, 1, 12, 0, 0) + d * 86400000 + i * 60000
        files.push({
          sha256: createHash('sha256').update(buf).digest('hex'),
          displayName: `D${String(d + 1).padStart(2, '0')}_${String(i).padStart(2, '0')}.jpg`,
          relativePath: 'DCIM/C/',
          bucketId: 'DCIM/C',
          bucketName: 'C',
          mimeType: 'image/jpeg',
          size: buf.length,
          width: 420,
          height: 315,
          dateTaken: ts,
          dateModified: ts,
          buf
        })
      }
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

  // 确保从"分组模式"开始
  await evaluate(`localStorage.setItem('gm.compactGrid','0'); location.reload(); true`)
  await sleep(4000)

  const a = await probe()
  console.log('')
  console.log(`分组模式  : 日期标题行=${a.headers}  标题示例=${JSON.stringify(a.headerSample)}`)
  console.log(`            可见行首图=${JSON.stringify(a.firstRowImgs)}`)

  await pressTab()
  const b = await probe()
  console.log('')
  console.log(`紧凑模式  : 日期标题行=${b.headers}  ${b.headers === 0 ? '✅ 标题已隐藏' : '❌ 标题还在'}`)
  console.log(`            可见行首图=${JSON.stringify(b.firstRowImgs)}`)
  console.log(`            滚动条气泡 = ${b.bubble ?? '(无)'}`)

  // 交叉验证：气泡显示的日期 vs 该行最左边那张图的日期（文件名编码了天数）
  const dayFromName = b.firstRowImgs[0] ? Number(String(b.firstRowImgs[0]).slice(1, 3)) : null
  if (dayFromName && b.bubble) {
    const expectedDay = 1 + dayFromName - 1
    const expectedDate = new Date(Date.UTC(2026, 2, expectedDay, 12, 0, 0))
    const expectText = `${expectedDate.getUTCMonth() + 1}月${expectedDate.getUTCDate()}日`
    const ok = b.bubble.includes(expectText)
    console.log(`            交叉验证：首图 ${b.firstRowImgs[0]} 应为「${expectText}」→ 气泡「${b.bubble}」 ${ok ? '✅ 一致' : '❌ 不符'}`)
  }

  await pressTab()
  const c = await probe()
  console.log('')
  console.log(`再按 Tab  : 日期标题行=${c.headers}  ${c.headers > 0 ? '✅ 已恢复分组' : '❌ 没恢复'}`)
  console.log(`localStorage = ${await evaluate("localStorage.getItem('gm.compactGrid')")}`)
}

main().catch((e) => {
  console.error('失败：', e.message)
  process.exitCode = 1
})
