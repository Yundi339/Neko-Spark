import { fileUrl } from '../api'

/**
 * 查看器信息栏用的"详细数据"：分辨率、宽高比、像素、码率、帧率……
 *
 * 码率能直接算（文件大小 ÷ 时长）；**帧率**拿不到现成字段（手机上报的清单里没有），
 * 所以这里自己读 MP4 的盒子：
 *   ① 普通 MP4：`moov → trak(视频轨) → mdhd` 拿 timescale，`stts` 里"采样总数 ÷ 时长"= 平均帧率
 *   ② 分片 MP4（fMP4，下载器和流媒体存的那种：顶层是 ftyp/moov/sidx/moof/mdat…）：
 *      `moov` 里的 `stts` 是**空的**，帧信息在每个 `moof → traf → trun` 里，
 *      所以改从**第一段分片**读单个采样的时长，帧率 = timescale ÷ 采样时长
 * 两条都读不出来（不是 MP4 / 寻址失败 / 盒子被截断）就返回 null ——
 * 信息栏干脆不显示这一行，宁可没有也不能瞎写一个数。
 */

const FPS_CACHE = new Map<number, number | null>()
/** moov 与第一段 moof 一般都在这个范围内 */
const MOOV_CHUNK = 3 * 1024 * 1024

/** 平均码率：文件大小 ÷ 时长 */
export function formatBitrate(bytes?: number, durationMs?: number): string {
  if (!bytes || !durationMs || durationMs <= 0) return '-'
  const bitsPerSecond = (bytes * 8) / (durationMs / 1000)
  if (bitsPerSecond >= 1_000_000) return `${(bitsPerSecond / 1_000_000).toFixed(2)} Mbps`
  if (bitsPerSecond >= 1000) return `${Math.round(bitsPerSecond / 1000)} kbps`
  return `${Math.round(bitsPerSecond)} bps`
}

/** 宽高比：约到常见的几档（16:9 / 4:3 / 21:9 / 1:1 …），约不出来就给小数 */
export function formatAspect(width?: number, height?: number): string {
  if (!width || !height) return '-'
  const ratio = width / height
  const common: [number, string][] = [
    [16 / 9, '16:9'],
    [4 / 3, '4:3'],
    [3 / 2, '3:2'],
    [21 / 9, '21:9'],
    [9 / 16, '9:16'],
    [3 / 4, '3:4'],
    [2 / 3, '2:3'],
    [1, '1:1']
  ]
  for (const [value, label] of common) {
    if (Math.abs(ratio - value) < 0.02) return label
  }
  return `${ratio.toFixed(2)}:1`
}

/** 像素总数（手机相册习惯说"多少万像素"） */
export function formatMegapixels(width?: number, height?: number): string {
  if (!width || !height) return '-'
  const total = width * height
  if (total >= 1_000_000) return `${(total / 10_000).toFixed(0)} 万像素`
  return `${total} 像素`
}

/** 帧率显示：整数就直接写，29.97 / 24.02 这种保留两位 */
export function formatFrameRate(fps: number): string {
  const rounded = Math.round(fps)
  const text = Math.abs(fps - rounded) < 0.05 ? String(rounded) : fps.toFixed(2)
  return `${text} 帧/秒`
}

/** 读 MP4 的平均帧率；读不到返回 null（结果会缓存，同一个视频只读一次） */
export async function probeVideoFrameRate(base: string, id: number, size: number): Promise<number | null> {
  if (FPS_CACHE.has(id)) return FPS_CACHE.get(id) ?? null
  let result: number | null = null
  try {
    result = await readMp4FrameRate(fileUrl(base, id), size)
  } catch {
    result = null
  }
  FPS_CACHE.set(id, result)
  return result
}

async function readMp4FrameRate(url: string, size: number): Promise<number | null> {
  if (!size || size <= 0) return null
  // 先在文件末尾找 moov（手机录的视频基本都在末尾），找不到再看开头
  const tailStart = Math.max(0, size - MOOV_CHUNK)
  const chunks: Uint8Array[] = []
  const tail = await fetchRange(url, tailStart, size - 1)
  if (tail) chunks.push(tail)
  if (tailStart > 0) {
    const head = await fetchRange(url, 0, Math.min(size - 1, MOOV_CHUNK - 1))
    if (head) chunks.push(head)
  }
  for (const chunk of chunks) {
    const moov = findBox(chunk, 'moov')
    if (!moov) continue
    const fps = readFpsFromChunk(chunk, moov)
    if (fps !== null) return fps
  }
  return null
}

async function fetchRange(url: string, start: number, end: number): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } })
    if (!res.ok && res.status !== 206) return null
    return new Uint8Array(await res.arrayBuffer())
  } catch {
    return null
  }
}

/** 在缓冲里定位某个盒子（扫描签名 + 校验盒子长度，避免撞上压缩数据里的巧合字节） */
function findBox(buffer: Uint8Array, type: string): { start: number; size: number } | null {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const a = type.charCodeAt(0)
  const b = type.charCodeAt(1)
  const c = type.charCodeAt(2)
  const d = type.charCodeAt(3)
  for (let p = 0; p + 8 <= buffer.length; p += 1) {
    if (buffer[p + 4] !== a || buffer[p + 5] !== b || buffer[p + 6] !== c || buffer[p + 7] !== d) continue
    const size = view.getUint32(p)
    if (size >= 8 && p + size <= buffer.length) return { start: p, size }
  }
  return null
}

/** 盒子里还能套盒子（要往下找 trak/stbl/stts/moof/traf/trun） */
const CONTAINER_BOXES = new Set([
  'moov',
  'trak',
  'mdia',
  'minf',
  'stbl',
  'edts',
  'dinf',
  'udta',
  'moof',
  'traf',
  'mvex'
])

interface BoxRef {
  type: string
  payloadStart: number
  payloadSize: number
}

function collectBoxes(buffer: Uint8Array, start: number, size: number, out: BoxRef[]): void {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  let offset = start
  const end = start + size
  while (offset + 8 <= end) {
    let boxSize = view.getUint32(offset)
    const type = String.fromCharCode(
      buffer[offset + 4],
      buffer[offset + 5],
      buffer[offset + 6],
      buffer[offset + 7]
    )
    let header = 8
    if (boxSize === 1) {
      if (offset + 16 > end) return
      boxSize = view.getUint32(offset + 8) * 2 ** 32 + view.getUint32(offset + 12)
      header = 16
    } else if (boxSize === 0) {
      boxSize = end - offset
    }
    if (boxSize < header || offset + boxSize > end) return
    out.push({ type, payloadStart: offset + header, payloadSize: boxSize - header })
    if (CONTAINER_BOXES.has(type)) {
      collectBoxes(buffer, offset + header, boxSize - header, out)
    }
    offset += boxSize
  }
}

const ascii = (buffer: Uint8Array, at: number): string =>
  String.fromCharCode(buffer[at], buffer[at + 1], buffer[at + 2], buffer[at + 3])

function timescaleOf(view: DataView, buffer: Uint8Array, mdhd: BoxRef): number {
  const version = buffer[mdhd.payloadStart]
  return view.getUint32(mdhd.payloadStart + (version === 1 ? 20 : 12))
}

/** 从 moov 里挑出视频轨，先按普通 MP4 的 stts 算，不行再按分片 MP4 的 moof/trun 算 */
function readFpsFromChunk(buffer: Uint8Array, moov: { start: number; size: number }): number | null {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  const boxes: BoxRef[] = []
  collectBoxes(buffer, moov.start + 8, moov.size - 8, boxes)

  for (const trak of boxes.filter((box) => box.type === 'trak')) {
    const inside: BoxRef[] = []
    collectBoxes(buffer, trak.payloadStart, trak.payloadSize, inside)

    // 只看视频轨：hdlr 的 handler_type 必须是 'vide'
    const hdlr = inside.find((box) => box.type === 'hdlr')
    if (!hdlr || ascii(buffer, hdlr.payloadStart + 8) !== 'vide') continue
    const mdhd = inside.find((box) => box.type === 'mdhd')
    if (!mdhd) continue
    const timescale = timescaleOf(view, buffer, mdhd)
    if (!timescale) continue

    // ① 普通 MP4
    const stts = inside.find((box) => box.type === 'stts')
    if (stts) {
      const entryCount = view.getUint32(stts.payloadStart + 4)
      let frames = 0
      let totalDelta = 0
      for (let i = 0; i < entryCount; i += 1) {
        const at = stts.payloadStart + 8 + i * 8
        if (at + 8 > buffer.length) break
        const sampleCount = view.getUint32(at)
        const sampleDelta = view.getUint32(at + 4)
        frames += sampleCount
        totalDelta += sampleCount * sampleDelta
      }
      if (frames > 0 && totalDelta > 0) {
        const fps = frames / (totalDelta / timescale)
        if (Number.isFinite(fps) && fps > 0 && fps <= 1000) return fps
      }
    }

    // ② 分片 MP4：moov 里的采样表是空的，帧时长在第一段 moof → 视频轨的 traf → trun 里
    const tkhd = inside.find((box) => box.type === 'tkhd')
    const trackId = tkhd ? trackIdOf(view, buffer, tkhd) : 0
    const fps = fpsFromFirstFragment(buffer, view, trackId, timescale)
    if (fps !== null) return fps
  }
  return null
}

function trackIdOf(view: DataView, buffer: Uint8Array, tkhd: BoxRef): number {
  const version = buffer[tkhd.payloadStart]
  return view.getUint32(tkhd.payloadStart + (version === 1 ? 20 : 12))
}

/**
 * 分片 MP4：读第一段分片里"一个采样的时长"，帧率 = timescale ÷ 采样时长。
 * 时长可能写在 trun 的每采样表里，也可能只在 tfhd 的 default_sample_duration 上。
 */
function fpsFromFirstFragment(
  buffer: Uint8Array,
  view: DataView,
  trackId: number,
  timescale: number
): number | null {
  const moof = findBox(buffer, 'moof')
  if (!moof) return null
  const boxes: BoxRef[] = []
  collectBoxes(buffer, moof.start + 8, moof.size - 8, boxes)

  for (const traf of boxes.filter((box) => box.type === 'traf')) {
    const inside: BoxRef[] = []
    collectBoxes(buffer, traf.payloadStart, traf.payloadSize, inside)
    const tfhd = inside.find((box) => box.type === 'tfhd')
    const trun = inside.find((box) => box.type === 'trun')
    if (!trun) continue

    // tfhd: version/flags(4) + track_ID(4) [+ 一堆可选字段]，flags 决定后面有什么
    if (tfhd) {
      const tfhdFlags = view.getUint32(tfhd.payloadStart) & 0xffffff
      const tfhdTrackId = view.getUint32(tfhd.payloadStart + 4)
      if (trackId && tfhdTrackId !== trackId) continue
      if (tfhdFlags & 0x08) {
        // default_sample_duration：跳过 base_data_offset(0x01)、sample_description_index(0x02)
        let at = tfhd.payloadStart + 8
        if (tfhdFlags & 0x01) at += 8
        if (tfhdFlags & 0x02) at += 4
        const defaultDuration = view.getUint32(at)
        if (defaultDuration > 0) {
          const fps = timescale / defaultDuration
          if (Number.isFinite(fps) && fps > 0 && fps <= 1000) return fps
        }
      }
    }

    const trunFlags = view.getUint32(trun.payloadStart) & 0xffffff
    let at = trun.payloadStart + 8 // version/flags(4) + sample_count(4)
    if (trunFlags & 0x000001) at += 4 // data_offset
    if (trunFlags & 0x000004) at += 4 // first_sample_flags
    if (trunFlags & 0x000100) {
      const sampleDuration = view.getUint32(at)
      if (sampleDuration > 0) {
        const fps = timescale / sampleDuration
        if (Number.isFinite(fps) && fps > 0 && fps <= 1000) return fps
      }
    }
  }
  return null
}
