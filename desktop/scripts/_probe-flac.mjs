/**
 * 临时诊断工具：验证「**Hi-Res FLAC 音轨的视频在应用里能不能播**」。
 *
 * 背景（2026-09-24）：用户提出"有些视频的音频是 flac，要可以播放"。
 * 库里扫过一遍没有 FLAC（全是 AAC），用户给的真实样本是 B 站「4K 无损原画 + Hi-Res 无损音质」的
 * 那种 MP4 —— **AV1 视频轨 + FLAC 音轨**。实测 Chromium 原生就能解，本探针就是在**真应用里**
 * 再确认一次：真的播起来、音频字节真的在涨。
 *
 * 做法：把样本复制到临时目录 → 起一个全新的临时实例（独立数据目录 / 端口 / CDP）→ 导入 →
 * 点开查看器 → 播 4 秒 → 读 `webkit{Audio,Video}DecodedByteCount`。跑完删临时目录，不碰用户数据。
 *
 * 用法：
 *   node scripts/_probe-flac.mjs "E:\QQ\某个视频.mp4"
 *   不给参数时，用环境变量 GM_SOURCE_FILE；都没有就报错（不猜路径）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'

// 临时目录一律放**项目内**的 .cache/tmp —— 不用 C 盘的 %TEMP%（用户 C 盘敏感，2026-09-25 统一改）
const SCRATCH_DIR = resolve(import.meta.dirname, '..', '.cache', 'tmp')
mkdirSync(SCRATCH_DIR, { recursive: true })


const projectRoot = resolve(import.meta.dirname, '..')
const appExe = join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')

const source = process.argv[2] || process.env.GM_SOURCE_FILE
if (!source) {
  console.log('用法: node scripts/_probe-flac.mjs "<视频路径>"')
  process.exit(1)
}
if (!existsSync(source)) {
  console.log(`找不到文件: ${source}`)
  process.exit(1)
}

const HUB_PORT = 8796
const CDP_PORT = 9228
const dataDir = mkdtempSync(join(SCRATCH_DIR, 'gm-flac-data-'))
const srcDir = mkdtempSync(join(SCRATCH_DIR, 'gm-flac-src-'))

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

async function waitFor(fn, timeoutMs, everyMs = 500) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await sleep(everyMs)
  }
  return null
}

let ok = false
try {
  const name = basename(source)
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '.mp4'
  const target = join(srcDir, `FLAC_SAMPLE${ext}`)
  copyFileSync(source, target)
  console.log(`样本: ${name}`)
  console.log(`      ${(statSync(source).size / 1048576).toFixed(1)}MB → ${target}`)

  child = spawn(appExe, ['.', `--remote-debugging-port=${CDP_PORT}`], {
    cwd: projectRoot,
    env: { ...process.env, GALLERY_MIRROR_DATA: dataDir, GALLERY_MIRROR_PORT: String(HUB_PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})

  let targetPage = null
  for (let i = 0; i < 80 && !targetPage; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      targetPage = list.find((t) => t.type === 'page')
    } catch {
      /* 还没起来 */
    }
    if (!targetPage) await sleep(500)
  }
  if (!targetPage) throw new Error('连不上 CDP')
  ws = new WebSocket(targetPage.webSocketDebuggerUrl)
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    const handler = pending.get(msg.id)
    if (handler) {
      pending.delete(msg.id)
      handler(msg)
    }
  }
  await new Promise((r) => (ws.onopen = r))
  await cdp('Runtime.enable')

  for (let i = 0; i < 60; i += 1) {
    const text = await evaluate(`document.body ? document.body.innerText : ''`)
    if (text && text.includes('运行中')) break
    await sleep(500)
  }

  const imported = JSON.parse(
    await evaluate(`window.gm.importFolder(${JSON.stringify(srcDir)}).then((p) => JSON.stringify({
      imported: p.imported, failed: p.failed, phase: p.phase
    }))`)
  )
  console.log('导入:', JSON.stringify(imported))

  const base = `https://127.0.0.1:${HUB_PORT}/api/v1`
  const video = (await (await fetch(`${base}/media?kind=video`)).json()).media[0]
  if (!video) throw new Error('导入后没有视频记录')
  console.log(
    `记录: id=${video.id} ${video.displayName}  ${video.width}×${video.height}  ` +
      `${video.durationMs ? (video.durationMs / 1000).toFixed(1) + 's' : '时长未知'}`
  )

  // 浏览器自己怎么说这个编码组合
  const canPlay = await evaluate(
    `(() => { const v = document.createElement('video');
      return JSON.stringify({
        generic: v.canPlayType('video/mp4'),
        av1Flac: v.canPlayType('video/mp4; codecs="av01.0.08M.08,flac"'),
        h264Aac: v.canPlayType('video/mp4; codecs="avc1.42E01E,mp4a.40.2"')
      }) })()`
  )
  console.log('canPlayType:', canPlay)

  // 点开查看器
  await evaluate(`document.querySelector('.tile[data-id="${video.id}"]').click(); true`)
  const opened = await waitFor(async () => ((await evaluate(`!!document.querySelector('.viewer')`)) ? 'open' : null), 15000)
  console.log('查看器已打开:', opened ? '✅' : '❌')

  // 播 4 秒，读解码字节（muted 才允许无手势自动播放；静音状态 Chromium 依然解码）
  const played = await evaluate(`(async () => {
    const v = document.querySelector('.viewer-stage video') || document.querySelector('video');
    if (!v) return JSON.stringify({ err: '页面里没有 video 元素' });
    v.muted = true;
    const before = { v: v.webkitVideoDecodedByteCount || 0, a: v.webkitAudioDecodedByteCount || 0 };
    let playErr = '';
    try { await v.play(); } catch (e) { playErr = String(e && e.message); }
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    await sleep(4000);
    return JSON.stringify({
      readyState: v.readyState, paused: v.paused, currentTime: Number(v.currentTime.toFixed(2)),
      videoWidth: v.videoWidth, videoHeight: v.videoHeight, duration: Number((v.duration || 0).toFixed(2)),
      mediaError: v.error ? (v.error.code + ' ' + v.error.message) : null,
      playErr,
      before, after: { v: v.webkitVideoDecodedByteCount || 0, a: v.webkitAudioDecodedByteCount || 0 }
    });
  })()`)
  const r = JSON.parse(played)
  console.log('播放结果:', JSON.stringify(r, null, 1))

  const videoGrew = r.after && r.before && r.after.v > r.before.v
  const audioGrew = r.after && r.before && r.after.a > r.before.a
  console.log('')
  console.log(videoGrew && audioGrew ? '✅ 视频画面与音频都在解码（能播、有声音）' : '❌ 有一路没解出字节')
  console.log(videoGrew ? '   ✅ 视频轨解码正常' : '   ❌ 视频轨没解出字节（黑屏/无法播放）')
  console.log(audioGrew ? '   ✅ 音频轨解码正常（FLAC 被 Chromium 接受了）' : '   ❌ 音频轨没解出字节（没声音）')

  // 信息栏（顺带看一眼分辨率/码率/帧率在不在）
  const infoText = String(
    await evaluate(
      `(() => { const el = document.querySelector('.viewer-info'); return el ? el.innerText.replace(/\\n/g, ' | ') : '(没有信息栏)' })()`
    )
  )
  console.log('信息栏:', infoText)
  ok = Boolean(videoGrew && audioGrew)
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
process.exit(ok ? 0 : 1)
