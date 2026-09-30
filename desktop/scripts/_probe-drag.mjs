/**
 * 临时诊断工具：验证"按住图片拖出去"这条路真的通。
 *
 * 为什么不能进冒烟测试：真正的拖放会进入系统模态循环（`doDragDrop`），
 * 而且它需要**真实输入事件**（`Input.dispatchMouseEvent`），合成 DOM 事件骗不过浏览器。
 * 所以这里用一次性实例 + 临时数据目录单独验证这三件事：
 *   ① `<button draggable>` 在真实鼠标拖动下会不会触发 dragstart
 *   ② 渲染端 → IPC → 主进程 prepareDragFiles 有没有跑（看 tmp/drag 里有没有落出真实文件）
 *   ③ startDrag 有没有真的进入系统拖放循环（拖拽期间主进程被占住 → Hub 不再应答）
 *
 * 用法：node scripts/_probe-drag.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'

// 临时目录一律放**项目内**的 .cache/tmp —— 不用 C 盘的 %TEMP%（用户 C 盘敏感，2026-09-25 统一改）
const SCRATCH_DIR = resolve(import.meta.dirname, '..', '.cache', 'tmp')
mkdirSync(SCRATCH_DIR, { recursive: true })


const projectRoot = resolve(import.meta.dirname, '..')
const appExe = process.env.GM_SMOKE_APP
  ? resolve(projectRoot, process.env.GM_SMOKE_APP)
  : join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
const isSource = appExe.endsWith('electron.exe')

const HUB_PORT = 8796
const CDP_PORT = 9226
const dataDir = mkdtempSync(join(SCRATCH_DIR, 'gm-drag-data-'))
const srcDir = mkdtempSync(join(SCRATCH_DIR, 'gm-drag-src-'))

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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result.value
}

const hubAlive = async () => {
  try {
    const res = await fetch(`https://127.0.0.1:${HUB_PORT}/api/v1/health`, {
      signal: AbortSignal.timeout(1500)
    })
    return res.ok
  } catch {
    return false
  }
}

try {
  await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 200, g: 120, b: 90 } } })
    .jpeg()
    .toFile(join(srcDir, 'DRAG_ME_0001.jpg'))

  const spawnArgs = isSource
    ? ['.', `--remote-debugging-port=${CDP_PORT}`]
    : [`--remote-debugging-port=${CDP_PORT}`]
  child = spawn(appExe, spawnArgs, {
    cwd: projectRoot,
    env: { ...process.env, GALLERY_MIRROR_DATA: dataDir, GALLERY_MIRROR_PORT: String(HUB_PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', (chunk) => {
    const text = String(chunk)
    if (text.includes('[drag]')) console.log('  应用日志:', text.trim())
  })
  child.stderr.on('data', (chunk) => {
    const text = String(chunk)
    if (text.includes('[drag]') || /error/i.test(text)) console.log('  应用 stderr:', text.trim())
  })

  let target = null
  for (let i = 0; i < 80 && !target; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      target = list.find((t) => t.type === 'page')
    } catch {
      /* 还没起来 */
    }
    if (!target) await sleep(500)
  }
  if (!target) throw new Error('连不上 CDP')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    const handler = pending.get(msg.id)
    if (handler) {
      pending.delete(msg.id)
      handler(msg)
    }
  }
  await new Promise((r) => (ws.onopen = r))

  for (let i = 0; i < 60; i += 1) {
    const text = await evaluate(`document.body ? document.body.innerText : ''`)
    if (text && text.includes('运行中')) break
    await sleep(500)
  }
  console.log('窗口标题:', await evaluate(`document.title`))

  // 导入一张图，界面上就有格子可拖了
  const imported = JSON.parse(
    await evaluate(`window.gm.importFolder(${JSON.stringify(srcDir)}).then((p) => JSON.stringify({
      imported: p.imported, failed: p.failed
    }))`)
  )
  console.log('导入:', JSON.stringify(imported))

  let tile = null
  for (let i = 0; i < 40 && !tile; i += 1) {
    const raw = await evaluate(`(() => {
      const el = document.querySelector('.tile[data-id]');
      if (!el) return '';
      const r = el.getBoundingClientRect();
      return JSON.stringify({ x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
    })()`)
    if (raw) tile = JSON.parse(raw)
    else await sleep(500)
  }
  if (!tile || !tile.x) throw new Error('界面上没有可拖的格子')
  console.log('格子中心:', JSON.stringify(tile))

  // 真实鼠标输入：按下 → 移动（越过浏览器拖拽阈值）→ 应当触发 HTML5 dragstart
  await cdp('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: tile.x,
    y: tile.y,
    button: 'left',
    buttons: 1,
    clickCount: 1
  })
  await sleep(120)
  for (const [dx, dy] of [
    [12, 8],
    [40, 26],
    [80, 52]
  ]) {
    await cdp('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: tile.x + dx,
      y: tile.y + dy,
      button: 'left',
      buttons: 1
    })
    await sleep(120)
  }
  await sleep(600)

  // ① 中转目录里有没有落出"带原始文件名的真实文件"（= dragstart → IPC → prepareDragFiles 都通了）
  const dragRoot = join(dataDir, 'tmp', 'drag')
  let staged = []
  if (existsSync(dragRoot)) {
    for (const dir of readdirSync(dragRoot)) {
      for (const name of readdirSync(join(dragRoot, dir))) {
        const file = join(dragRoot, dir, name)
        staged.push({ name, nlink: statSync(file).nlink, size: statSync(file).size })
      }
    }
  }
  console.log('① 拖拽中转文件:', staged.length ? JSON.stringify(staged) : '（没有！dragstart 没触发）')

  // ② 拖拽期间主进程被系统拖放循环占住 → Hub 应当不应答
  const duringDrag = await hubAlive()
  console.log('② 拖拽中 Hub 是否还在应答:', duringDrag, duringDrag ? '（说明没进系统拖放循环）' : '（已被拖放循环占住，符合预期）')

  // 松手结束拖拽（万一卡住也不影响：下面照样强杀这个一次性实例）
  try {
    await Promise.race([
      cdp('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: tile.x + 80,
        y: tile.y + 52,
        button: 'left',
        buttons: 0,
        clickCount: 1
      }),
      sleep(3000)
    ])
  } catch {
    /* 忽略 */
  }
  await sleep(1500)
  const afterDrag = await hubAlive()
  console.log('③ 松手后 Hub 恢复应答:', afterDrag)
  console.log(
    afterDrag ? '结论：拖出链路（dragstart → IPC → 硬链接中转 → startDrag）走通了' : '结论：主进程仍被占住，需要人工确认真实拖拽'
  )
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
void mkdirSync
