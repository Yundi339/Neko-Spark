/**
 * 一处生成全套图标：**桌面（Windows .ico）+ 安卓（mipmap + 自适应图标）**。
 * 图标源 = 侧栏那个猫猫头：src/renderer/src/assets/stickers/logo.png（2026-09-25 用户指定）。
 *
 * 用法: node scripts/make-icon.mjs
 *
 * 生成物：
 *   build/icon.ico / build/icon.png                      —— 桌面端（electron-builder 用它打进 exe）
 *   android 的 mipmap-xxx/ic_launcher.png                —— 安卓传统图标（48/72/96/144/192）
 *   android 的 mipmap-xxx/ic_launcher_round.png（同尺寸，圆形）
 *   android 的 mipmap-xxx/ic_launcher_foreground.png（108dp 系列：108/162/216/324/432）
 *   android 的 mipmap-anydpi-v26/ic_launcher.xml（自适应图标，minSdk 26 起全都支持）
 *   另：.cache/icon-preview.png —— 合成预览（前景+背景+圆形遮罩），用来目视检查，不进安装包
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import sharp from 'sharp'

const root = resolve(import.meta.dirname, '..')
/** 仓库根 = desktop/ 的上一级。安卓端的 mipmap 在那边，不跟着电脑端走 */
const repoRoot = resolve(root, '..')
const SRC = join(root, 'src/renderer/src/assets/stickers/logo.png')
/** 自适应图标的背景色：取 UI 规范里的底色（附录 D） */
const BG = { r: 0xf2, g: 0xf8, b: 0xff, alpha: 1 }
/** 前景在 108dp 画布里的占比：0.66 ≈ 71dp，稳落在安全区内（圆形遮罩不会切到猫耳朵） */
const FG_SCALE = 0.66

const meta = await sharp(SRC).metadata()
console.log(`图标源: ${SRC}  ${meta.width}x${meta.height}`)

const transparent = { r: 0, g: 0, b: 0, alpha: 0 }

// ---------- 1) 桌面：多尺寸 .ico（PNG-in-ICO，Vista+）----------
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]
const pngs = []
for (const size of ICO_SIZES) {
  pngs.push(await sharp(SRC).resize(size, size, { fit: 'contain', background: transparent }).png({ compressionLevel: 9 }).toBuffer())
}
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(ICO_SIZES.length, 4)
const entries = Buffer.alloc(16 * ICO_SIZES.length)
let offset = 6 + 16 * ICO_SIZES.length
ICO_SIZES.forEach((size, i) => {
  const at = 16 * i
  entries.writeUInt8(size >= 256 ? 0 : size, at)
  entries.writeUInt8(size >= 256 ? 0 : size, at + 1)
  entries.writeUInt16LE(1, at + 4)
  entries.writeUInt16LE(32, at + 6)
  entries.writeUInt32LE(pngs[i].length, at + 8)
  entries.writeUInt32LE(offset, at + 12)
  offset += pngs[i].length
})
mkdirSync(join(root, 'build'), { recursive: true })
writeFileSync(join(root, 'build/icon.ico'), Buffer.concat([header, entries, ...pngs]))
await sharp(SRC).resize(512, 512, { fit: 'contain', background: transparent }).png().toFile(join(root, 'build/icon.png'))
console.log(`✓ build/icon.ico（${ICO_SIZES.length} 个尺寸）+ build/icon.png(512)`)

// ---------- 2) 安卓：传统图标 + 自适应图标 ----------
const DPI = [
  { name: 'mdpi', legacy: 48, adaptive: 108 },
  { name: 'hdpi', legacy: 72, adaptive: 162 },
  { name: 'xhdpi', legacy: 96, adaptive: 216 },
  { name: 'xxhdpi', legacy: 144, adaptive: 324 },
  { name: 'xxxhdpi', legacy: 192, adaptive: 432 }
]
const resDir = join(repoRoot, 'android/app/src/main/res')

/** 生成"背景 + 缩放好的前景"合成图（安卓图标用） */
async function compose(size, fgScale, round) {
  const inner = Math.round(size * fgScale)
  const fg = await sharp(SRC).resize(inner, inner, { fit: 'contain', background: transparent }).png().toBuffer()
  let img = sharp({ create: { width: size, height: size, channels: 4, background: round ? transparent : BG } })
  if (round) {
    // 圆形：先画一个圆底，再叠前景
    const circle = Buffer.from(
      `<svg width="${size}" height="${size}"><circle cx="${size / 2}" cy="${size / 2}" r="${size / 2}" fill="rgb(${BG.r},${BG.g},${BG.b})"/></svg>`
    )
    img = sharp(await img.composite([{ input: circle, top: 0, left: 0 }]).png().toBuffer())
  }
  return img
    .composite([{ input: fg, top: Math.round((size - inner) / 2), left: Math.round((size - inner) / 2) }])
    .png()
    .toBuffer()
}

for (const d of DPI) {
  const dir = join(resDir, `mipmap-${d.name}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'ic_launcher.png'), await compose(d.legacy, 0.86, false))
  writeFileSync(join(dir, 'ic_launcher_round.png'), await compose(d.legacy, 0.74, true))
  // 自适应图标的前景：透明底 + 缩小的猫猫头（背景由 XML 指定）
  const inner = Math.round(d.adaptive * FG_SCALE)
  writeFileSync(
    join(dir, 'ic_launcher_foreground.png'),
    await sharp({ create: { width: d.adaptive, height: d.adaptive, channels: 4, background: transparent } })
      .composite([
        {
          input: await sharp(SRC).resize(inner, inner, { fit: 'contain', background: transparent }).png().toBuffer(),
          top: Math.round((d.adaptive - inner) / 2),
          left: Math.round((d.adaptive - inner) / 2)
        }
      ])
      .png()
      .toBuffer()
  )
  console.log(`✓ mipmap-${d.name}: ic_launcher(${d.legacy}) / round / foreground(${d.adaptive})`)
}

// 自适应图标 XML + 背景色
const anydpi = join(resDir, 'mipmap-anydpi-v26')
mkdirSync(anydpi, { recursive: true })
const adaptiveXml = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
`
writeFileSync(join(anydpi, 'ic_launcher.xml'), adaptiveXml)
writeFileSync(join(anydpi, 'ic_launcher_round.xml'), adaptiveXml)
console.log('✓ mipmap-anydpi-v26/ic_launcher.xml + ic_launcher_round.xml')

// ---------- 3) 自检预览：圆形遮罩下长什么样 ----------
const previewSize = 512
const fgPrev = Math.round(previewSize * FG_SCALE)
const circleMask = Buffer.from(
  `<svg width="${previewSize}" height="${previewSize}"><circle cx="${previewSize / 2}" cy="${previewSize / 2}" r="${previewSize / 2}" fill="#fff"/></svg>`
)
await mkdirSync(join(root, '.cache'), { recursive: true })
await sharp({ create: { width: previewSize, height: previewSize, channels: 4, background: BG } })
  .composite([
    {
      input: await sharp(SRC).resize(fgPrev, fgPrev, { fit: 'contain', background: transparent }).png().toBuffer(),
      top: Math.round((previewSize - fgPrev) / 2),
      left: Math.round((previewSize - fgPrev) / 2)
    },
    { input: Buffer.from(`<svg width="${previewSize}" height="${previewSize}"><rect width="100%" height="100%" fill="none"/></svg>`), top: 0, left: 0 }
  ])
  .composite([{ input: circleMask, blend: 'dest-in' }])
  .png()
  .toFile(join(root, '.cache/icon-preview.png'))
void circleMask
console.log('✓ 预览（圆形遮罩效果）: .cache/icon-preview.png')
