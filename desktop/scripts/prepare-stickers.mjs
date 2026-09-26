#!/usr/bin/env node
/**
 * 把下载的图片处理成界面贴图：
 *   1. 从四边做"连通白底"抠图（保留角色内部的白色区域）
 *   2. 裁剪透明边
 *   3. 缩放到合适大小
 *
 * 用法：node scripts/prepare-stickers.mjs <源目录> <输出目录>
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'

const srcDir = resolve(process.argv[2] ?? '')
const outDir = resolve(process.argv[3] ?? '')
if (!srcDir || !outDir || !existsSync(srcDir)) {
  console.error('用法：node scripts/prepare-stickers.mjs <源目录> <输出目录>')
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })

const JOBS = [
  { src: 'img03.png', out: '01.webp', crop: { left: 0, top: 0, width: 1, height: 0.7 }, square: true },
  { src: 'img01.png', out: '02.webp' },
  { src: 'img02.png', out: '03.webp', crop: { left: 0, top: 0, width: 0.78, height: 1 } },
  { src: 'img04.png', out: '04.webp' }
]

const WHITE_MIN = 238

/** 从四边连通地移除接近纯白的背景 */
function removeBackground(data, width, height) {
  const visited = new Uint8Array(width * height)
  const queue = []

  const isNearWhite = (idx) => {
    const o = idx * 4
    return data[o] >= WHITE_MIN && data[o + 1] >= WHITE_MIN && data[o + 2] >= WHITE_MIN
  }

  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const idx = y * width + x
    if (visited[idx]) return
    if (!isNearWhite(idx)) return
    visited[idx] = 1
    queue.push(idx)
  }

  for (let x = 0; x < width; x += 1) {
    push(x, 0)
    push(x, height - 1)
  }
  for (let y = 0; y < height; y += 1) {
    push(0, y)
    push(width - 1, y)
  }

  while (queue.length > 0) {
    const idx = queue.pop()
    const x = idx % width
    const y = (idx - x) / width
    data[idx * 4 + 3] = 0
    push(x + 1, y)
    push(x - 1, y)
    push(x, y + 1)
    push(x, y - 1)
  }
}

async function processOne(job) {
  const input = join(srcDir, job.src)
  if (!existsSync(input)) {
    console.log(`跳过（不存在）：${job.src}`)
    return
  }

  let pipeline = sharp(input).ensureAlpha()
  const meta = await sharp(input).metadata()
  if (job.crop) {
    pipeline = pipeline.extract({
      left: Math.round((meta.width ?? 0) * job.crop.left),
      top: Math.round((meta.height ?? 0) * job.crop.top),
      width: Math.round((meta.width ?? 0) * job.crop.width),
      height: Math.round((meta.height ?? 0) * job.crop.height)
    })
  }

  const { data, info } = await pipeline.raw().toBuffer({ resolveWithObject: true })
  removeBackground(data, info.width, info.height)

  let out = sharp(data, { raw: { width: info.width, height: info.height, channels: 4 } })
  out = out.trim({ threshold: 6 })

  const trimmed = await out.png().toBuffer({ resolveWithObject: true })
  const maxSide = 520
  const scale = Math.min(1, maxSide / Math.max(trimmed.info.width, trimmed.info.height))
  const width = Math.max(1, Math.round(trimmed.info.width * scale))
  const height = Math.max(1, Math.round(trimmed.info.height * scale))

  let final = sharp(trimmed.data).resize(width, height, { fit: 'inside' })

  if (job.square) {
    const side = Math.max(width, height)
    final = sharp(trimmed.data)
      .resize(side, side, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
  }

  const outFile = join(outDir, job.out)
  if (job.out.endsWith('.webp')) {
    await final.webp({ quality: 88, effort: 5 }).toFile(outFile)
  } else {
    await final.png({ compressionLevel: 9, palette: true, quality: 92 }).toFile(outFile)
  }
  console.log(`生成 ${job.out}  (${width}×${height})`)
}

for (const job of JOBS) {
  await processOne(job)
}
console.log(`完成：${outDir}`)
