/**
 * 滚动流畅度体检（判据按高刷屏 179Hz 的 ~5.6ms 帧预算来；60Hz 屏可自行放宽）。
 *
 * 做法：把真实库的 manifest.db + thumbs 拷进临时数据目录（几十 MB，不碰 36GB blobs），
 * 起临时实例 → 提到前台（窗口被遮挡时 Chromium 不产帧，量出来是假的）→
 * 用 **CDP 真实滚轮事件**快速上下滚（不等回包，能到 ~200 笔/秒），页面里记录 rAF 帧间隔；
 * 同时用 CDP 的 CPU Profiler 抓这段时间的**自耗时排行**，直接指出热函数。
 *
 * 两种模式都测：默认（有日期标题行）与 **紧凑模式（按 Tab）**。
 *
 * 用法: node scripts/_perf-scroll.mjs [--seconds 4] [--no-profile]
 */
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

// ⚠️ 清掉代理环境变量：本机跑打包时会 export HTTPS_PROXY，而 Node 的 WebSocket 连 127.0.0.1 也会走代理，
// 于是探针永远「连不上 CDP」（2026-09-25 踩过）。子进程 Electron 也不需要代理。
for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'GLOBAL_AGENT_HTTP_PROXY', 'GLOBAL_AGENT_HTTPS_PROXY']) {
  delete process.env[k]
}
process.env.NO_PROXY = '127.0.0.1,localhost'

const projectRoot = resolve(import.meta.dirname, '..')
/** 仓库根 = desktop/ 的上一级。相册库 GalleryMirrorData 留在仓库根，不跟电脑端走 */
const repoRoot = resolve(projectRoot, '..')
const appExe = join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
const REAL_DATA = join(repoRoot, 'GalleryMirrorData')

const args = process.argv.slice(2)
const flag = (name, def) => {
  const at = args.indexOf(`--${name}`)
  return at >= 0 && args[at + 1] ? Number(args[at + 1]) : def
}
const SECONDS = flag('seconds', 4)
const PROFILE = !args.includes('--no-profile')
const HIDE_IMAGES = args.includes('--hide-images')
const SMALL_SRC = args.includes('--small-src')
const SPEED = flag('speed', 4800)
const CSS = (() => { const at = args.indexOf('--css'); return at >= 0 ? args[at + 1] : '' })()
const CSS_SNIPPETS = {
  hover: '.tile { transition: none !important } .tile:hover { transform: none !important; box-shadow: none !important; border-color: #e6f1fd !important }',
  radius: '.tile { border-radius: 0 !important }',
  contain: '.tile { contain: layout paint style !important }',
  lines: '.vgrid-row { contain: layout paint style !important }',
  all: '.tile { transition: none !important; border-radius: 0 !important; contain: layout paint style !important } .tile:hover { transform: none !important; box-shadow: none !important } .vgrid-row { contain: layout paint style !important }'
}
const SMALL_URI = "data:image/webp;base64,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"

const HUB_PORT = 8795
const CDP_PORT = 9336
const dataDir = mkdtempSync(join(projectRoot, '.cache', 'tmp', 'gm-perfscroll-'))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let child = null
let ws = null
let msgId = 0
const pending = new Map()
/** 等回包（要结果的调用） */
const cdp = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++msgId
    pending.set(id, (msg) => (msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })
/** 只发不等（滚轮高频驱动用 —— await 每次都等 IPC 就只有十几笔/秒，根本不算"快滑"） */
const cdpFire = (method, params = {}) => ws.send(JSON.stringify({ id: ++msgId, method, params }))
async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

/** 装探针 → 滚动 → 收报告 */
async function measureScroll(label) {
  await evaluate(`(() => {
    window.__perf = { frames: [], longtasks: [] };
    let last = performance.now();
    const tick = (now) => { window.__perf.frames.push(now - last); last = now; window.__perf.raf = requestAnimationFrame(tick) };
    window.__perf.raf = requestAnimationFrame(tick);
    try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.longtasks.push(Math.round(e.duration)) }).observe({ entryTypes: ['longtask'] }) } catch (e) {}
    return true;
  })()`)
  await sleep(200)
  if (PROFILE) await cdp('Profiler.enable').catch(() => undefined)
  if (PROFILE) await cdp('Profiler.start').catch(() => undefined)

  const t0 = Date.now()
  let sent = 0
  let down = true
  while (Date.now() - t0 < SECONDS * 1000) {
    // 每 ~5ms 发两笔 120px 的滚轮；每 1.2 秒换向，模拟快速上下滑
    if (Math.floor((Date.now() - t0) / 1200) % 2 === 1) down = false
    else down = true
    for (let k = 0; k < 1; k += 1) cdpFire('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 450, deltaX: 0, deltaY: down ? 120 : -120, modifiers: 0 })
    sent += 1
    await sleep(Math.max(4, Math.round(120000 / SPEED)))
  }
  await sleep(200)
  const profile = PROFILE ? await cdp('Profiler.stop').catch(() => null) : null
  const report = JSON.parse(
    await evaluate(`(() => {
      cancelAnimationFrame(window.__perf.raf);
      const all = window.__perf.frames.slice(5);
      const f = [...all].sort((a, b) => a - b);
      const q = (p) => Number((f[Math.min(f.length - 1, Math.floor(f.length * p))] || 0).toFixed(2));
      return JSON.stringify({
        frames: all.length,
        p50: q(0.5), p90: q(0.9), p99: q(0.99), max: Number((f[f.length - 1] || 0).toFixed(1)),
        over8: all.filter((d) => d > 8).length,
        over11: all.filter((d) => d > 11).length,
        over17: all.filter((d) => d > 17).length,
        bigAt: all.map((d, i) => (d > 17 ? i : -1)).filter((i) => i >= 0).slice(0, 8),
        tiles: document.querySelectorAll('.tile').length,
        imgs: document.querySelectorAll('.tile img').length,
        cell: (() => { const t = document.querySelector('.tile'); return t ? Math.round(t.getBoundingClientRect().width) : 0 })()
      });
    })()`)
  )
  console.log(`\n===== ${label} =====`)
  console.log(`滚轮发出 ${sent} 笔 / ${SECONDS}s（≈${Math.round(sent / SECONDS)} 笔/秒）`)
  console.log(`渲染格子 ${report.tiles} 个（其中带图 ${report.imgs}）  格子边长 ${report.cell}px`)
  console.log(`帧数 ${report.frames}   间隔 p50=${report.p50} p90=${report.p90} p99=${report.p99} max=${report.max} ms   （高刷屏理想 5.59）`)
  console.log(`掉帧: >8ms ${report.over8}   >11ms ${report.over11}   >17ms ${report.over17}`)
  console.log(`长帧(>17ms)出现在第 ${(report.bigAt || []).join(', ')} 帧 / 共 ${report.frames}（前 5% = ${Math.round(report.frames * 0.05)}）`)
  if (profile?.profile) {
    const byId = new Map()
    for (const n of profile.profile.nodes) byId.set(n.id, n)
    const self = new Map()
    const total = profile.profile.endTime - profile.profile.startTime
    const counts = new Map()
    for (const id of profile.profile.samples ?? []) counts.set(id, (counts.get(id) ?? 0) + 1)
    for (const [id, c] of counts) {
      const node = byId.get(id)
      if (!node) continue
      const f = node.callFrame
      const name = `${f.functionName || '(匿名)'} @ ${(f.url || '').split('/').pop()}:${f.lineNumber + 1}`
      self.set(name, (self.get(name) ?? 0) + c)
    }
    const totalSamples = [...counts.values()].reduce((s, c) => s + c, 0)
    const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)
    console.log(`CPU 采样 ${totalSamples} 个，热点（自耗时占比）:`)
    for (const [name, c] of top) console.log(`   ${((c / totalSamples) * 100).toFixed(1)}%  ${name}`)
    void total
  }
  return report
}

try {
  mkdirSync(dataDir, { recursive: true })
  cpSync(join(REAL_DATA, 'manifest.db'), join(dataDir, 'manifest.db'))
  cpSync(join(REAL_DATA, 'thumbs'), join(dataDir, 'thumbs'), { recursive: true })
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
  for (let i = 0; i < 80; i += 1) {
    const t = await evaluate(`document.body ? document.body.innerText : ''`)
    if (t.includes('项媒体')) break
    await sleep(500)
  }
  await cdp('Page.bringToFront').catch(() => undefined)
  await sleep(600)
  console.log('窗口:', await evaluate(`JSON.stringify({ win: innerWidth + 'x' + innerHeight, dpr: devicePixelRatio })`))

  // 缩放调到最小档（真实 Ctrl+滚轮）
  for (let i = 0; i < 12; i += 1) {
    await cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 700, y: 450, deltaX: 0, deltaY: 120, modifiers: 2 })
    await sleep(50)
  }
  await sleep(400)

if (HIDE_IMAGES) {
    await evaluate(`(() => { const st = document.createElement('style'); st.textContent = '.tile img { display: none !important }'; document.head.appendChild(st); return true })()`)
    await sleep(600)
    console.log('（已注入 CSS：隐藏所有格子里的图片）')
  }
  if (SMALL_SRC) {
    await evaluate(`(() => {
      const uri = ${JSON.stringify(SMALL_URI)};
      const patch = (root) => { root.querySelectorAll('img').forEach((im) => { if (im.src !== uri) im.src = uri }) };
      patch(document);
      new MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) patch(n) }).observe(document.body, { childList: true, subtree: true });
      return true;
    })()`)
    await sleep(600)
    console.log('（已注入：所有格子图（含新滚进来的）都换成 128px 小图源）')
  }
  await measureScroll(HIDE_IMAGES ? 'A/B：隐藏图片后' : '① 普通模式（有日期标题行）')

  // 按 Tab 切紧凑模式（真实按键）
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 })
  await sleep(800)
  console.log('\n已按 Tab 切换（紧凑模式）')
  await measureScroll('② 紧凑模式（Tab，无日期标题行）')
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
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}
