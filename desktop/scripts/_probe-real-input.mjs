/**
 * 用**真实输入事件**验证相册视图的两件事（合成 DOM 事件骗不过浏览器，这里走 CDP 的 Input 域）：
 *   ① Ctrl + 滚轮能不能放大/缩小相册卡片（Input.dispatchMouseEvent type=mouseWheel, modifiers=2=Ctrl）
 *   ② 相册详情里按**下侧键**能不能退回相册列表（Input.dispatchMouseEvent button=forward → DOM button 4）
 * 临时实例（独立数据目录 / 端口 / CDP），跑完删干净，不碰用户数据。
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// 临时目录一律放**项目内**的 .cache/tmp —— 不用 C 盘的 %TEMP%（用户 C 盘敏感，2026-09-25 统一改）
const SCRATCH_DIR = resolve(import.meta.dirname, '..', '.cache', 'tmp')
mkdirSync(SCRATCH_DIR, { recursive: true })


const projectRoot = resolve(import.meta.dirname, '..')
const appExe = join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
const sharp = (await import('sharp')).default

const HUB_PORT = 8797
const CDP_PORT = 9333
const dataDir = mkdtempSync(join(SCRATCH_DIR, 'gm-album-data-'))
const srcDir = mkdtempSync(join(SCRATCH_DIR, 'gm-album-src-'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let child = null
let ws = null
let msgId = 0
const pending = new Map()
const cdp = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++msgId
    pending.set(id, (msg) => (msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })
async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) {
    const detail = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text
    throw new Error(`${detail}\n    出错表达式: ${expression.slice(0, 120)}`)
  }
  return r.result.value
}
async function waitFor(fn, timeoutMs, everyMs = 300) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const v = await fn()
    if (v) return v
    await sleep(everyMs)
  }
  return null
}

try {
  // 造两个"相册"（文件夹），每个放一张图
  for (const name of ['Alpha', 'Beta']) {
    mkdirSync(join(srcDir, name), { recursive: true })
    await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 120, g: 160, b: 200 } } })
      .jpeg()
      .toFile(join(srcDir, name, `${name}.jpg`))
  }

  child = spawn(appExe, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: projectRoot,
    env: { ...process.env, GALLERY_MIRROR_DATA: dataDir, GALLERY_MIRROR_PORT: String(HUB_PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})

  let page = null
  for (let i = 0; i < 80 && !page; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      page = list.find((t) => t.type === 'page')
    } catch {
      /* 还没起来 */
    }
    if (!page) await sleep(500)
  }
  if (!page) throw new Error('连不上 CDP')
  ws = new WebSocket(page.webSocketDebuggerUrl)
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data)
    const h = pending.get(msg.id)
    if (h) {
      pending.delete(msg.id)
      h(msg)
    }
  }
  await new Promise((r) => (ws.onopen = r))
  await cdp('Runtime.enable')
  console.log('已连上的窗口标题:', await evaluate(`document.title`), '(必须是 GalleryMirror，否则端口被别的程序占了)')
  for (let i = 0; i < 60; i += 1) {
    const t = await evaluate(`document.body ? document.body.innerText : ''`)
    if (t && t.includes('运行中')) break
    await sleep(500)
  }

  const imported = JSON.parse(
    await evaluate(`window.gm.importFolder(${JSON.stringify(srcDir)}).then((p) => JSON.stringify({ imported: p.imported }))`)
  )
  console.log('导入:', JSON.stringify(imported))

  // 进"相册"tab
  await evaluate(`document.querySelectorAll('.nav-item')[1].click(); true`)
  const hasCards = await waitFor(async () => ((await evaluate(`document.querySelectorAll('.album-card').length>0`)) ? true : null), 15000)
  console.log('相册卡片已出现:', hasCards === true)

  const cardBox = JSON.parse(
    await evaluate(`(() => {
      const c = document.querySelector('.album-card');
      const r = c.getBoundingClientRect();
      return JSON.stringify({ w: Math.round(r.width), h: Math.round(r.height), x: r.left + r.width/2, y: r.top + r.height/2 })
    })()`)
  )
  console.log('缩放前卡片宽度:', cardBox.w, 'px')

  // ① 真实 Ctrl + 滚轮（modifiers: 2 = Ctrl）
  await cdp('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: Math.round(cardBox.x),
    y: Math.round(cardBox.y),
    deltaX: 0,
    deltaY: -120,
    modifiers: 2
  })
  await sleep(400)
  const afterWheel = JSON.parse(
    await evaluate(`(() => { const c = document.querySelector('.album-card'); return JSON.stringify({ w: Math.round(c.getBoundingClientRect().width) }) })()`)
  )
  console.log(`① 真实 Ctrl+滚轮：${cardBox.w}px → ${afterWheel.w}px  ${afterWheel.w > cardBox.w ? '✅ 能放大' : '❌ 没变化'}`)

  // ② 真实"下侧键"（CDP 的 button=forward → 页面收到 DOM button 4 的 mouseup）
  await evaluate(`document.querySelector('.album-card').click(); true`)
  const entered = await waitFor(async () => ((await evaluate(`!!document.querySelector('.title-with-back')`)) ? true : null), 10000)
  console.log('进入相册详情:', entered === true)
  await sleep(400)
  const t = await evaluate(`(document.querySelector('.viewer') ? 'viewer' : document.querySelector('.title-with-back') ? 'albumDetail' : 'other')`)
  console.log('按下侧键前所在层次:', t)
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 700, y: 400, button: 'forward', clickCount: 1 })
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 700, y: 400, button: 'forward', clickCount: 1 })
  const backToList = await waitFor(
    async () =>
      (await evaluate(`document.querySelectorAll('.album-card').length > 0 && !document.querySelector('.title-with-back')`))
        ? true
        : null,
    6000
  )
  console.log(`② 真实下侧键退回相册列表：${backToList ? '✅ 成功' : '❌ 没反应'}`)

  // ③ 用户说的"两级进去"：相册详情 → 点开里面的一张图（查看器）→ 按下侧键应当关掉查看器
  await evaluate(`document.querySelector('.album-card').click(); true`)
  await waitFor(async () => ((await evaluate(`!!document.querySelector('.title-with-back')`)) ? true : null), 10000)
  await sleep(400)
  const tileClicked = await evaluate(`(() => { const t = document.querySelector('.tile[data-id]'); if (!t) return false; t.click(); return true })()`)
  const viewerOpen = await waitFor(async () => ((await evaluate(`!!document.querySelector('.viewer')`)) ? true : null), 10000)
  console.log('③ 相册详情里点开一张图：', tileClicked && viewerOpen ? '查看器已打开' : '没打开')
  await sleep(400)
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 700, y: 400, button: 'forward', clickCount: 1 })
  await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 700, y: 400, button: 'forward', clickCount: 1 })
  const viewerClosed = await waitFor(async () => ((await evaluate(`!document.querySelector('.viewer')`)) ? true : null), 6000)
  console.log(`③ 真实下侧键关掉查看器：${viewerClosed ? '✅ 成功' : '❌ 没反应'}`)
} catch (err) {
  console.log('探针出错:', err instanceof Error ? err.message : String(err))
} finally {
  try {
    ws?.close()
  } catch {
    /* 忽略 */
  }
  if (child?.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  await sleep(500)
  for (const dir of [dataDir, srcDir]) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 忽略 */
    }
  }
}
