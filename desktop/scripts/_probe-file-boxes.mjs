/**
 * 诊断探针：把**单个媒体文件**解剖开看（容器 / 顶层盒子 / 每条轨道的编码 / 关键签名）。
 *
 * 为什么需要它（2026-09-24）：`_probe-video-codecs.mjs` 是用"头部 128KB + 尾部 2MB"的窗口找 moov 的，
 * 有些文件的 moov 落在更靠中间的位置，会报"moov 没找到"、看起来像文件坏了 —— 用这个探针
 * 把窗口开大（`GM_TAIL_MB`）就能确认它其实完全正常。
 * 那次就是靠它看出：219MB 的那个文件，moov 在**最后 6.7MB**；而 `E:\QQ\` 那个样本是 **AV1 + FLAC**。
 *
 * 只读头尾窗口、绝不整文件读入（4GB 的视频也能安全解剖）。
 *
 * 用法：
 *   node scripts/_probe-file-boxes.mjs "<文件路径>" ["<文件路径>" ...]
 *   GM_TAIL_MB=120 node scripts/_probe-file-boxes.mjs "<大文件>"     # 尾部窗口开大到 120MB
 */
import { openSync, readSync, closeSync, fstatSync } from 'node:fs'

const HEAD = 512 * 1024
const TAIL = Number(process.env.GM_TAIL_MB || 16) * 1024 * 1024
const files = process.argv.slice(2)
if (files.length === 0) {
  console.log('用法: node scripts/_probe-file-boxes.mjs "<文件路径>" [...]')
  process.exit(1)
}

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len)
  const got = readSync(fd, b, 0, len, pos)
  return b.subarray(0, got)
}
const ascii = (b, f, t) => b.toString('latin1', f, t)
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
    out.push({ type, ps: off + header, pz: size - header, at: off })
    if (CONTAINERS.has(type)) walk(buf, off + header, off + size, out)
    off += size
  }
}

for (const p of files) {
  console.log('\n' + '='.repeat(70) + '\n' + p)
  let fd
  try {
    fd = openSync(p, 'r')
  } catch (e) {
    console.log('  ❌ 打不开:', e.message)
    continue
  }
  let size, head, tail
  try {
    size = fstatSync(fd).size
    head = readAt(fd, 0, Math.min(HEAD, size))
    const tailLen = Math.min(TAIL, size)
    tail = tailLen > HEAD ? readAt(fd, size - tailLen, tailLen) : Buffer.alloc(0)
  } finally {
    closeSync(fd)
  }
  console.log(
    `  大小 ${(size / 1048576).toFixed(1)}MB  (头 ${(head.length / 1024).toFixed(0)}KB / 尾 ${(tail.length / 1048576).toFixed(1)}MB 已读)`
  )
  console.log(`  magic: ${head.toString('hex', 0, 16)}`)

  // 在头、尾两个窗口里分别找 moov，并把窗口坐标换算回文件绝对坐标
  for (const [label, buf, base] of [
    ['头部', head, 0],
    ['尾部', tail, size - tail.length]
  ]) {
    const boxes = []
    walk(buf, 0, buf.length, boxes)
    const stash = boxes.filter((b) => b.type === 'moov')
    if (!stash.length) continue
    // 窗口可能只截到 moov 的一部分，取最大的那个
    const moov = stash.sort((a, b) => b.pz - a.pz)[0]
    console.log(`  moov 在${label}（文件偏移 ${base + moov.at}，长度 ${moov.pz}）`)
    const inside = []
    walk(buf, moov.ps, moov.ps + moov.pz, inside)
    for (const trak of inside.filter((b) => b.type === 'trak')) {
      const t = []
      walk(buf, trak.ps, trak.ps + trak.pz, t)
      const hdlr = t.find((b) => b.type === 'hdlr')
      const kind = hdlr ? ascii(buf, hdlr.ps + 8, hdlr.ps + 12) : '?'
      const hdlrName =
        hdlr && hdlr.pz > 24 ? ascii(buf, hdlr.ps + 24, hdlr.ps + hdlr.pz).replace(/\0/g, '') : ''
      const stsd = t.find((b) => b.type === 'stsd')
      const entries = []
      if (stsd) {
        const n = buf.readUInt32BE(stsd.ps + 4)
        let off = stsd.ps + 8
        for (let i = 0; i < n && off + 8 <= buf.length; i += 1) {
          const esz = buf.readUInt32BE(off)
          entries.push(ascii(buf, off + 4, off + 8))
          if (esz < 8) break
          off += esz
        }
      }
      const mdhd = t.find((b) => b.type === 'mdhd')
      let dur = ''
      if (mdhd) {
        const v = buf[mdhd.ps]
        const ts = buf.readUInt32BE(mdhd.ps + (v === 1 ? 20 : 12))
        const d = v === 1 ? Number(buf.readBigUInt64BE(mdhd.ps + 24)) : buf.readUInt32BE(mdhd.ps + 16)
        dur = `${(d / ts).toFixed(1)}s`
      }
      console.log(
        `    trak handler=${kind} 编码=${entries.join(',') || '(空)'} 时长=${dur}` +
          `${hdlrName && hdlrName !== kind ? ' name=' + hdlrName : ''}`
      )
    }
    break
  }

  // 关键编码签名（只在已读的两个窗口里裸搜，够判断了）
  const sigs = [
    'fLaC', 'dfLa', 'alac', 'Opus', 'mp4a', 'hvc1', 'hev1', 'avc1', 'av01',
    'vp09', 'dtsc', 'dtsh', 'ac-3', 'ec-3', 'lpcm', 'twos', 'sowt'
  ]
  const hay = Buffer.concat([head, tail]).toString('latin1')
  const hits = sigs.map((s) => [s, hay.split(s).length - 1]).filter(([, n]) => n > 0)
  console.log('  签名出现:', hits.map(([s, n]) => `${s}×${n}`).join(' '))
}
