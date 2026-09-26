/** 紧凑模式下：滚动条气泡显示的日期 == 该行最左边那张图的日期 */
const HUB_PORT = Number(process.argv[2] ?? 8806)
const CDP_PORT = Number(process.argv[3] ?? 9333)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let ws = null
let msgId = 0
const pending = new Map()

const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
const target = list.find((t) => t.type === 'page' && String(t.title).includes('相册镜像'))
if (!target) throw new Error(`端口 ${CDP_PORT} 上找不到相册镜像（标题校验失败）`)

ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = () => rej(new Error('ws fail'))
  setTimeout(() => rej(new Error('ws timeout')), 8000)
})
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  const h = pending.get(m.id)
  if (h) {
    pending.delete(m.id)
    h(m)
  }
}
const ev = (expr, ms = 8000) => {
  const id = ++msgId
  return new Promise((res, rej) => {
    const t = setTimeout(() => {
      pending.delete(id)
      rej(new Error('timeout'))
    }, ms)
    pending.set(id, (m) => {
      clearTimeout(t)
      res(m.result?.result?.value)
    })
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true } }))
  })
}

// 切到紧凑模式并重新加载
await ev(`localStorage.setItem('gm.compactGrid','1'); location.reload(); true`)
await sleep(5000)

const maxScroll = Number(await ev(`(() => { const g = document.querySelector('.vgrid'); return g ? g.scrollHeight - g.clientHeight : 0 })()`))
console.log(`可滚动高度 = ${maxScroll}px（紧凑模式）`)

const READ = `(() => {
  const bubble = document.querySelector('.scroll-date')
  if (!bubble) return JSON.stringify({ bubble: null })
  const br = bubble.getBoundingClientRect()
  const y = br.top + br.height / 2
  const row = [...document.querySelectorAll('.tile:not(.tile-empty)')]
    .map(t => ({ t, r: t.getBoundingClientRect() }))
    .filter(o => o.r.width > 20 && y >= o.r.top - 1 && y <= o.r.bottom + 1)
    .sort((a, b) => a.r.left - b.r.left)
  return JSON.stringify({ bubble: bubble.textContent.trim(), leftmost: row[0] ? row[0].t.getAttribute('title') : null, rowCount: row.length })
})()`

let ok = 0
let total = 0
for (let p = 0; p <= 100; p += 25) {
  const targetScroll = Math.round((maxScroll * p) / 100)
  await ev(`(() => { const g = document.querySelector('.vgrid'); g.scrollTop = ${targetScroll}; g.dispatchEvent(new Event('scroll')); return true })()`)
  await sleep(300)
  const r = JSON.parse(String(await ev(READ)))
  if (!r.bubble) {
    console.log(`  ${String(p).padStart(3)}%  气泡未显示`)
    continue
  }
  const day = r.leftmost ? Number(String(r.leftmost).slice(1, 3)) : null
  let verdict = '（未取到首图，跳过）'
  if (day) {
    const d = new Date(Date.UTC(2026, 2, day, 12, 0, 0))
    const expect = `${d.getUTCMonth() + 1}月${d.getUTCDate()}日`
    total += 1
    const match = r.bubble.includes(expect)
    if (match) ok += 1
    verdict = match ? '✅ 一致' : `❌ 应为「${expect}」`
  }
  console.log(`  ${String(p).padStart(3)}%  气泡「${r.bubble}」  该行最左图=${r.leftmost ?? '?'}  ${verdict}`)
}

console.log('')
console.log(`交叉验证：${ok}/${total} 一致`)
process.exit(0)
