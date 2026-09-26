import { open } from 'node:fs/promises'

/**
 * 读视频文件的元数据（时长 / 宽高）—— **纯字节解析 MP4 的盒子，绝不解码视频**。
 *
 * 为什么需要它（2026-09-24 发现）：`importer.ts` 原来只给**图片**读元数据
 * （`if (kind === 'image')`），视频什么都不读 → 从文件夹导入的视频**宽高和时长都是空**，
 * 界面上格子不显示时长、信息栏"平均码率 -"（码率 = 大小 ÷ 时长）。
 * 手机备份过来的视频不受影响（元数据来自 MediaStore 清单），只有"导入文件夹"这条路缺。
 *
 * ⚠️ **绝不能用 sharp / 任何解码器读视频**：libvips 拿视频原文件去解码会原生崩溃、
 * 把整个应用带走（2026-09-24 的闪退就是这么来的）。这里只读盒子的字节。
 *
 * 读法与渲染端 `utils/mediaInfo.ts`（它算帧率）是同一套路数，但**刻意各写一份**：
 * 那边走 HTTP Range 读、要读 stts/moof 算帧率；这边走文件描述符读、只要 mvhd/tkhd。
 * 硬凑成一份共享代码要跨进程传不同的读取器，得不偿失（和 thumb-worker 那边同一个取舍）。
 *
 * 已知不支持：Matroska/WebM（`.mkv`/`.webm`）—— 需要 EBML 解析，用户库里一个都没有，
 * 遇到就返回空（界面上就是"没有时长/分辨率"，不会出错）。
 */
export interface VideoMetadata {
  /**
   * 显示宽高，取自 `tkhd` —— 它**已经包含旋转矩阵**，所以和 Chromium 报的
   * `videoWidth/videoHeight`、以及查看器里实际画出来的画面比例一致。
   * （`stsd` 里的是编码尺寸，竖屏手机视频会是反的，所以不用它。）
   */
  width?: number
  height?: number
  /** 时长（毫秒）。读不出来就不给 —— 宁可没有，也不编一个数 */
  durationMs?: number
}

/** 头部先读这么多找 moov（普通 MP4 一般 moov 在头或在尾） */
const HEAD_BYTES = 256 * 1024
/** 头部没找到时，按这个顺序从文件尾部往前找（手机录的视频 moov 多在末尾） */
const TAIL_STEPS = [4 * 1024 * 1024, 32 * 1024 * 1024]
/** u32 全 1 表示"时长未知"（分片 MP4 常见） */
const UNKNOWN_DURATION = 0xffffffff

/** 盒子里还能套盒子（只列我们往下钻的） */
const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'mvex', 'edts', 'udta', 'moof', 'traf'])

interface Box {
  type: string
  /** 内容（不含 8 或 16 字节头）在这个 buffer 里的起点 */
  start: number
  size: number
}

function readAt(fd: Awaited<ReturnType<typeof open>>, position: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length)
  return fd.read(buf, 0, length, position).then(({ bytesRead }) => buf.subarray(0, bytesRead))
}

/** 从 buffer 的 start 处开始逐个读盒子；碰到越界就停（返回已读到的） */
function walkBoxes(buf: Buffer, from: number, to: number, out: Box[]): void {
  let at = from
  while (at + 8 <= to) {
    let size = buf.readUInt32BE(at)
    const type = buf.toString('latin1', at + 4, at + 8)
    let header = 8
    if (size === 1) {
      if (at + 16 > to) return
      size = Number(buf.readBigUInt64BE(at + 8))
      header = 16
    } else if (size === 0) {
      // size=0 表示"一直到文件末尾"，只有最后一个盒子会这么写
      size = to - at
    }
    if (size < header || at + size > to) return
    out.push({ type, start: at + header, size: size - header })
    if (CONTAINER_BOXES.has(type)) walkBoxes(buf, at + header, at + size, out)
    at += size
  }
}

/**
 * 在窗口里"扫签名"找盒子。⚠️ 用于**尾部窗口** —— 窗口是从文件中间截的，
 * 不能当成盒子起点来走，只能扫签名；扫到之后要按**文件绝对偏移**校验长度
 * （比"装得进窗口"更严：moov 可能比窗口还大）。
 */
function scanBox(buf: Buffer, type: string, base: number, fileSize: number): Box | null {
  for (let at = 0; at + 8 <= buf.length; at += 1) {
    if (buf.toString('latin1', at + 4, at + 8) !== type) continue
    let size = buf.readUInt32BE(at)
    let header = 8
    if (size === 1) {
      if (at + 16 > buf.length) continue
      size = Number(buf.readBigUInt64BE(at + 8))
      header = 16
    }
    if (size < header || base + at + size > fileSize) continue
    return { type, start: at + header, size: size - header }
  }
  return null
}

const readU64 = (buf: Buffer, at: number): number => Number(buf.readBigUInt64BE(at))

/** mvhd：时长与 timescale（版本 0 是 32 位、版本 1 是 64 位） */
function durationFromMvhd(buf: Buffer, mvhd: Box): number | undefined {
  const version = buf[mvhd.start]
  const at = mvhd.start + 4 + (version === 1 ? 16 : 8)
  if (at + 8 > buf.length) return undefined
  const timescale = buf.readUInt32BE(at)
  const duration = version === 1 ? readU64(buf, at + 4) : buf.readUInt32BE(at + 4)
  if (!timescale || !duration || duration === UNKNOWN_DURATION) return undefined
  return Math.round((duration / timescale) * 1000)
}

/**
 * 分片 MP4（下载器存的那种）的 `mvhd.duration` 常是 0 / 未知，
 * 真正的总时长写在 `mvex → mehd` 的 fragment_duration 里。
 */
function durationFromMehd(buf: Buffer, mehd: Box): number | undefined {
  const version = buf[mehd.start]
  const at = mehd.start + 4
  if (at + 4 > buf.length) return undefined
  const fragments = version === 1 ? (at + 8 <= buf.length ? readU64(buf, at) : 0) : buf.readUInt32BE(at)
  return fragments > 0 ? fragments : undefined
}

/** tkhd 的最后 8 个字节就是宽高（16.16 定点数），和版本无关 */
function sizeFromTkhd(buf: Buffer, tkhd: Box): { width: number; height: number } | undefined {
  const end = tkhd.start + tkhd.size
  if (tkhd.size < 8 || end > buf.length) return undefined
  const width = Math.round(buf.readUInt32BE(end - 8) / 65536)
  const height = Math.round(buf.readUInt32BE(end - 4) / 65536)
  if (width <= 0 || height <= 0) return undefined
  return { width, height }
}

function parseMoov(buf: Buffer, moov: Box): VideoMetadata {
  const boxes: Box[] = []
  walkBoxes(buf, moov.start, moov.start + moov.size, boxes)

  const result: VideoMetadata = {}

  const mvhd = boxes.find((b) => b.type === 'mvhd')
  if (mvhd) {
    result.durationMs = durationFromMvhd(buf, mvhd)
  }
  if (!result.durationMs) {
    // mvhd 的时长是时间刻度单位、且可能未知；再试试分片 MP4 的 mehd（它也是时间刻度单位）
    const mehd = boxes.find((b) => b.type === 'mehd')
    if (mehd && mvhd) {
      const version = buf[mvhd.start]
      const at = mvhd.start + 4 + (version === 1 ? 16 : 8)
      const timescale = at + 4 <= buf.length ? buf.readUInt32BE(at) : 0
      const fragments = durationFromMehd(buf, mehd)
      if (timescale && fragments) result.durationMs = Math.round((fragments / timescale) * 1000)
    }
  }

  // 找视频轨：hdlr 的 handler_type 必须是 'vide'，尺寸取它的 tkhd
  for (const trak of boxes.filter((b) => b.type === 'trak')) {
    const inside: Box[] = []
    walkBoxes(buf, trak.start, trak.start + trak.size, inside)
    const hdlr = inside.find((b) => b.type === 'hdlr')
    if (!hdlr || buf.toString('latin1', hdlr.start + 8, hdlr.start + 12) !== 'vide') continue
    const tkhd = inside.find((b) => b.type === 'tkhd')
    if (!tkhd) continue
    const size = sizeFromTkhd(buf, tkhd)
    if (size) {
      result.width = size.width
      result.height = size.height
    }
    break
  }

  return result
}

/** 读一个视频文件的时长与显示宽高；不是 MP4（或读不出来）就返回空对象 */
export async function readVideoMetadata(filePath: string): Promise<VideoMetadata> {
  let fd: Awaited<ReturnType<typeof open>> | null = null
  try {
    fd = await open(filePath, 'r')
    const fileSize = (await fd.stat()).size
    if (fileSize < 32) return {}

    // ① 头部窗口：正经走一遍盒子（能正确处理 64 位 size / size=0 的 mdat）
    const headLength = Math.min(HEAD_BYTES, fileSize)
    const head = await readAt(fd, 0, headLength)
    if (head.length < 8 || head.toString('latin1', 4, 8) !== 'ftyp') return {} // 不是 ISO-BMFF
    if (head.length > 12 && head.toString('latin1', 8, 12).match(/^(heic|heix|mif1|avif|msf1|miaf)$/)) {
      return {} // 是 HEIF 家族的图片，不是视频（缩略图那边另有兜底解码器）
    }
    const headBoxes: Box[] = []
    walkBoxes(head, 0, head.length, headBoxes)
    let moov = headBoxes.find((b) => b.type === 'moov') ?? scanBox(head, 'moov', 0, fileSize)
    let buf = head

    // ② 头部没有就往后找（手机录的视频 moov 常在末尾），窗口逐级放大
    if (!moov) {
      for (const step of TAIL_STEPS) {
        const length = Math.min(step, fileSize)
        const base = fileSize - length
        const tail = await readAt(fd, base, length)
        const found = scanBox(tail, 'moov', base, fileSize)
        if (found) {
          moov = found
          buf = tail
          break
        }
      }
    }
    if (!moov) return {}
    return parseMoov(buf, moov)
  } catch {
    // 读不出来就当没有元数据（导入照常进行，只是界面上少几行）
    return {}
  } finally {
    await fd?.close()
  }
}
