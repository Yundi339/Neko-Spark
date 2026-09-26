import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import sharp from 'sharp'
// ⚠️ 必须写全 `libheif-js/wasm-bundle.js`：产物是 ESM，而 libheif-js 的 package.json
// 没有 "exports" 字段，Node 的 ESM 解析**不接受省略扩展名的子路径**（会报
// "Cannot find module .../libheif-js/wasm-bundle, did you mean .../wasm-bundle.js?"）。
import type { HeifDisplayTarget } from 'libheif-js/wasm-bundle.js'

/**
 * 缩略图生成子进程（Electron utilityProcess）。
 *
 * **为什么要单独开进程**：sharp 的原生模块（libvips）在这个 Electron 环境下会偶发
 * **原生崩溃**（`sharp-win32-x64-*.node` + 异常码 `0xc0000409`，fail-fast），
 * JS 层完全拦不住 —— 崩了整个应用就闪退。放进子进程后，最坏情况只是这个子进程死掉，
 * 主程序记一笔、把该缩略图标为失败，继续跑。
 *
 * 实测（2026-09-24）：崩溃在 13:44 和 19:24 各出现一次，两次故障模块与偏移完全相同，
 * 且 13:44 那次发生在任何相关改动之前 —— 属于原本就存在的问题。普通 Node 进程里
 * 用顺序/并发 8 跑完全部 3928 张都无法复现，是 Electron 环境特有的。
 *
 * ⚠️ **这个文件刻意不 import 任何本地模块**（连 thumbs.ts 都不引）—— 多入口打包时
 * rollup 会拆出共享 chunk，而 utilityProcess 加载那个 chunk 会失败
 * （`ERR_MODULE_NOT_FOUND .../chunks/thumb-worker.js`）。保持自我包含最省事。
 * 代价只是和 thumbs.ts 里重复了十来行 sharp 调用。
 *
 * ────────────────────────────────────────────────────────────────
 * 2026-09-24 追加：sharp 解不了的两种图，这里做兜底（见 `decodeFallback`）
 *
 * ① **HEIC/HEIF**：sharp 预编译的 libvips **只带了 AVIF 解码（aom），没有 HEVC 解码器**，
 *    而且 libvips 是通过流式 reader 喂给 libheif 的 —— 实测会报
 *    `bad seek to <文件尾+32>`（两个文件都一样，正好多 32 字节）。
 *    改走 **libheif-js（WASM）**：从内存里解，实测 7ms 解出，尺寸与 Chromium 报的一致。
 *    用户库里那 2 张 HEIC 就是这么救回来的。
 * ② **BMP**：libvips 没有 BMP 加载器（预编译不带 ImageMagick），报
 *    "Input file contains unsupported image format"。BMP 未压缩格式很简单，自己解（见 `decodeBmp`）。
 * ────────────────────────────────────────────────────────────────
 */

const THUMB_SIZE = 384
const THUMB_QUALITY = 78
/** 尺寸/质量由发任务的一方指定（缩略图 384；查看器要的大预览图会传更大的值） */
interface GenOptions {
  size: number
  quality: number
  /** 编码格式：缩略图用 'jpeg'（Chromium 解 JPEG 比 WebP 快 3.2 倍），查看器大预览图用 'webp' */
  format: 'jpeg' | 'webp'
}
const THUMB_OPTIONS: GenOptions = { size: THUMB_SIZE, quality: THUMB_QUALITY, format: 'jpeg' }
/** 兜底解码要把整个文件读进内存，超过这个大小就别试了（防畸形文件把内存吃爆） */
const FALLBACK_MAX_BYTES = 64 * 1024 * 1024

// 单张没必要在 libvips 内部再并行，多开几个子进程就够了
sharp.concurrency(1)

/** ftyp 里的这些 brand 属于 HEIF 家族（HEIC 是其中的 HEVC 分支） */
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1', 'miaf'])

interface RawImage {
  data: Buffer
  width: number
  height: number
  channels: 3 | 4
}

async function sharpPathToFile(sourcePath: string, targetPath: string, opts: GenOptions): Promise<boolean> {
  await sharp(sourcePath, { failOn: 'none', animated: false })
    .rotate()
    .resize(opts.size, opts.size, { fit: 'inside', withoutEnlargement: true })
    // 缩略图用 JPEG（解码比 WebP 快 3.2 倍，观感不变）；预览图仍是 webp
    .toFormat(opts.format === 'webp' ? 'webp' : 'jpeg', opts.format === 'webp' ? { quality: opts.quality } : { quality: Math.max(opts.quality, 90), progressive: false })
    .toFile(targetPath)
  return true
}

async function sharpRawToFile(raw: RawImage, targetPath: string, opts: GenOptions): Promise<boolean> {
  await sharp(raw.data, {
    raw: { width: raw.width, height: raw.height, channels: raw.channels }
  })
    .resize(opts.size, opts.size, { fit: 'inside', withoutEnlargement: true })
    // 缩略图用 JPEG（解码比 WebP 快 3.2 倍，观感不变）；预览图仍是 webp
    .toFormat(opts.format === 'webp' ? 'webp' : 'jpeg', opts.format === 'webp' ? { quality: opts.quality } : { quality: Math.max(opts.quality, 90), progressive: false })
    .toFile(targetPath)
  return true
}

// ---------------- 兜底解码一：HEIC / HEIF（libheif-js WASM）----------------

/**
 * **懒加载** WASM：99% 的缩略图是 JPEG/PNG，不该为它们付 44ms + 约 20MB 的初始化代价；
 * 而且 WASM 万一初始化不了（打包/环境问题），也只会让 HEIC 这几张失败，
 * 不会连带把整个 worker 的模块加载搞崩（那样所有缩略图都会生成不出来）。
 */
let libheifPromise: Promise<typeof import('libheif-js/wasm-bundle.js') | null> | null = null

function loadLibheif(): Promise<typeof import('libheif-js/wasm-bundle.js') | null> {
  libheifPromise ??= import('libheif-js/wasm-bundle.js')
    .then((mod) => {
      // CJS 打包下 require() 出来的对象没有 .default，两种形态都兜住
      const ns = mod as unknown as { HeifDecoder?: unknown; default?: unknown }
      return (ns.HeifDecoder ? mod : (ns.default as typeof mod | undefined)) ?? null
    })
    .catch((err: unknown) => {
      console.error('[thumb] libheif-js 加载失败，HEIC 将无法生成缩略图：', err instanceof Error ? err.message : err)
      return null
    })
  return libheifPromise
}

async function decodeHeif(buf: Buffer): Promise<RawImage | null> {
  const libheif = await loadLibheif()
  if (!libheif?.HeifDecoder) return null
  const images = new libheif.HeifDecoder().decode(new Uint8Array(buf))
  const image = images[0]
  if (!image) return null
  // libheif 的 get_width/get_height 返回的是**应用过 irot/imir 变换之后**的显示尺寸，
  // 所以这里不需要再按 EXIF 方向旋转
  const width = image.get_width()
  const height = image.get_height()
  if (!width || !height) return null
  const target: HeifDisplayTarget = { data: new Uint8ClampedArray(width * height * 4), width, height }
  const out = await new Promise<HeifDisplayTarget | null>((resolve) => {
    image.display(target, (result) => resolve(result ?? null))
  })
  if (!out?.data) return null
  // 拷进 Buffer（不要直接复用 WASM 堆上那块内存）
  const data = Buffer.allocUnsafe(out.data.byteLength)
  data.set(out.data)
  return { data, width, height, channels: 4 }
}

// ---------------- 兜底解码二：BMP（自己解，未压缩的那些）----------------

/**
 * 极简 BMP 解码，支持：1/4/8 位调色板、16 位 RGB555/RGB565、24 位、32 位。
 * 不支持就返回 null（维持"生成失败"，不会瞎编一张图出来）：
 * - RLE 压缩（BITMAPINFOHEADER+ 的 1/4/8 位 RLE、以及 RLE8/RLE4）
 * - BITMAPCOREHEADER（OS/2 老格式，12 字节头）
 * - 头部长度对不上、数据偏移越界
 */
function decodeBmp(buf: Buffer): RawImage | null {
  if (buf.length < 54 || buf[0] !== 0x42 || buf[1] !== 0x4d) return null // 'BM'
  const dataOffset = buf.readUInt32LE(10)
  const headerSize = buf.readUInt32LE(14)
  if (headerSize < 40) return null
  const width = buf.readInt32LE(18)
  const rawHeight = buf.readInt32LE(22)
  const planes = buf.readUInt16LE(26)
  const bitCount = buf.readUInt16LE(28)
  const compression = buf.readUInt32LE(30)
  if (planes !== 1 || width <= 0 || rawHeight === 0) return null
  if (compression !== 0 && compression !== 3) return null // 0=BI_RGB 3=BI_BITFIELDS
  const height = Math.abs(rawHeight)
  const topDown = rawHeight < 0 // 负高度 = 自上而下存的
  const stride = ((width * bitCount + 31) >> 5) * 4
  if (dataOffset + stride * height > buf.length) return null

  // 调色板（1/4/8 位）：每项 4 字节 BGRA（BMP 惯例：B 在前）
  let palette: Buffer | null = null
  if (bitCount <= 8) {
    const count = buf.readUInt32LE(46) || 1 << bitCount
    const at = 14 + headerSize
    if (at + count * 4 > buf.length) return null
    palette = buf.subarray(at, at + count * 4)
  }

  // 16/32 位的通道掩码
  let rMask = 0
  let gMask = 0
  let bMask = 0
  let aMask = 0
  if (compression === 3) {
    // V4/V5 头部（>=108 字节）的掩码就写在头部里；40 字节头的掩码紧跟在头部之后
    const at = headerSize >= 52 ? 14 + 40 : 14 + headerSize
    if (at + 12 > buf.length) return null
    rMask = buf.readUInt32LE(at)
    gMask = buf.readUInt32LE(at + 4)
    bMask = buf.readUInt32LE(at + 8)
    aMask = headerSize >= 56 ? buf.readUInt32LE(at + 12) : 0
  } else if (bitCount === 16) {
    rMask = 0x7c00 // BI_RGB 的 16 位按 555 解释
    gMask = 0x03e0
    bMask = 0x001f
  }

  const out = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    const row = dataOffset + (topDown ? y : height - 1 - y) * stride
    for (let x = 0; x < width; x += 1) {
      let r = 0
      let g = 0
      let b = 0
      let a = 255
      if (bitCount === 24) {
        const at = row + x * 3
        b = buf[at]
        g = buf[at + 1]
        r = buf[at + 2]
      } else if (bitCount === 32) {
        const at = row + x * 4
        b = buf[at]
        g = buf[at + 1]
        r = buf[at + 2]
        // BI_RGB 的 32 位 alpha 通道很多程序写 0，直接用会整张全透明 → 只有当有 alpha 掩码时才信它
        a = aMask ? scaleMask(buf.readUInt32LE(at), aMask) : 255
      } else if (bitCount === 16) {
        const v = buf.readUInt16LE(row + x * 2)
        r = scaleMask(v & rMask, rMask)
        g = scaleMask(v & gMask, gMask)
        b = scaleMask(v & bMask, bMask)
      } else if (bitCount === 8 || bitCount === 4 || bitCount === 1) {
        let index: number
        if (bitCount === 8) index = buf[row + x]
        else if (bitCount === 4) {
          const byte = buf[row + (x >> 1)]
          index = x & 1 ? byte & 0x0f : byte >> 4
        } else {
          const byte = buf[row + (x >> 3)]
          index = (byte >> (7 - (x & 7))) & 1
        }
        const at = index * 4
        if (!palette || at + 2 >= palette.length) return null
        b = palette[at]
        g = palette[at + 1]
        r = palette[at + 2]
      } else {
        return null // 不支持位数
      }
      const at = (y * width + x) * 4
      out[at] = r
      out[at + 1] = g
      out[at + 2] = b
      out[at + 3] = a
    }
  }
  return { data: out, width, height, channels: 4 }
}

/** 把掩码里取出来的值等比缩放到 0~255 */
function scaleMask(value: number, mask: number): number {
  let shift = 0
  while (shift < 32 && (mask & (1 << shift)) === 0) shift += 1
  const max = mask >>> shift
  if (max === 0) return 0
  const raw = (value & mask) >>> shift
  return max === 255 ? raw : Math.round((raw * 255) / max)
}

// ---------------- 兜底入口 ----------------

/** 看这文件是不是 sharp 解不了、需要兜底的那两种（只读文件头判断） */
function sniffFallback(buf: Buffer): 'heif' | 'bmp' | null {
  if (buf.length > 12 && buf.toString('latin1', 4, 8) === 'ftyp') {
    return HEIF_BRANDS.has(buf.toString('latin1', 8, 12)) ? 'heif' : null
  }
  if (buf.length > 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp'
  return null
}

async function decodeFallback(sourcePath: string): Promise<RawImage | null> {
  const info = await stat(sourcePath)
  if (info.size === 0 || info.size > FALLBACK_MAX_BYTES) return null
  const buf = await readFile(sourcePath)
  const kind = sniffFallback(buf)
  if (kind === 'heif') return decodeHeif(buf)
  if (kind === 'bmp') return decodeBmp(buf)
  return null
}

async function generate(sourcePath: string, targetPath: string, opts: GenOptions = THUMB_OPTIONS): Promise<boolean> {
  const tmp = `${targetPath}.tmp`
  try {
    await mkdir(dirname(targetPath), { recursive: true })
    // ① 常规路径：sharp 一把梭（JPEG/PNG/WebP/AVIF/GIF/TIFF/SVG…）
    let ok = false
    try {
      ok = await sharpPathToFile(sourcePath, tmp, opts)
    } catch {
      ok = false
    }
    // ② 兜底：HEIC/HEIF 走 libheif(WASM)，BMP 走自带的极简解码器
    if (!ok) {
      await rm(tmp, { force: true })
      const raw = await decodeFallback(sourcePath)
      if (raw) {
        try {
          ok = await sharpRawToFile(raw, tmp, opts)
        } catch (err) {
          // 兜底解出来的像素喂给 sharp 都失败，基本只可能是内存/参数问题，值得留痕
          console.error('[thumb] 兜底像素编码失败:', basename(sourcePath), errText(err))
          ok = false
        }
      } else {
        console.error('[thumb] 兜底解码没解出内容（不支持的格式或文件损坏）:', basename(sourcePath))
      }
    }
    if (!ok) {
      await rm(tmp, { force: true })
      return false
    }
    await rename(tmp, targetPath)
    return true
  } catch (err) {
    // 注意：sharp 自己失败**不会**走到这里（上面已经 catch 了），
    // 所以这条日志基本只可能是文件系统问题（磁盘满、权限、目标被占用）
    console.error('[thumb] 缩略图落盘失败:', basename(sourcePath), errText(err))
    await rm(tmp, { force: true })
    return false
  }
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

interface ThumbJob {
  id: number
  source: string
  target: string
  /** 最长边与质量；不给就用缩略图的默认值 */
  size?: number
  quality?: number
  /** 'webp' 只给查看器大预览图用；默认 jpeg */
  format?: 'jpeg' | 'webp'
}

process.parentPort?.on('message', (event) => {
  const job = event.data as ThumbJob | undefined
  if (!job || typeof job.id !== 'number') return
  const opts: GenOptions = {
    size: job.size ?? THUMB_SIZE,
    quality: job.quality ?? THUMB_QUALITY,
    format: job.format === 'webp' ? 'webp' : 'jpeg'
  }
  void generate(job.source, job.target, opts)
    .then((ok) => {
      process.parentPort?.postMessage({ id: job.id, ok })
    })
    .catch(() => {
      process.parentPort?.postMessage({ id: job.id, ok: false })
    })
})
