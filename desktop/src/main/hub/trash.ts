import { rm } from 'node:fs/promises'
import { TRASH_RETENTION_MS, type TrashActionResult } from '@shared/types'
import type { Database } from './db'
import { blobPath, previewPath, thumbPath, videoThumbPath, type StoragePaths } from './storage'

/**
 * 回收站：把"用户主动删除"和"手机端已删除标记（source_deleted）"彻底分开。
 *
 * - source_deleted：手机上删了，电脑**保留备份**，只打标记（老功能，一行没动）
 * - 回收站（media.deleted = 1）：用户主动删掉的，30 天内可恢复，到期自动彻底删除
 *
 * 内容的去重关系决定了"彻底删除"不能简单删文件：同一个 sha 可能挂着好几条记录
 * （同一张图存在两个相册 / 两台手机都有一份），必须引用归零才动磁盘。
 */

/** 删掉内容对应的磁盘文件（原文件 + 缩略图 + 查看器大预览图）。文件不在了也不报错 */
export async function removeBlobFiles(paths: StoragePaths, shas: string[]): Promise<void> {
  for (const sha of shas) {
    try {
      await rm(blobPath(paths.blobsDir, sha), { force: true })
    } catch {
      // 单个文件删不掉不影响其它（下次再删一次即可，记录已经没了）
    }
    try {
      await rm(thumbPath(paths.thumbsDir, sha), { force: true })
    } catch {
      // 缩略图同理
    }
    try {
      await rm(videoThumbPath(paths.thumbsDir, sha), { force: true })
    } catch {
      // 视频首帧（仍是 webp）同理
    }
    try {
      await rm(previewPath(paths.thumbsDir, sha), { force: true })
    } catch {
      // 大预览图同理
    }
  }
}

/** 移入回收站（软删除）：只改标记，文件一个字节都不动 */
export function trashMedia(db: Database, ids: number[]): TrashActionResult {
  const count = db.trashMedia(ids)
  return { ok: true, count }
}

/** 从回收站恢复：回到原来的相册位置 */
export function restoreMedia(db: Database, ids: number[]): TrashActionResult {
  const count = db.restoreMedia(ids)
  return { ok: true, count }
}

/** 彻底删除（用户在回收站里再删一次）：记录 + 磁盘文件一起清 */
export async function purgeTrash(
  db: Database,
  paths: StoragePaths,
  ids: number[]
): Promise<TrashActionResult> {
  const { count, blobs, freedBytes } = db.purgeMedia(ids)
  await removeBlobFiles(paths, blobs)
  return { ok: true, count, freedBytes }
}

/**
 * 到期自动清理：超过保留天数的条目彻底删除。
 * 启动时跑一次 + 打开回收站时顺手跑一次（惰性），不需要常驻定时器也能保证界面干净。
 */
export async function sweepExpiredTrash(
  db: Database,
  paths: StoragePaths,
  now = Date.now()
): Promise<TrashActionResult> {
  const ids = db.expiredTrashIds(now - TRASH_RETENTION_MS)
  if (ids.length === 0) return { ok: true, count: 0, freedBytes: 0 }
  return purgeTrash(db, paths, ids)
}
