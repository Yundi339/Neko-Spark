/**
 * 找出"会让 sharp 原生崩溃"的场景。
 *
 * 逐个处理 blob 生成缩略图，处理前先把 sha 写进探针文件；
 * 如果进程被 sharp 崩掉，探针文件里留下的就是当前正在处理的那个。
 *
 * 用法：node scripts/_probe-thumb-crash.mjs [并发度] [限定数量]
 *   并发度 1 = 顺序（已验证不崩）
 *   并发度 8 = 模拟应用里"启动补齐 + 界面同时请求缩略图"的并发场景
 */
import { writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join, resolve } from 'node:path'
import sharp from 'sharp'

const CONCURRENCY = Number(process.argv[2] ?? 1)
const LIMIT = Number(process.argv[3] ?? 0)
/** 仓库根 = desktop/ 的上一级。相册库留在仓库根，不跟电脑端走 */
const repoRoot = resolve(import.meta.dirname, '..', '..')
const DATA = join(repoRoot, 'GalleryMirrorData')
const PROBE = join(resolve(import.meta.dirname, '..'), '.cache', 'tmp', 'thumb-probe.txt')
const PROGRESS = join(resolve(import.meta.dirname, '..'), '.cache', 'tmp', 'thumb-progress.txt')

const db = new DatabaseSync(join(DATA, 'manifest.db'), { readOnly: true })
const rows = db
  .prepare(
    `SELECT b.sha256 AS sha, b.size AS size,
            (SELECT display_name FROM media m WHERE m.blob_sha256 = b.sha256 LIMIT 1) AS name
     FROM blobs b`
  )
  .all()
db.close()

const list = LIMIT > 0 ? rows.slice(0, LIMIT) : rows
console.log(`共 ${list.length} 个 blob，并发度 ${CONCURRENCY}，开始生成缩略图...`)
if (CONCURRENCY !== 1) sharp.concurrency(1)

const t0 = Date.now()
let done = 0
let crashing = 0
const inflight = new Set()

const OUT_DIR = join(resolve(import.meta.dirname, '..'), '.cache', 'testdata', 'thumb-out')
mkdirSync(OUT_DIR, { recursive: true })

const one = async (row) => {
  const src = join(DATA, 'blobs', row.sha.slice(0, 2), row.sha)
  if (!existsSync(src)) return
  const tmp = join(OUT_DIR, `${row.sha}.tmp`)
  try {
    // 完全照抄应用里的写法：toFile + rename（而不是 toBuffer）
    await sharp(src, { failOn: 'none', animated: false })
      .rotate()
      .resize(384, 384, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78 })
      .toFile(tmp)
    renameSync(tmp, join(OUT_DIR, `${row.sha}.webp`))
  } catch {
    /* 失败是正常的，忽略 */
  }
}

let cursor = 0
const runner = async () => {
  for (;;) {
    const i = cursor
    cursor += 1
    if (i >= list.length) return
    const row = list[i]
    crashing += 1
    // 记录当前正在处理的（并发下只记录最后进入的，崩了就说明它在场）
    if (crashing % 20 === 0 || CONCURRENCY === 1) {
      writeFileSync(PROBE, `${row.sha}\t${row.name ?? '?'}\n`, 'utf-8')
    }
    inflight.add(row.sha)
    await one(row)
    inflight.delete(row.sha)
    done += 1
    if (done % 200 === 0) {
      writeFileSync(PROGRESS, `${done}/${list.length}  ${((Date.now() - t0) / 1000).toFixed(0)}s\n`, 'utf-8')
      console.log(`  ${done}/${list.length}  ${((Date.now() - t0) / 1000).toFixed(0)}s`)
    }
  }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, list.length) }, runner))
console.log(`全部 ${done} 个处理完，没有崩溃 ✅  用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`)
writeFileSync(PROBE, 'DONE\n', 'utf-8')
