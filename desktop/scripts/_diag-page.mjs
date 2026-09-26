/** 页面状态探针：dump 界面文字 + 元素计数 + 渲染进程错误 */
const CDP_PORT = Number(process.argv[2] ?? 9229)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let ws = null
let msgId = 0
const pending = new Map()
const errors = []

const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
const target = list.find((t) => t.type === 'page')
ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = () => rej(new Error('ws fail'))
  setTimeout(() => rej(new Error('ws timeout')), 8000)
})
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params?.exceptionDetails
    errors.push(`EXCEPTION: ${d?.exception?.description || d?.text || ''}`)
  }
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params?.type)) {
    errors.push(`${m.params.type.toUpperCase()}: ${(m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')}`)
  }
  const h = pending.get(m.id)
  if (h) {
    pending.delete(m.id)
    h(m)
  }
}

function send(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++msgId
    const timer = setTimeout(() => {
      pending.delete(id)
      rej(new Error(`${method} 超时`))
    }, 8000)
    pending.set(id, (m) => {
      clearTimeout(timer)
      res(m)
    })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

const ev = (expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true }).then((r) => r.result?.result?.value)

await send('Runtime.enable')
await sleep(1200)

console.log('body 文字    :', String(await ev('document.body.innerText.replace(/\\s+/g, " ").slice(0, 260)')))
console.log('--- 元素计数 ---')
for (const [name, sel] of [
  ['.grid-wrap', '.grid-wrap'],
  ['.vgrid', '.vgrid'],
  ['.vgrid-inner', '.vgrid-inner'],
  ['.vgrid-row', '.vgrid-row'],
  ['.tile', '.tile'],
  ['.empty-state', '.empty-state']
]) {
  console.log(`  ${name.padEnd(14)} = ${await ev(`document.querySelectorAll('${sel}').length`)}`)
}
console.log('网格容器宽度 :', await ev(`(() => { const e = document.querySelector('.grid-wrap'); return e ? e.clientWidth : -1 })()`))
console.log('localStorage :', String(await ev(`localStorage.getItem('gm.cellSize')`)))
console.log('')
console.log('--- 渲染进程错误/警告 ---')
if (errors.length === 0) console.log('  （无）')
else for (const e of errors.slice(0, 8)) console.log('  ' + e.slice(0, 300))
process.exit(0)
