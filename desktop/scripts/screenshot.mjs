#!/usr/bin/env node
/**
 * 自动截图各页面，用于检查界面效果。
 * 用法：node scripts/screenshot.mjs [输出目录]
 * 可选：GM_SCREENSHOT_DATA 指定数据目录（默认项目 .data）
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const isWindows = process.platform === 'win32'
const electronExe = join(projectRoot, 'node_modules', 'electron', 'dist', isWindows ? 'electron.exe' : 'electron')
const outDir = resolve(process.argv[2] ?? join(projectRoot, '.screenshots'))
const CDP_PORT = 9333
const HUB_PORT = 8899

mkdirSync(outDir, { recursive: true })
if (!existsSync(join(projectRoot, 'out', 'main', 'index.js'))) {
  console.error('缺少构建产物，请先 npm.cmd run build')
  process.exit(1)
}

const child = spawn(electronExe, ['.', `--remote-debugging-port=${CDP_PORT}`], {
  cwd: projectRoot,
  env: {
    ...process.env,
    GALLERY_MIRROR_PORT: String(HUB_PORT),
    ...(process.env.GM_SCREENSHOT_DATA ? { GALLERY_MIRROR_DATA: process.env.GM_SCREENSHOT_DATA } : {})
  },
  stdio: ['ignore', 'pipe', 'pipe']
})
child.stdout.on('data', () => {})
child.stderr.on('data', () => {})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, timeout = 30000, interval = 250) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch {
      /* retry */
    }
    await sleep(interval)
  }
  throw new Error('等待超时')
}

let ws = null
try {
  const target = await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
    if (!res.ok) return null
    const list = await res.json()
    return list.find((t) => t.type === 'page') ?? null
  })

  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = () => res()
    ws.onerror = () => rej(new Error('CDP 连接失败'))
  })

  let msgId = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    const handler = pending.get(msg.id)
    if (handler) {
      pending.delete(msg.id)
      handler(msg)
    }
  }
  const cdp = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++msgId
      pending.set(id, (msg) => (msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)))
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result.value
  }

  await waitFor(async () => {
    const text = await evaluate('document.body ? document.body.innerText : ""')
    return text && text.includes('运行中') ? text : null
  }, 40000)
  await sleep(1200)

  const shot = async (name, waitMs = 900) => {
    await sleep(waitMs)
    const { data } = await cdp('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(outDir, `${name}.png`), Buffer.from(data, 'base64'))
    console.log(`saved ${name}.png`)
  }

  const clickNav = (index) => evaluate(`document.querySelectorAll('.nav-item')[${index}].click(); true`)

  await shot('01-timeline')

  await clickNav(1)
  await shot('02-albums')

  await clickNav(2)
  await shot('03-favorites')

  await clickNav(4)
  await shot('04-devices')

  await clickNav(5)
  await shot('05-settings')

  await clickNav(0)
  await sleep(800)
  const opened = await evaluate(`(() => { const t = document.querySelector('.tile:not(.tile-empty)'); if (!t) return false; t.click(); return true; })()`)
  if (opened) await shot('06-viewer', 1600)

  console.log(`截图完成：${outDir}`)
} catch (err) {
  console.error('截图失败：', err instanceof Error ? err.message : err)
} finally {
  try {
    ws?.close()
  } catch {
    /* ignore */
  }
  if (isWindows) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill('SIGKILL')
}
