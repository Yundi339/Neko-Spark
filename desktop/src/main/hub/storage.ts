import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export interface StoragePaths {
  dataDir: string
  dbPath: string
  blobsDir: string
  thumbsDir: string
  mirrorDir: string
  tmpDir: string
  uploadsDir: string
  stickersDir: string
}

export function ensureStorage(dataDir: string): StoragePaths {
  const paths: StoragePaths = {
    dataDir,
    dbPath: join(dataDir, 'manifest.db'),
    blobsDir: join(dataDir, 'blobs'),
    thumbsDir: join(dataDir, 'thumbs'),
    mirrorDir: join(dataDir, 'mirror'),
    tmpDir: join(dataDir, 'tmp'),
    uploadsDir: join(dataDir, 'tmp', 'uploads'),
    stickersDir: join(dataDir, 'stickers')
  }
  for (const dir of [
    paths.dataDir,
    paths.blobsDir,
    paths.thumbsDir,
    paths.mirrorDir,
    paths.tmpDir,
    paths.uploadsDir,
    paths.stickersDir
  ]) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  }
  return paths
}

export const STICKER_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif']

export function isStickerFile(name: string): boolean {
  return STICKER_EXTENSIONS.some((ext) => name.toLowerCase().endsWith(ext))
}

export function stickerContentType(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.png')) return 'image/png'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.webp')) return 'image/webp'
  if (lower.endsWith('.gif')) return 'image/gif'
  if (lower.endsWith('.svg')) return 'image/svg+xml'
  if (lower.endsWith('.avif')) return 'image/avif'
  return 'application/octet-stream'
}

/** 内容寻址路径：blobs/<sha前2位>/<sha> */
export function blobPath(blobsDir: string, sha256: string): string {
  return join(blobsDir, sha256.slice(0, 2), sha256)
}

/** 缩略图缓存路径：thumbs/<sha前2位>/<sha>.webp */
export function thumbPath(thumbsDir: string, sha256: string): string {
  return join(thumbsDir, sha256.slice(0, 2), `${sha256}.jpg`)
}

/**
 * 视频首帧：**仍是 webp** —— 那些字节是渲染端用 canvas 编出来的（`toBlob('image/webp')`），
 * 主进程只校验魔数、不解码；换个格式要连渲染端那道生成流程一起改，收益（422 张）也不如缩略图大。
 */
export function videoThumbPath(thumbsDir: string, sha256: string): string {
  return join(thumbsDir, sha256.slice(0, 2), `${sha256}.webp`)
}

/**
 * 查看器用的大预览图：thumbs/<sha前2位>/<sha>.full.webp
 *
 * 为什么需要它（2026-09-24）：Chromium 解不了 DNG / HEIC / TIFF 这些格式，
 * 查看器直接请求 `/file/:id` 拿到原始字节会**静默失败**（"打开什么都没有"）。
 * 所以给这些格式按需生成一张大 webp 缓存下来。
 *
 * 和缩略图放同一个目录、只是多个 `.full` 后缀：这样**删除/清理只需要照顾一个目录**
 * （`removeBlobFiles` 里顺手删掉即可），也省掉一套新的目录初始化。
 * 内容寻址 → 同一个 sha 永远对应同一张图，不需要失效逻辑。
 */
export function previewPath(thumbsDir: string, sha256: string): string {
  return join(thumbsDir, sha256.slice(0, 2), `${sha256}.full.webp`)
}
