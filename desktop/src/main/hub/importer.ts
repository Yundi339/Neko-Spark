import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, mkdir, readdir, rename, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import type { TaskProgress } from '@shared/types'
import type { Database } from './db'
import { blobPath } from './storage'
import { detectKind, guessMime, readImageMetadata } from './media'
import { processPendingThumbs } from './thumbs'
import { readVideoMetadata } from './videoinfo'

export interface ImportContext {
  db: Database
  blobsDir: string
  thumbsDir: string
  excludedDir?: string
  onProgress: (progress: TaskProgress) => void
}

const CONCURRENCY = 4
const PROGRESS_INTERVAL_MS = 150

export function hashFile(filePath: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(filePath, { highWaterMark: 1024 * 1024 })
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolvePromise(hash.digest('hex')))
  })
}

export async function storeBlobFromFile(
  filePath: string,
  blobsDir: string,
  sha256: string
): Promise<void> {
  const dest = blobPath(blobsDir, sha256)
  await mkdir(dirname(dest), { recursive: true })
  const tmp = `${dest}.part`
  await copyFile(filePath, tmp)
  await rename(tmp, dest)
}

async function walk(root: string, excludedDir: string | undefined, out: string[]): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(root, entry.name)
    if (excludedDir) {
      const normalized = resolve(full).toLowerCase()
      if (normalized === excludedDir || normalized.startsWith(`${excludedDir}${sep}`)) continue
    }
    if (entry.isDirectory()) {
      await walk(full, excludedDir, out)
    } else if (entry.isFile()) {
      out.push(full)
    }
  }
  return out
}

function deviceIdFor(rootDir: string): string {
  const hash = createHash('sha1').update(resolve(rootDir).toLowerCase()).digest('hex')
  return `local-${hash.slice(0, 12)}`
}

/**
 * 把本地文件夹导入仓库（开发 / 手动导入用）。
 * 与手机端协议共用相同的落库与去重逻辑。
 */
export async function importFolder(
  ctx: ImportContext,
  rootDir: string,
  taskId: string,
  targetDeviceId?: string
): Promise<TaskProgress> {
  const { db } = ctx
  const startedAt = Date.now()
  const progress: TaskProgress = {
    taskId,
    type: 'import',
    phase: 'scanning',
    rootPath: rootDir,
    total: 0,
    processed: 0,
    imported: 0,
    skipped: 0,
    failed: 0,
    restored: 0,
    current: '',
    startedAt
  }

  let lastEmit = 0
  const emit = (force = false): void => {
    const now = Date.now()
    if (!force && now - lastEmit < PROGRESS_INTERVAL_MS) return
    lastEmit = now
    ctx.onProgress({ ...progress })
  }

  emit(true)

  const files = await walk(rootDir, ctx.excludedDir?.toLowerCase(), [])
  const mediaFiles = files.filter((file) => detectKind(file) !== undefined)
  progress.total = mediaFiles.length
  progress.phase = 'working'
  emit(true)

  const deviceId = targetDeviceId?.trim() || deviceIdFor(rootDir)
  const deviceName = targetDeviceId?.trim()
    ? db.getDevice(targetDeviceId.trim())?.name ?? basename(resolve(rootDir)) ?? rootDir
    : basename(resolve(rootDir)) || rootDir
  db.upsertDevice({ id: deviceId, name: deviceName })

  let cursor = 0
  const importOne = async (file: string): Promise<void> => {
    const kind = detectKind(file)
    if (!kind) return

    const rel = relative(rootDir, file)
    const dir = dirname(rel)
    const relativePath = dir === '.' ? '' : `${dir.split(sep).join('/')}/`
    const displayName = basename(file)
    const st = await stat(file)
    const mtime = Math.round(st.mtimeMs)

    const existing = db.findMedia(deviceId, relativePath, displayName)
    if (existing && existing.size === st.size && existing.dateModified === mtime) {
      progress.skipped += 1
      return
    }

    const sha = await hashFile(file)
    if (!db.blobExists(sha)) {
      await storeBlobFromFile(file, ctx.blobsDir, sha)
      db.insertBlob(sha, st.size, guessMime(file))
    }

    let width: number | undefined
    let height: number | undefined
    let orientation: number | undefined
    let dateTaken: number | undefined
    let durationMs: number | undefined

    if (kind === 'image') {
      const meta = await readImageMetadata(file)
      width = meta.width
      height = meta.height
      orientation = meta.orientation
      dateTaken = meta.dateTaken
    } else if (kind === 'video') {
      // 视频也要宽高/时长，否则界面上格子不显示时长、信息栏"平均码率 -"
      // （纯字节解析 MP4 盒子，**绝不解码视频** —— 见 videoinfo.ts）
      const meta = await readVideoMetadata(file)
      width = meta.width
      height = meta.height
      durationMs = meta.durationMs
    }

    // 手动导入文件夹 = 用户明确要把这些文件加进来：清掉"删除墓碑"，
    // 让它在库里正常出现（否则删过的文件重新导入会被当成已删除而跳过）
    const hadTombstone = db.clearTombstone(deviceId, relativePath, displayName)
    if (hadTombstone) progress.restored += 1

    db.insertMedia({
      deviceId,
      blobSha256: sha,
      displayName,
      relativePath,
      bucketId: relativePath || '/',
      bucketName: relativePath ? relativePath.replace(/\/$/, '').split('/').pop() ?? deviceName : deviceName,
      kind,
      mime: guessMime(file),
      size: st.size,
      width,
      height,
      orientation,
      dateTaken: dateTaken ?? mtime,
      dateModified: mtime,
      dateAdded: Math.round(st.birthtimeMs || st.ctimeMs || mtime),
      durationMs,
      thumbState: kind === 'image' ? 'pending' : 'none'
    })
    progress.imported += 1
  }

  const workers = Array.from({ length: CONCURRENCY }, async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= mediaFiles.length) return
      const file = mediaFiles[index]
      progress.current = relative(rootDir, file)
      try {
        await importOne(file)
      } catch {
        progress.failed += 1
      }
      progress.processed += 1
      emit()
    }
  })

  await Promise.all(workers)

  progress.phase = 'working'
  progress.current = '生成缩略图...'
  emit(true)

  await processPendingThumbs(db, ctx.blobsDir, ctx.thumbsDir, (done, total) => {
    progress.current = `生成缩略图 ${done}/${total}`
    emit()
  })

  db.touchDeviceSync(deviceId)

  progress.phase = 'done'
  progress.current = ''
  progress.finishedAt = Date.now()
  emit(true)
  return { ...progress }
}
