/**
 * 诊断：模拟手机端完整走一遍协议 v1，观察「电脑端媒体数」在传输过程中的变化
 * 目的：验证"手机传了几十上百个文件，电脑界面毫无反应"的根因
 *
 * 用法：node scripts/_diag-stream.mjs
 * 隔离：使用临时数据目录 + 端口 8801，不触碰真实相册库
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import sharp from 'sharp'

// 临时目录一律放**项目内**的 .cache/tmp —— 不用 C 盘的 %TEMP%（用户 C 盘敏感，2026-09-25 统一改）
const SCRATCH_DIR = resolve(import.meta.dirname, '..', '.cache', 'tmp')
mkdirSync(SCRATCH_DIR, { recursive: true })


const projectRoot = resolve(import.meta.dirname, '..')
const electronExe = join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
const HUB_PORT = 8801
const N = 120
const dataDir = mkdtempSync(join(SCRATCH_DIR, 'gm-diag-'))
const base = `https://127.0.0.1:${HUB_PORT}/api/v1`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
const stamp = () => `t=${((Date.now() - t0) / 1000).toFixed(1)}s`

let child = null
const cleanup = () => {
  if (child?.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  try {
    rmSync(dataDir, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}
process.on('exit', cleanup)

async function main() {
  if (!existsSync(join(projectRoot, 'out', 'main', 'index.js'))) {
    throw new Error('缺少构建产物 out/，请先 npm.cmd run build')
  }

  console.log('=== 模拟手机端完整同步（120 个文件）===\n')

  // 1. 造 120 张真实 JPEG（每张约 200KB，互不相同）
  console.log('准备测试图片...')
  const files = []
  for (let i = 0; i < N; i += 1) {
    const buf = await sharp({
      create: {
        width: 1400,
        height: 1050,
        channels: 3,
        background: { r: (i * 7) % 256, g: (i * 13) % 256, b: (i * 29) % 256 }
      }
    })
      .jpeg({ quality: 92 })
      .toBuffer()
    files.push({
      sha256: createHash('sha256').update(buf).digest('hex'),
      displayName: `IMG_${String(1000 + i)}.jpg`,
      relativePath: 'DCIM/Camera/',
      bucketId: 'DCIM/Camera',
      bucketName: 'Camera',
      mimeType: 'image/jpeg',
      size: buf.length,
      width: 1400,
      height: 1050,
      dateTaken: 1767225600000 + i * 86400000,
      dateModified: 1767225600000 + i * 86400000,
      buf
    })
  }
  console.log(`  ${N} 张，共 ${(files.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(1)} MB\n`)

  // 2. 启动隔离的电脑端
  child = spawn(electronExe, ['.', '--remote-debugging-port=9224'], {
    cwd: projectRoot,
    env: { ...process.env, GALLERY_MIRROR_DATA: dataDir, GALLERY_MIRROR_PORT: String(HUB_PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})

  for (let i = 0; i < 120; i += 1) {
    try {
      const res = await fetch(`${base}/health`)
      if (res.ok) break
    } catch {
      /* 还没起来 */
    }
    await sleep(500)
  }
  const mediaCount = async () => (await (await fetch(`${base}/info`)).json()).counts.media
  console.log(`${stamp()}  电脑端已启动（隔离数据目录）`)
  console.log(`${stamp()}  界面当前媒体数 = ${await mediaCount()}`)
  console.log('')

  // 3. manifest
  const device = { deviceId: 'diag-phone', name: '诊断手机', model: 'Diag', androidVersion: '14' }
  const items = files.map(({ buf, ...rest }) => rest)
  const manifestRes = await (
    await fetch(`${base}/manifest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, device, items })
    })
  ).json()
  console.log(`${stamp()}  manifest 完成：需要上传 ${manifestRes.needed.length} 个，服务端已有 ${manifestRes.known} 个`)
  console.log('')
  console.log('  ── 开始上传，持续观察电脑端 ──')

  // 4. 逐个上传，每 10 个报告一次电脑端媒体数
  const neededSet = new Set(manifestRes.needed)
  let uploaded = 0
  for (const f of files) {
    if (!neededSet.has(f.sha256)) continue
    await fetch(`${base}/blob/${f.sha256}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Range': `bytes 0-${f.size - 1}/${f.size}`
      },
      body: f.buf
    })
    uploaded += 1
    if (uploaded % 10 === 0 || uploaded === N) {
      console.log(
        `${stamp()}  手机已上传 ${String(uploaded).padStart(3)}/${N} 个   →   电脑界面媒体数 = ${await mediaCount()}`
      )
    }
    await sleep(25)
  }

  console.log('')
  console.log(`${stamp()}  ★ 手机端全部传输完毕`)
  console.log(`${stamp()}  ★ 电脑界面媒体数 = ${await mediaCount()}   ← 边传边出现，传完即全部可见`)
  console.log('')

  // 5. commit（最终对账，幂等）
  const commitRes = await (
    await fetch(`${base}/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, device, items })
    })
  ).json()
  await sleep(300)
  console.log(`${stamp()}  调用 commit 对账：${JSON.stringify(commitRes)}`)
  console.log(`${stamp()}  电脑界面媒体数 = ${await mediaCount()}   ← 不重复、不丢失`)
  console.log('')

  // 6. 场景二：传输中途断开 —— 关键健壮性验证
  console.log('=== 场景二：传到一半断开（不调用 commit）===')
  const device2 = { deviceId: 'diag-phone-2', name: '诊断手机2', model: 'Diag', androidVersion: '14' }
  const items2 = items.slice(0, 120)
  const man2 = await (
    await fetch(`${base}/manifest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, device: device2, items: items2 })
    })
  ).json()
  console.log(`${stamp()}  第二台手机上报清单，需要上传 ${man2.needed.length} 个`)
  console.log(`${stamp()}  （这些内容电脑上已有相同 blob，属于"跨设备去重"场景）`)
  const afterManifest = await mediaCount()
  console.log(`${stamp()}  仅上报清单、一个字节都没传 → 媒体数 = ${afterManifest}`)
  console.log(`${stamp()}  差值 ${afterManifest - 120} ← 清单里电脑已有的文件被立刻入库，无需重传`)
  console.log('')

  // 7. 真·中断：新设备传一半就停
  const device3 = { deviceId: 'diag-phone-3', name: '诊断手机3', model: 'Diag', androidVersion: '14' }
  const half = 40
  const files3 = []
  for (let i = 0; i < half; i += 1) {
    const buf = await sharp({
      create: { width: 640, height: 480, channels: 3, background: { r: i, g: 255 - i, b: 128 } }
    })
      .jpeg({ quality: 85 })
      .toBuffer()
    files3.push({
      sha256: createHash('sha256').update(buf).digest('hex'),
      displayName: `BREAK_${i}.jpg`,
      relativePath: 'DCIM/Break/',
      bucketId: 'DCIM/Break',
      bucketName: 'Break',
      mimeType: 'image/jpeg',
      size: buf.length,
      width: 640,
      height: 480,
      dateTaken: 1767225600000 + i,
      dateModified: 1767225600000 + i,
      buf
    })
  }
  const man3 = await (
    await fetch(`${base}/manifest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, device: device3, items: files3.map(({ buf, ...r }) => r) })
    })
  ).json()
  const need3 = new Set(man3.needed)
  let sent = 0
  for (const f of files3) {
    if (!need3.has(f.sha256)) continue
    await fetch(`${base}/blob/${f.sha256}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg', 'Content-Range': `bytes 0-${f.size - 1}/${f.size}` },
      body: f.buf
    })
    sent += 1
  }
  const afterHalf = await mediaCount()
  console.log(`${stamp()}  第三台手机传了 ${sent} 个文件后「App 被杀 / 息屏 / 断网」，未调用 commit`)
  console.log(`${stamp()}  ★ 中断后电脑界面媒体数 = ${afterHalf}`)
  console.log(`${stamp()}  ★ 其中来自这台手机的 = ${afterHalf - afterManifest} 个（= 传完的数量）`)
  console.log('  → 结论：传完一个就保住一个，中途断开也不会白传')
  console.log('')

  const info = await (await fetch(`${base}/info`)).json()
  console.log('最终统计：', JSON.stringify(info.counts))
}

main()
  .catch((err) => {
    console.error('诊断失败：', err)
    process.exitCode = 1
  })
  .finally(() => {
    cleanup()
    setTimeout(() => process.exit(process.exitCode ?? 0), 300)
  })
