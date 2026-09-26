/**
 * 临时诊断工具：在**真视频**上验证两件新东西（冒烟测试用的是假 mp4，验证不了）。
 *
 *   ① 视频首帧缩略图：渲染端抽帧 → canvas 编 webp → IPC → 落盘 → 格子里出现真图
 *   ② 信息栏详细数据：分辨率 / 宽高比 / 平均码率 / 帧率（帧率要读 MP4 的 moov 才算得出来）
 *
 * 做法：从正式版的库里**只读**挑一个小视频，复制到临时目录当导入源，
 * 起一个全新的临时实例（独立数据目录 / 端口 / CDP），跑完就删 —— 全程不碰用户数据。
 *
 * 用法：node scripts/_probe-videothumb.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

// 临时目录一律放**项目内**的 .cache/tmp —— 不用 C 盘的 %TEMP%（用户 C 盘敏感，2026-09-25 统一改）
const SCRATCH_DIR = resolve(import.meta.dirname, '..', '.cache', 'tmp')
mkdirSync(SCRATCH_DIR, { recursive: true })


const projectRoot = resolve(import.meta.dirname, '..')
const appExe = process.env.GM_SMOKE_APP
  ? resolve(projectRoot, process.env.GM_SMOKE_APP)
  : join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
const isSource = appExe.endsWith('electron.exe')
/** 仓库根 = desktop/ 的上一级。相册库留在仓库根，不跟电脑端走 */
const repoRoot = resolve(projectRoot, '..')
const userDataDir = process.env.GM_USER_DATA || join(repoRoot, 'GalleryMirrorData')

const HUB_PORT = 8795
const CDP_PORT = 9227
const dataDir = mkdtempSync(join(SCRATCH_DIR, 'gm-vt-data-'))
const srcDir = mkdtempSync(join(SCRATCH_DIR, 'gm-vt-src-'))

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

try {
  // 从正式版库里挑一个视频（只读 DB），复制成带扩展名的真实文件当导入源。
  // GM_SAMPLE_NAME 可以按文件名挑（用来复现"某些视频抽帧抽不出来"的情况）；不给就挑最小的。
  const db = new DatabaseSync(join(userDataDir, 'manifest.db'), { readOnly: true })
  const sampleName = process.env.GM_SAMPLE_NAME
  const row = sampleName
    ? db
        .prepare(
          `SELECT blob_sha256, display_name, size FROM media
           WHERE kind = 'video' AND deleted = 0 AND display_name LIKE ? LIMIT 1`
        )
        .get(`%${sampleName}%`)
    : db
        .prepare(
          `SELECT blob_sha256, display_name, size FROM media
           WHERE kind = 'video' AND deleted = 0 ORDER BY size ASC LIMIT 1`
        )
        .get()
  db.close()
  if (!row) throw new Error('正式库里没有视频，无法验证')
  const blob = join(userDataDir, 'blobs', row.blob_sha256.slice(0, 2), row.blob_sha256)
  if (!existsSync(blob)) throw new Error(`内容文件不存在: ${blob}`)
  const ext = row.display_name.includes('.') ? row.display_name.slice(row.display_name.lastIndexOf('.')) : '.mp4'
  const src = join(srcDir, `VT_SAMPLE${ext}`)
  copyFileSync(blob, src)
  console.log(`样本视频: ${row.display_name}  ${(row.size / 1024 / 1024).toFixed(2)}MB  → ${src}`)

  const spawnArgs = isSource
    ? ['.', `--remote-debugging-port=${CDP_PORT}`]
    : [`--remote-debugging-port=${CDP_PORT}`]
  child = spawn(appExe, spawnArgs, {
    cwd: projectRoot,
    env: { ...process.env, GALLERY_MIRROR_DATA: dataDir, GALLERY_MIRROR_PORT: String(HUB_PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})

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
    if (msg.method === 'Runtime.consoleAPICalled') {
      const args = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')
      console.log('  [页面 console]', msg.params.type, args)
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      console.log('  [页面异常]', d.text, d.exception?.description ?? '')
    }
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
  console.log('窗口标题:', await evaluate(`document.title`))

  const imported = JSON.parse(
    await evaluate(`window.gm.importFolder(${JSON.stringify(srcDir)}).then((p) => JSON.stringify({
      imported: p.imported, failed: p.failed
    }))`)
  )
  console.log('导入:', JSON.stringify(imported))

  const base = `http://127.0.0.1:${HUB_PORT}/api/v1`
  const video = (await (await fetch(`${base}/media?kind=video`)).json()).media[0]
  console.log('视频记录:', video.id, video.displayName, `${video.width}×${video.height}`, `${(video.durationMs / 1000).toFixed(1)}s`)

  // ---------- ① 首帧缩略图 ----------
  const before = await fetch(`${base}/thumb/${video.id}`)
  console.log(`① 抽帧前 /thumb/${video.id} →`, before.status)

  const hasImg = await waitFor(async () => {
    const state = JSON.parse(
      await evaluate(`(() => {
        const t = document.querySelector('.tile[data-id="${video.id}"]');
        const img = t ? t.querySelector('img') : null;
        return JSON.stringify({ tile: !!t, img: !!img, loaded: img ? (img.complete && img.naturalWidth > 0) : false });
      })()`)
    )
    return state.loaded ? state : null
  }, 60000)
  console.log('① 格子里出现首帧图:', hasImg ? '✅' : '❌ 超时')

  const after = await fetch(`${base}/thumb/${video.id}`)
  const thumbBytes = after.ok ? (await after.arrayBuffer()).byteLength : 0
  console.log(
    `① 抽帧后 /thumb/${video.id} →`,
    after.status,
    after.headers.get('content-type'),
    `${thumbBytes} 字节`,
    after.status === 200 ? '✅' : '❌'
  )

  // ---------- ② 信息栏详细数据 ----------
  await evaluate(`document.querySelector('.tile[data-id="${video.id}"]').click(); true`)
  await waitFor(async () => ((await evaluate(`!!document.querySelector('.viewer')`)) ? 'open' : null), 15000)

  // 诊断 1：页面里直接做一次带 Range 的 fetch（帧率那段代码就是这么读文件的）
  const rangeTest = await evaluate(`(async () => {
    try {
      const res = await fetch('http://127.0.0.1:${HUB_PORT}/api/v1/file/${video.id}', { headers: { Range: 'bytes=0-99' } });
      const buf = await res.arrayBuffer();
      return JSON.stringify({ ok: res.ok, status: res.status, bytes: buf.byteLength });
    } catch (err) {
      return 'ERR: ' + (err && err.message ? err.message : String(err));
    }
  })()`)
  console.log('② 诊断 · 页面内 Range fetch:', rangeTest)

  // 诊断 2：把信息栏里所有行都打出来（看看到底显示了哪些字段）
  const infoText = String(
    await evaluate(
      `(() => { const el = document.querySelector('.viewer-info'); return el ? el.innerText.replace(/\\n/g, ' | ') : '(没有信息栏)' })()`
    )
  )
  console.log('② 信息栏全文:', infoText)

  const info = String(
    (await waitFor(async () => {
      const text = await evaluate(
        `(() => { const el = document.querySelector('.viewer-info'); return el ? el.innerText.replace(/\\n/g, ' | ') : '' })()`
      )
      return text && text.includes('帧率') ? text : null
    }, 30000)) ?? infoText
  )
  console.log(
    '② 校验:',
    info.includes('平均码率') && info.includes('帧率') ? '✅ 有码率+帧率' : '❌ 缺字段'
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
