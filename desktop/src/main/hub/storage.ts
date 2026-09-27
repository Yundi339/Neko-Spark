import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

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

/**
 * 把随安装包发布的素材（空状态大插画 background-*.webp、贴图 stickers/）补进数据目录。
 *
 * 为什么要播种：这些图是**运行时从数据目录读**的（GET /api/v1/background/:n、GET /api/v1/stickers），
 * 安装包里只有程序代码。发行版装到新机器上时数据目录是空的，空状态就只剩文字、
 * 贴图也退化成内置吉祥物 —— 而开发机上看得到，只是因为开发机的数据目录里恰好有这些图。
 *
 * 规则：**只补齐缺失的，绝不覆盖已存在的**。用户自己换过的插画/贴图不能被安装包顶掉，
 * 而且升级重装时也不会把用户的图还原回去。
 *
 * @param sourceDir 安装包里的素材目录（打包后为 resources/assets，开发时为仓库根 GalleryMirrorData）
 * @returns 实际复制了几个文件（0 表示无需播种）
 */
export function seedBundledAssets(paths: StoragePaths, sourceDir: string): number {
  if (!sourceDir || !existsSync(sourceDir)) return 0
  // 开发模式下如果数据目录本身就是素材目录，别自己复制自己
  if (resolve(sourceDir) === resolve(paths.dataDir)) return 0

  let copied = 0
  const copyIfAbsent = (from: string, to: string): void => {
    if (existsSync(to)) return
    try {
      copyFileSync(from, to)
      copied += 1
    } catch {
      // 单个文件失败（只读、占位等）不该拦住启动
    }
  }

  // 背景插画：放在数据目录根下，文件名 background-1.webp … background-N.webp
  for (const name of readdirSync(sourceDir)) {
    if (/^background(-\d+)?\.webp$/i.test(name)) {
      copyIfAbsent(join(sourceDir, name), join(paths.dataDir, name))
    }
  }

  // 用户贴图：放在数据目录 stickers/ 下
  const stickersSource = join(sourceDir, 'stickers')
  if (existsSync(stickersSource)) {
    for (const name of readdirSync(stickersSource)) {
      if (!isStickerFile(name)) continue
      copyIfAbsent(join(stickersSource, name), join(paths.stickersDir, name))
    }
  }

  return copied
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
