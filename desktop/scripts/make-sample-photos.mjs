#!/usr/bin/env node
/**
 * 生成一批示例图片（用于预览界面 / 测试）。
 *
 * 用法：node scripts/make-sample-photos.mjs <目标文件夹>
 */
import { mkdirSync, utimesSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'

const target = resolve(process.argv[2] ?? 'sample-photos')

let seed = Number(process.argv[3] ?? 20260912)
function random() {
  seed = (seed * 1664525 + 1013904223) % 4294967296
  return seed / 4294967296
}

const PALETTES = [
  ['#1e3a8a', '#7c3aed', '#f472b6'],
  ['#0f766e', '#22d3ee', '#facc15'],
  ['#7c2d12', '#f97316', '#fde68a'],
  ['#4c1d95', '#c026d3', '#fbcfe8'],
  ['#064e3b', '#10b981', '#a7f3d0'],
  ['#0c4a6e', '#0ea5e9', '#e0f2fe'],
  ['#3f0f0f', '#dc2626', '#fecaca'],
  ['#1f2937', '#6b7280', '#e5e7eb']
]

function gradientSvg(width, height, colors, label) {
  const [c1, c2, c3] = colors
  const r1 = Math.round(width * (0.2 + random() * 0.2))
  const r2 = Math.round(width * (0.15 + random() * 0.25))
  const cx1 = Math.round(random() * width)
  const cy1 = Math.round(random() * height)
  const cx2 = Math.round(random() * width)
  const cy2 = Math.round(random() * height)
  const fontSize = Math.max(28, Math.round(width / 22))
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${c1}"/>
      <stop offset="55%" stop-color="${c2}"/>
      <stop offset="100%" stop-color="${c3}"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <circle cx="${cx1}" cy="${cy1}" r="${r1}" fill="#ffffff" opacity="0.18"/>
  <circle cx="${cx2}" cy="${cy2}" r="${r2}" fill="#000000" opacity="0.16"/>
  <circle cx="${Math.round(width / 2)}" cy="${Math.round(height * 0.42)}" r="${Math.round(width * 0.16)}" fill="#ffffff" opacity="0.12"/>
  <text x="${Math.round(width * 0.06)}" y="${height - Math.round(height * 0.06)}" font-family="Segoe UI, sans-serif"
        font-size="${fontSize}" fill="#ffffff" opacity="0.92">${label}</text>
</svg>`
}

const PLAN = [
  { dir: 'DCIM/Camera', prefix: 'IMG_', count: 9, ext: 'jpg', landscape: true },
  { dir: 'Pictures/Screenshots', prefix: 'Screenshot_', count: 4, ext: 'png', landscape: false },
  { dir: 'Pictures/WeChat', prefix: 'mmexport', count: 3, ext: 'jpg', landscape: true }
]

async function main() {
  let day = Number(process.argv[4] ?? 1)
  let month = 8
  let index = 0

  for (const group of PLAN) {
    const dir = join(target, ...group.dir.split('/'))
    mkdirSync(dir, { recursive: true })

    for (let i = 0; i < group.count; i += 1) {
      const colors = PALETTES[index % PALETTES.length]
      const width = group.landscape ? 1600 : 1080
      const height = group.landscape ? 1200 : 2340
      const label = `${group.prefix}${String(i + 1).padStart(4, '0')}`
      const file = join(dir, `${label}.${group.ext}`)

      const pipeline = sharp(Buffer.from(gradientSvg(width, height, colors, label)))
      if (group.ext === 'png') await pipeline.png().toFile(file)
      else await pipeline.jpeg({ quality: 85 }).toFile(file)

      // 每 3 张换一天，时间线看起来更饱满
      if ((i + 1) % 3 === 0) {
        day += 1
        if (day > 30) {
          day = 1
          month = month === 12 ? 1 : month + 1
        }
      }
      const hour = 8 + ((i * 3) % 12)
      const when = new Date(2026, month - 1, day, hour, (i * 7) % 60, 0)
      utimesSync(file, when, when)

      index += 1
    }
  }

  console.log(`已生成 ${index} 张示例图片到 ${target}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
