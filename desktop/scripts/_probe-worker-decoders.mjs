/**
 * 诊断探针：**不开 Electron**，直接体检缩略图子进程的兜底解码器（HEIC / BMP）。
 *
 * 做法（省掉开 Electron 的一整圈）：在 Node 里伪造一个 `utilityProcess` 的 parentPort，
 * 再把**编译产物** `out/main/thumb-worker.js` 当普通模块加载，然后按它的消息协议派活。
 * 于是能直接验证「sharp 失败 → 兜底解码 → 出 webp」这条链路，几秒钟出结果。
 *
 * ⚠️ 先跑过 `npm.cmd run build`（要有 out/main/thumb-worker.js）。
 * ⚠️ 读的是**用户真实库**（只读 DB + 只读 blob），但产物写到项目里的 .cache/_worker-test/。
 *
 * 用法：
 *   node scripts/_probe-worker-decoders.mjs [数据目录]
 *   默认数据目录 <项目>\GalleryMirrorData
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * 自己解析 webp 头拿尺寸。
 *
 * ⚠️ 这里**故意不用 sharp** —— 实测（2026-09-24）：libvips 读过的文件会被它
 * mmap/占住句柄，之后在 Windows 上 `rename` 覆盖**必定 EPERM 且不会自行释放**。
 * 本探针是"在同一个进程里假装成 worker 的父进程"，一旦用 sharp 读了产物，
 * 第二轮写同一个目标就会因为 rename 失败而假失败（实测踩过）。
 * 真实流程不受影响：worker 从不读自己写出的缩略图。
 */
function webpSize(buf) {
  if (buf.length < 16 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') return null
  let off = 12
  while (off + 8 <= buf.length) {
    const type = buf.toString('latin1', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    const p = off + 8
    if (type === 'VP8X') {
      return { width: (buf.readUIntLE(p + 4, 3) & 0xffffff) + 1, height: (buf.readUIntLE(p + 7, 3) & 0xffffff) + 1 }
    }
    if (type === 'VP8 ') return { width: buf.readUInt16LE(p + 6) & 0x3fff, height: buf.readUInt16LE(p + 8) & 0x3fff }
    if (type === 'VP8L') {
      const bits = buf.readUInt32LE(p + 1)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    if (size <= 0) break
    off = p + size + (size % 2)
  }
  return null
}

const projectRoot = resolve(import.meta.dirname, '..')
/** 仓库根 = desktop/ 的上一级。相册库留在仓库根，不跟电脑端走 */
const repoRoot = resolve(projectRoot, '..')
const DATA = process.argv[2] || join(repoRoot, 'GalleryMirrorData')
const OUT_DIR = join(projectRoot, '.cache', '_worker-test')
const workerPath = join(projectRoot, 'out', 'main', 'thumb-worker.js')

if (!existsSync(workerPath)) {
  console.log(`找不到编译产物 ${workerPath}\n先跑: npm.cmd run build`)
  process.exit(1)
}

// ---- 伪造 parentPort（worker 靠它收发消息）----
let handler = null
let nextId = 1
const waiting = new Map()
process.parentPort = {
  on: (_event, cb) => {
    handler = cb
  },
  postMessage: (msg) => {
    const done = waiting.get(msg.id)
    if (done) {
      waiting.delete(msg.id)
      done(msg.ok)
    }
  }
}

await import(pathToFileURL(workerPath).href)
if (!handler) {
  console.log('❌ worker 没有注册消息处理器')
  process.exit(1)
}

function run(source, target) {
  const id = nextId++
  return new Promise((res) => {
    waiting.set(id, res)
    handler({ data: { id, source, target } })
  })
}

// ---- 样本：库里那几种"sharp 解不了"的 + 对照组 ----
const db = new DatabaseSync(join(DATA, 'manifest.db'), { readOnly: true })
const pick = (where) => db.prepare(`SELECT display_name, blob_sha256 FROM media WHERE ${where} LIMIT 1`).get()
const samples = []
for (const [label, where] of [
  ['HEIC', "kind='image' AND mime='image/heic'"],
  ['HEIC（第二张）', "kind='image' AND mime IN ('image/heic','image/heif')"],
  ['BMP', "kind='image' AND mime LIKE '%bmp%'"],
  ['JPEG（对照组）', "kind='image' AND mime='image/jpeg'"],
  ['PNG（对照组）', "kind='image' AND mime='image/png'"],
  ['MP4（非图片，应当失败）', "kind='video'"]
]) {
  const rows = db.prepare(`SELECT display_name, blob_sha256 FROM media WHERE ${where} LIMIT 2`).all()
  for (const r of rows) samples.push([`${label} · ${r.display_name.slice(0, 28)}`, r.blob_sha256])
}
void pick
db.close()

if (samples.length === 0) {
  console.log('库里没有可用的样本')
  process.exit(1)
}

rmSync(OUT_DIR, { recursive: true, force: true })
let pass = 0
let fail = 0
for (const [label, sha] of samples) {
  const source = join(DATA, 'blobs', sha.slice(0, 2), sha)
  const target = join(OUT_DIR, `${sha.slice(0, 8)}.webp`)
  const t0 = Date.now()
  const ok = await run(source, target)
  const ms = Date.now() - t0
  let extra = ''
  if (ok && existsSync(target)) {
    const size = webpSize(readFileSync(target))
    extra = size
      ? `→ webp ${size.width}x${size.height} ${statSync(target).size}B`
      : `→ ⚠️ 产物不是合法 webp（${statSync(target).size}B）`
  }
  const expectFail = label.includes('应当失败')
  const good = expectFail ? !ok : ok
  if (good) pass += 1
  else fail += 1
  console.log(`${good ? '✅' : '❌'} ${label.padEnd(40)} ${String(ms).padStart(5)}ms ${extra}`)
}
console.log(`\n${pass} 通过 / ${fail} 失败   产物在 ${OUT_DIR}`)
process.exit(fail === 0 ? 0 : 1)
