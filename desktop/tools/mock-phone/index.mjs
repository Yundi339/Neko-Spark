#!/usr/bin/env node
/**
 * mock-phone —— 模拟安卓手机客户端（协议 v1）
 *
 * 把一个本地文件夹当作"手机相册"，按 docs/protocol-v1.md 的流程备份到电脑端 Hub：
 *   1. 扫描并计算 SHA-256
 *   2. POST /api/v1/manifest 获取缺失清单
 *   3. PUT  /api/v1/blob/:sha256 分块上传（支持断点续传）
 *   4. POST /api/v1/commit   入库
 *
 * 用法：
 *   node tools/mock-phone/index.mjs <文件夹> [--url https://127.0.0.1:8787] [--device 设备名]
 */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif', '.avif'])
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.avi', '.webm', '.3gp', '.m4v'])
const CHUNK_SIZE = 8 * 1024 * 1024

function parseArgs(argv) {
  const positional = []
  const options = { url: 'https://127.0.0.1:8787', device: '模拟手机' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--url') options.url = argv[++i]
    else if (arg === '--device') options.device = argv[++i]
    else positional.push(arg)
  }
  return { folder: positional[0], options }
}

function mimeOf(filePath) {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  const table = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.heic': 'image/heic',
    '.heif': 'image/heif',
    '.avif': 'image/avif',
    '.mp4': 'video/mp4',
    '.m4v': 'video/mp4',
    '.mov': 'video/quicktime',
    '.mkv': 'video/x-matroska',
    '.avi': 'video/x-msvideo',
    '.webm': 'video/webm',
    '.3gp': 'video/3gpp'
  }
  return table[ext] ?? 'application/octet-stream'
}

function kindOf(filePath) {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase()
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  return undefined
}

async function walk(root, out = []) {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) await walk(full, out)
    else if (entry.isFile()) out.push(full)
  }
  return out
}

function sha256File(filePath) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath, { highWaterMark: 1024 * 1024 })
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

async function buildManifest(root) {
  const files = (await walk(root)).filter((file) => kindOf(file) !== undefined)
  const items = []
  for (const file of files) {
    const st = await stat(file)
    const rel = relative(root, file)
    const dir = dirname(rel)
    const relativePath = dir === '.' ? '' : `${dir.split(sep).join('/')}/`
    items.push({
      sha256: await sha256File(file),
      displayName: basename(file),
      relativePath,
      bucketId: relativePath || '/',
      bucketName: relativePath ? relativePath.replace(/\/$/, '').split('/').pop() : basename(root),
      mimeType: mimeOf(file),
      size: st.size,
      dateModified: Math.round(st.mtimeMs),
      dateAdded: Math.round(st.ctimeMs),
      dateTaken: Math.round(st.mtimeMs),
      isFavorite: false,
      isMotionPhoto: false,
      sourcePath: file
    })
  }
  return items
}

async function uploadBlob(base, sha256, filePath, size) {
  const statusRes = await fetch(`${base}/upload-status?sha256=${sha256}`)
  const status = await statusRes.json()
  if (status.exists) return { uploaded: false }

  let offset = Math.floor((status.received || 0) / CHUNK_SIZE) * CHUNK_SIZE
  const handle = await open(filePath, 'r')
  const buffer = Buffer.alloc(CHUNK_SIZE)
  try {
    while (offset < size) {
      const length = Math.min(CHUNK_SIZE, size - offset)
      await handle.read(buffer, 0, length, offset)
      const body = buffer.subarray(0, length)
      const res = await fetch(`${base}/blob/${sha256}`, {
        method: 'PUT',
        headers: { 'Content-Range': `bytes ${offset}-${offset + length - 1}/${size}` },
        body
      })
      if (!res.ok) throw new Error(`上传失败 ${res.status}：${await res.text()}`)
      const result = await res.json()
      offset += length
      if (result.complete) break
    }
  } finally {
    await handle.close()
  }
  return { uploaded: true }
}

async function main() {
  const { folder, options } = parseArgs(process.argv.slice(2))
  if (!folder) {
    console.error('用法：node tools/mock-phone/index.mjs <文件夹> [--url https://127.0.0.1:8787] [--device 名称]')
    process.exit(2)
  }

  const root = resolve(folder)
  const targetUrl = new URL(options.url)
  if (targetUrl.protocol === 'https:' && ['127.0.0.1', 'localhost', '[::1]'].includes(targetUrl.hostname)) {
    // 仅测试本机自动生成的自签名证书；手机端使用证书指纹固定，不走这个绕过。
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  }
  const base = `${options.url.replace(/\/$/, '')}/api/v1`
  const deviceId = `mock-${createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 12)}`

  console.log(`扫描文件夹：${root}`)
  const items = await buildManifest(root)
  console.log(`发现 ${items.length} 个媒体文件`)

  const manifestRes = await fetch(`${base}/manifest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocolVersion: 1,
      device: { deviceId, name: options.device, model: 'MockPhone', androidVersion: '15' },
      items
    })
  })
  if (!manifestRes.ok) throw new Error(`manifest 失败：${manifestRes.status}`)
  const manifest = await manifestRes.json()
  console.log(`服务端已有 ${manifest.known} 个，需要上传 ${manifest.needed.length} 个`)

  let uploaded = 0
  for (const item of items) {
    if (!manifest.needed.includes(item.sha256)) continue
    const result = await uploadBlob(base, item.sha256, item.sourcePath, item.size)
    if (result.uploaded) uploaded += 1
  }
  console.log(`已上传 ${uploaded} 个文件`)

  const commitRes = await fetch(`${base}/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocolVersion: 1,
      device: { deviceId, name: options.device, model: 'MockPhone', androidVersion: '15' },
      items: items.map(({ sourcePath, ...rest }) => rest)
    })
  })
  if (!commitRes.ok) throw new Error(`commit 失败：${commitRes.status}`)
  const commit = await commitRes.json()
  console.log(`入库完成：新增/更新 ${commit.inserted}，跳过 ${commit.skipped}`)
}

main().catch((err) => {
  console.error('备份失败：', err instanceof Error ? err.message : err)
  process.exit(1)
})
