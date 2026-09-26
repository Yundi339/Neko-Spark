/**
 * 诊断探针：把库里所有视频的「容器 / 视频编码 / 音频编码」量一遍。
 *
 * 为什么需要它（2026-09-24）：用户说"有些视频的音频是 flac，要可以播放"，
 * 但**不能靠猜** —— 扫一遍才知道库里到底有没有 FLAC、有多少 HEVC、有没有 MKV。
 * 那次扫描的结论是：422 个视频全是 MP4、音频全是 AAC(410)/无音轨(12)、FLAC 一个都没有，
 * 用户说的那个文件其实在 `E:\QQ\`（PC 上的下载文件，没在库里）。
 *
 * 读取策略：每个文件只读头部 128KB；**只有 MP4** 才再读尾部 2MB 找 `moov`
 * （手机录的视频 moov 常在末尾）。全程 fd + seek，绝不把 4GB 的文件读进内存。
 * ⚠️ moov 也可能在文件更靠中间的位置（见过 219MB 的文件 moov 在最后 6.7MB），
 *    真遇到"moov 没找到"就用 `_probe-file-boxes.mjs` 单独挖。
 *
 * 用法：
 *   node scripts/_probe-video-codecs.mjs [数据目录]
 *   默认数据目录 <项目>\GalleryMirrorData
 */
import { DatabaseSync } from 'node:sqlite'
import { openSync, readSync, closeSync, fstatSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** 仓库根 = desktop/ 的上一级。相册库留在仓库根，不跟电脑端走 */
const repoRoot = resolve(import.meta.dirname, '..', '..')
const DATA = process.argv[2] || join(repoRoot, 'GalleryMirrorData')
const HEAD = 128 * 1024
const TAIL = 2 * 1024 * 1024

const db = new DatabaseSync(join(DATA, 'manifest.db'), { readOnly: true })
const rows = db
  .prepare("SELECT id,display_name,size,duration_ms,blob_sha256 FROM media WHERE deleted=0 AND kind='video'")
  .all()

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len)
  const got = readSync(fd, b, 0, len, pos)
  return b.subarray(0, got)
}
const ascii = (b, from, to) => b.toString('latin1', from, to)

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta', 'moof', 'traf', 'mvex'])
function walk(buf, start, end, out) {
  let off = start
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off)
    const type = ascii(buf, off + 4, off + 8)
    let header = 8
    if (size === 1) {
      if (off + 16 > end) return
      size = Number(buf.readBigUInt64BE(off + 8))
      header = 16
    } else if (size === 0) size = end - off
    if (size < header || off + size > end) return
    out.push({ type, ps: off + header, pz: size - header })
    if (CONTAINERS.has(type)) walk(buf, off + header, off + size, out)
    off += size
  }
}
function findBox(buf, type) {
  for (let p = 0; p + 8 <= buf.length; p += 1) {
    if (ascii(buf, p + 4, p + 8) !== type) continue
    const size = buf.readUInt32BE(p)
    if (size >= 8 && p + size <= buf.length) return { start: p, size }
  }
  return null
}
/** 从 moov 里取每条轨道的 [handler 类型, 采样条目 fourcc] */
function tracksOf(buf, moov) {
  const boxes = []
  walk(buf, moov.start + 8, moov.start + moov.size, boxes)
  const out = []
  for (const trak of boxes.filter((b) => b.type === 'trak')) {
    const inside = []
    walk(buf, trak.ps, trak.ps + trak.pz, inside)
    const hdlr = inside.find((b) => b.type === 'hdlr')
    const kind = hdlr ? ascii(buf, hdlr.ps + 8, hdlr.ps + 12) : '?'
    const stsd = inside.find((b) => b.type === 'stsd')
    let fourcc = '?'
    if (stsd && buf.readUInt32BE(stsd.ps + 4) > 0) fourcc = ascii(buf, stsd.ps + 12, stsd.ps + 16)
    out.push({ kind, fourcc })
  }
  return out
}

const containers = new Map()
const videoCodecs = new Map()
const audioCodecs = new Map()
const rowsOut = []
let noMoov = 0
let noAudio = 0
let bytesRead = 0

for (const r of rows) {
  const p = join(DATA, 'blobs', r.blob_sha256.slice(0, 2), r.blob_sha256)
  const fd = openSync(p, 'r')
  let head, tail, size
  try {
    size = fstatSync(fd).size
    head = readAt(fd, 0, Math.min(HEAD, size))
    bytesRead += head.length
    const tailLen = Math.min(TAIL, size)
    tail = tailLen > HEAD ? readAt(fd, size - tailLen, tailLen) : Buffer.alloc(0)
    bytesRead += tail.length
  } finally {
    closeSync(fd)
  }

  const isMp4 = ascii(head, 4, 8) === 'ftyp' && !['heic', 'heix', 'mif1', 'avif'].includes(ascii(head, 8, 12))
  const isMkv = ascii(head, 0, 4) === 'EBML'
  const container = isMp4
    ? 'MP4/' + ascii(head, 8, 12).trim()
    : isMkv
      ? 'Matroska(webm/mkv)'
      : 'OTHER:' + head.toString('hex', 0, 8)
  containers.set(container, (containers.get(container) ?? 0) + 1)

  let video = '?'
  let audios = []
  let note = ''
  if (isMp4) {
    let found = null
    const inTail = findBox(tail, 'moov')
    if (inTail && tail.length) found = { buf: tail, box: inTail }
    else {
      const inHead = findBox(head, 'moov')
      if (inHead) found = { buf: head, box: inHead }
    }
    if (!found) {
      noMoov += 1
      note = 'moov没找到'
    } else {
      const tracks = tracksOf(found.buf, found.box)
      video = tracks.find((t) => t.kind === 'vide')?.fourcc ?? '无视频轨'
      audios = tracks.filter((t) => t.kind === 'soun').map((t) => t.fourcc)
      if (audios.length === 0) noAudio += 1
    }
  } else if (isMkv) {
    // Matroska：在头部 128KB 里抓 CodecID 字符串（够用；Tracks 一般在靠近开头的位置）
    const ids = [...new Set(head.toString('latin1').match(/[AV]_[A-Z0-9_/.-]{2,20}/g) ?? [])]
    video = ids.find((s) => s.startsWith('V_')) ?? '?'
    audios = ids.filter((s) => s.startsWith('A_'))
    if (audios.length === 0) {
      noAudio += 1
      note = 'Tracks不在头部128KB'
    }
  }

  videoCodecs.set(video, (videoCodecs.get(video) ?? 0) + 1)
  const label = audios.length ? audios.join('+') : '（无音频轨）'
  audioCodecs.set(label, (audioCodecs.get(label) ?? 0) + 1)

  // 值得关注的：非 MP4、音频不是纯 AAC（mp4a）、或有异常
  if (!isMp4 || !(audios.length === 1 && audios[0] === 'mp4a') || note) {
    rowsOut.push(
      `[${r.id}] ${(r.size / 1048576).toFixed(1)}MB ${container} 视频=${video} 音频=${label}${note ? ' ⚠️' + note : ''} ${r.display_name}`
    )
  }
}

const dump = (m, title) => {
  console.log(`\n${title}`)
  for (const [k, v] of [...m.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(v).padStart(4)}  ${k}`)
  }
}
console.log(
  `视频 ${rows.length} 个 · 无音频轨 ${noAudio} · moov 没找到 ${noMoov} · 共读 ${(bytesRead / 1048576).toFixed(0)}MB`
)
dump(containers, '① 容器分布：')
dump(videoCodecs, '② 视频编码分布：')
dump(audioCodecs, '③ 音频编码分布：')
console.log(`\n④ 需要关注的（非纯 AAC / 非 MP4 / 有异常）：${rowsOut.length} 个`)
for (const l of rowsOut.slice(0, 50)) console.log('  ' + l)
if (rowsOut.length > 50) console.log(`  …还有 ${rowsOut.length - 50} 个`)
db.close()
