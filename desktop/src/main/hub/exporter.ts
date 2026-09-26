import { copyFile, mkdir, utimes } from 'node:fs/promises'
import { join } from 'node:path'
import type { TaskProgress } from '@shared/types'
import type { Database } from './db'
import { blobPath } from './storage'

export interface ExportContext {
  db: Database
  blobsDir: string
  onProgress: (progress: TaskProgress) => void
}

const PROGRESS_INTERVAL_MS = 150

/**
 * 把仓库中的媒体导出为"和手机一致"的文件夹树：
 * 保留原始文件名与相对目录，并还原文件修改时间。
 */
export async function exportTo(
  ctx: ExportContext,
  targetDir: string,
  query: { deviceId?: string; bucketId?: string },
  taskId: string
): Promise<TaskProgress> {
  const { db } = ctx
  const startedAt = Date.now()
  const rows = db.listForExport(query)

  const progress: TaskProgress = {
    taskId,
    type: 'export',
    phase: 'working',
    rootPath: targetDir,
    total: rows.length,
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

  // 未指定设备（导出全部）时按设备名分目录；合并组（主+副）也按来源设备分目录，避免路径冲突
  const deviceNames = new Map(db.listDevices().map((d) => [d.id, d.name]))
  const groupSize = query.deviceId ? db.groupDeviceIds(query.deviceId).length : 0
  const prefixByDevice = !query.deviceId || groupSize > 1

  for (const row of rows) {
    try {
      const deviceName = prefixByDevice ? deviceNames.get(row.deviceId) ?? row.deviceId : ''
      const baseDir = deviceName ? join(targetDir, deviceName) : targetDir
      const relativeParts = row.relativePath.split('/').filter(Boolean)
      const destDir = join(baseDir, ...relativeParts)
      const destFile = join(destDir, row.displayName)

      await mkdir(destDir, { recursive: true })
      await copyFile(blobPath(ctx.blobsDir, row.blobSha256), destFile)

      const mtime = row.dateModified ?? row.dateTaken
      if (mtime && mtime > 0) {
        const when = new Date(mtime)
        await utimes(destFile, when, when)
      }
      progress.imported += 1
    } catch {
      progress.failed += 1
    }
    progress.processed += 1
    progress.current = row.displayName
    emit()
  }

  progress.phase = 'done'
  progress.current = ''
  progress.finishedAt = Date.now()
  emit(true)
  return { ...progress }
}
