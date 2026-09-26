import { existsSync } from 'node:fs'
import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import sharp from 'sharp'
import type { Database } from './db'
import { blobPath, previewPath, thumbPath } from './storage'
import { MAX_WORKERS, thumbPool } from './thumb-pool'

const THUMB_SIZE = 384
/** JPEG 质量：90 ≈ 原来 WebP 78 的观感，清晰度不变但解码快 3.2 倍 */
const THUMB_JPEG_QUALITY = 90

/**
 * 缩略图生成的并发度。
 *
 * 实测（2026-09-24，12 核）：串行生成 500 张缩略图花了 29.7 秒、只占 1.1 个核。
 * 因为原来是「生成一张 → await → 再生成下一张」，libvips 的多核能力完全没用上。
 * 改成并行后能把这块时间压到 1/4 左右。
 *
 * 注意实际并行度由**子进程池**（thumb-pool.ts 的 MAX_WORKERS）决定，这里只是
 * JS 层一次性派发多少张 —— 派多了也无妨，池会排队。
 */
const THUMB_CONCURRENCY = MAX_WORKERS * 2

// 单张缩略图没必要在 libvips 内部再并行；让"多进程并行"去吃掉多核，
// 总吞吐更高（libvips 官方推荐的用法）。子进程里跑的就是这里的代码。
sharp.concurrency(1)

/**
 * 主进程调用：把生成任务扔给子进程池。
 * **这样做是为了防闪退** —— sharp 原生崩溃不会波及主程序，最坏只损失这一张缩略图。
 */
function generateIsolated(sourcePath: string, targetPath: string): Promise<boolean> {
  return thumbPool.generate(sourcePath, targetPath)
}

/** 固定并发度的任务池（不一次把所有任务都丢出去，避免打爆内存/文件句柄） */
async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      await worker(items[index])
    }
  })
  await Promise.all(runners)
}

/**
 * 生成单个缩略图（webp）。失败返回 false。
 *
 * ⚠️ 这个函数**只应该在子进程里跑**（`thumb-worker.ts` 调用它）。
 * 主进程要生成缩略图请用 `generateIsolated` —— 直接在主进程调 sharp 的话，
 * 它偶发的原生崩溃会把整个应用带走。
 *
 * ⚠️ 2026-09-24 起，**真正在跑的是 `thumb-worker.ts` 里那一份**（它必须自我包含，
 * 不能 import 本文件）。HEIC / BMP 的兜底解码器也加在那边 —— 包括 libheif-js(WASM)
 * 解 HEIC、自己解的极简 BMP。这里保持"只有 sharp"是**故意的对照版**，
 * 但**没有调用方**：改缩略图逻辑请改 `thumb-worker.ts`，别只改这里。
 */
export async function generateThumbnail(sourcePath: string, targetPath: string): Promise<boolean> {
  const tmp = `${targetPath}.tmp`
  try {
    await mkdir(dirname(targetPath), { recursive: true })
    await sharp(sourcePath, { failOn: 'none', animated: false })
      .rotate()
      .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: THUMB_JPEG_QUALITY, progressive: false })
      .toFile(tmp)
    await rename(tmp, targetPath)
    return true
  } catch {
    await rm(tmp, { force: true })
    return false
  }
}

/**
 * 批量补齐待生成的缩略图。
 * @param limit 大于 0 时最多处理这么多个就返回。
 *   手机还在上传时会边收边补，无上限的话会一直追着新文件跑个不停，所以后台补图要带上限。
 * @returns 本次实际处理的数量
 */
export async function processPendingThumbs(
  db: Database,
  blobsDir: string,
  thumbsDir: string,
  onProgress?: (done: number, total: number) => void,
  limit = 0
): Promise<number> {
  const total = db.countPendingThumbs()
  if (total === 0) return 0

  let done = 0
  let reachedLimit = false
  for (;;) {
    const batch = db.pendingThumbs(50)
    if (batch.length === 0) break

    // 交给子进程池并行生成（原来是主进程里一张一张 await，既慢又会被原生崩溃带走）
    await runPool(batch, THUMB_CONCURRENCY, async (item) => {
      if (reachedLimit) return
      const source = blobPath(blobsDir, item.blobSha256)
      const target = thumbPath(thumbsDir, item.blobSha256)
      const ok = await generateIsolated(source, target)
      db.setThumbState(item.id, ok ? 'ready' : 'failed')
      done += 1
      onProgress?.(done, total)
      if (limit > 0 && done >= limit) reachedLimit = true
    })

    if (reachedLimit) return done
  }

  return done
}

/** 按需生成单个缩略图（HTTP 请求时用） */
export async function ensureThumbnail(
  db: Database,
  blobsDir: string,
  thumbsDir: string,
  mediaId: number,
  blobSha256: string
): Promise<string | null> {
  const target = thumbPath(thumbsDir, blobSha256)
  const source = blobPath(blobsDir, blobSha256)
  const ok = await generateIsolated(source, target)
  db.setThumbState(mediaId, ok ? 'ready' : 'failed')
  return ok ? target : null
}

/** 查看器大预览图的最长边与质量 */
const PREVIEW_SIZE = 2560
const PREVIEW_QUALITY = 82



/**
 * 查看器用的大预览图（webp），按需生成 + 落盘缓存。
 *
 * 为什么需要它：**Chromium 解不了 DNG / HEIC / HEIF / TIFF 这些格式**，
 * 查看器直接 `<img src="/file/:id">` 拿到原始字节会静默失败 —— 界面表现就是
 * "点开什么都没有"。这里生成一张最长边 2560 的 webp 给它显示。
 *
 * ⚠️ `/file/:id` 的语义**一个字节都不能改**：手机恢复（回写相册）要的是原始字节，
 * 协议明确承诺"不转码、不压缩、不改名"。所以预览图是**另一条路**（`/preview/:id`）。
 *
 * 缓存靠"文件在不在"判断（内容寻址 → 同 sha 永远同一张图，不需要失效逻辑），
 * 也**不写 DB**：生成失败就是 404，渲染端会退回去请求原文件（不改变原有行为）。
 */
export async function ensurePreview(
  thumbsDir: string,
  blobsDir: string,
  blobSha256: string
): Promise<string | null> {
  const target = previewPath(thumbsDir, blobSha256)
  if (existsSync(target)) return target
  const source = blobPath(blobsDir, blobSha256)
  // 预览图仍是 webp（路径 .full.webp 不变）；缩略图那边走默认的 JPEG
  const ok = await thumbPool.generate(source, target, { size: PREVIEW_SIZE, quality: PREVIEW_QUALITY, format: 'webp' })
  return ok ? target : null
}
