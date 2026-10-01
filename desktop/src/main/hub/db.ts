import { DatabaseSync } from 'node:sqlite'
import {
  TRASH_RETENTION_MS,
  type AlbumRecord,
  type DeviceRecord,
  type MediaKind,
  type MediaRecord,
  type StorageCounts,
  type ThumbState
} from '@shared/types'

const SCHEMA_VERSION = '3'

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  model        TEXT,
  android_id   TEXT,
  merged_into  TEXT,
  last_sync_at INTEGER,
  created_at   INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS blobs (
  sha256     TEXT PRIMARY KEY,
  size       INTEGER NOT NULL,
  mime       TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS media (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id     TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  blob_sha256   TEXT NOT NULL REFERENCES blobs(sha256) ON DELETE RESTRICT,
  display_name  TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  bucket_id     TEXT,
  bucket_name   TEXT,
  kind          TEXT NOT NULL DEFAULT 'image',
  mime          TEXT,
  size          INTEGER NOT NULL DEFAULT 0,
  width         INTEGER,
  height        INTEGER,
  orientation   INTEGER,
  date_taken    INTEGER,
  date_modified INTEGER,
  date_added    INTEGER,
  is_favorite   INTEGER NOT NULL DEFAULT 0,
  is_motion     INTEGER NOT NULL DEFAULT 0,
  duration_ms   INTEGER,
  thumb_state   TEXT NOT NULL DEFAULT 'none',
  deleted       INTEGER NOT NULL DEFAULT 0,
  deleted_at    INTEGER,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  UNIQUE (device_id, relative_path, display_name)
);

CREATE INDEX IF NOT EXISTS idx_media_device_date ON media(device_id, date_taken DESC);
CREATE INDEX IF NOT EXISTS idx_media_bucket ON media(device_id, bucket_id);
CREATE INDEX IF NOT EXISTS idx_media_blob ON media(blob_sha256);
CREATE INDEX IF NOT EXISTS idx_media_kind ON media(device_id, kind);
CREATE INDEX IF NOT EXISTS idx_media_fav ON media(device_id, is_favorite);
/* ⚠️ idx_media_deleted 不能写在这里：老库还没有 deleted_at 列，而 SCHEMA 比 migrate() 先执行，
   在缺列的库上建索引会直接抛错、应用起不来。它放在 migrate() 里（见那段）。 */

/*
 * 「已删除」墓碑：用户删掉一张照片后，手机下次备份又把它传回来 —— 那会很烦人。
 * 这里按 (设备, 相对路径, 文件名) 记住"这条被用户删过"，清单/入库时跳过。
 * 只在用户主动"恢复"或**手动导入文件夹**时清除（手动导入是明确意图，应该生效）。
 * purged_at：文件已被彻底删除的时间（墓碑仍然留着，继续挡住自动备份）。
 */
CREATE TABLE IF NOT EXISTS tombstones (
  device_id     TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  blob_sha256   TEXT,
  deleted_at    INTEGER NOT NULL,
  purged_at     INTEGER,
  PRIMARY KEY (device_id, relative_path, display_name)
);

CREATE TABLE IF NOT EXISTS albums (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id      TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  bucket_id      TEXT NOT NULL,
  bucket_name    TEXT,
  relative_path  TEXT,
  cover_media_id INTEGER REFERENCES media(id),
  UNIQUE (device_id, bucket_id)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
`

export interface NewMediaInput {
  deviceId: string
  blobSha256: string
  displayName: string
  relativePath: string
  bucketId: string
  bucketName: string
  kind: MediaKind
  mime: string
  size: number
  width?: number
  height?: number
  orientation?: number
  dateTaken?: number
  dateModified?: number
  dateAdded?: number
  isFavorite?: boolean
  isMotion?: boolean
  durationMs?: number
  thumbState?: ThumbState
}

export interface ExportRow {
  id: number
  deviceId: string
  blobSha256: string
  displayName: string
  relativePath: string
  dateModified?: number
  dateTaken?: number
}

interface MediaRow {
  id: number
  device_id: string
  blob_sha256: string
  display_name: string
  relative_path: string
  bucket_id: string
  bucket_name: string
  kind: string
  mime: string
  size: number
  width: number | null
  height: number | null
  orientation: number | null
  date_taken: number | null
  date_modified: number | null
  date_added: number | null
  is_favorite: number
  is_motion: number
  duration_ms: number | null
  thumb_state: string
  source_deleted: number
  deleted: number
  deleted_at: number | null
}

function toMediaRecord(row: MediaRow): MediaRecord {
  return {
    id: row.id,
    deviceId: row.device_id,
    displayName: row.display_name,
    relativePath: row.relative_path,
    bucketId: row.bucket_id,
    bucketName: row.bucket_name,
    kind: (row.kind === 'video' ? 'video' : 'image') as MediaKind,
    mime: row.mime,
    size: row.size,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    orientation: row.orientation ?? undefined,
    dateTaken: row.date_taken ?? undefined,
    dateModified: row.date_modified ?? undefined,
    dateAdded: row.date_added ?? undefined,
    isFavorite: row.is_favorite === 1,
    isMotionPhoto: row.is_motion === 1,
    durationMs: row.duration_ms ?? undefined,
    thumbState: (row.thumb_state || 'none') as ThumbState,
    sourceDeleted: (row.source_deleted ?? 0) === 1,
    deletedAt: row.deleted_at ?? undefined,
    // 到期时间由服务端统一算：保留天数只在 shared/types.ts 里定义一处
    purgeAt: row.deleted_at ? row.deleted_at + TRASH_RETENTION_MS : undefined
  }
}

export class Database {
  readonly raw: DatabaseSync

  constructor(dbPath: string) {
    this.raw = new DatabaseSync(dbPath)
    this.raw.exec(SCHEMA)
    this.migrate()
    this.setMeta('schema_version', SCHEMA_VERSION)
  }

  private migrate(): void {
    const columns = this.raw.prepare('PRAGMA table_info(media)').all() as { name: string }[]
    const names = new Set(columns.map((c) => c.name))
    if (!names.has('kind')) {
      this.raw.exec("ALTER TABLE media ADD COLUMN kind TEXT NOT NULL DEFAULT 'image'")
    }
    if (!names.has('thumb_state')) {
      this.raw.exec("ALTER TABLE media ADD COLUMN thumb_state TEXT NOT NULL DEFAULT 'none'")
    }
    if (!names.has('source_deleted')) {
      this.raw.exec('ALTER TABLE media ADD COLUMN source_deleted INTEGER NOT NULL DEFAULT 0')
    }
    if (!names.has('deleted_at')) {
      this.raw.exec('ALTER TABLE media ADD COLUMN deleted_at INTEGER')
    }
    // 索引和表都在 SCHEMA 里带 IF NOT EXISTS，但 SCHEMA 只在建库时跑一次老库拿不到新索引，
    // 这里补一遍（重复执行是幂等的）
    this.raw.exec('CREATE INDEX IF NOT EXISTS idx_media_deleted ON media(deleted, deleted_at DESC)')

    const deviceColumns = this.raw.prepare('PRAGMA table_info(devices)').all() as { name: string }[]
    const deviceNames = new Set(deviceColumns.map((c) => c.name))
    if (!deviceNames.has('merged_into')) {
      this.raw.exec('ALTER TABLE devices ADD COLUMN merged_into TEXT')
    }

    // ------------------------------------------------------------------
    // 一次性重试：老版本里 HEIC / BMP 的缩略图**必定失败**（sharp 预编译的解不了这两种：
    // HEIC 缺 HEVC 解码器、BMP 没有加载器），库里于是留下一批 thumb_state='failed'。
    // 现在子进程里加了兜底解码器（HEIC 走 libheif-js WASM、BMP 自己解），
    // 把历史失败的重置回 'none'，让启动时的 processPendingThumbs 重新生成一次。
    //
    // ⚠️ 为什么不在 pendingThumbs() 里直接带上 'failed'：那会让"天生解不了"的图
    //    （真损坏的文件）每次补图都白试一遍、永远反复重试。所以只做这一次，
    //    用 meta 标记把门（和视频首帧那边的思路一致）。
    // ------------------------------------------------------------------
    // 一次性：缩略图从 WebP 换成 JPEG（解码快 3.2 倍，清晰度不变）→ 让所有图片缩略图重新生成一遍。
    // 同样用 meta 标记把门，只做一次；期间老 webp 仍可正常显示（路由两边都认），不会出现空白格。
    if (!this.raw.prepare('SELECT value FROM meta WHERE key = ?').get('thumb_jpeg_v1')) {
      const resetJpeg = this.raw
        .prepare("UPDATE media SET thumb_state = 'none' WHERE kind = 'image' AND thumb_state = 'ready'")
        .run()
      this.setMeta('thumb_jpeg_v1', '1')
      if (Number(resetJpeg.changes) > 0) {
        console.log(`[db] 重置 ${resetJpeg.changes} 张缩略图，改用 JPEG 重新生成（解码快 3 倍）`)
      }
    }

    if (!this.raw.prepare('SELECT value FROM meta WHERE key = ?').get('thumb_retry_v1')) {
      const reset = this.raw
        .prepare("UPDATE media SET thumb_state = 'none' WHERE kind = 'image' AND thumb_state = 'failed'")
        .run()
      this.setMeta('thumb_retry_v1', '1')
      if (Number(reset.changes) > 0) {
        console.log(`[db] 重置 ${reset.changes} 张失败的缩略图，改用新的兜底解码器重试`)
      }
    }
  }

  close(): void {
    this.raw.close()
  }

  setMeta(key: string, value: string): void {
    this.raw
      .prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, value)
  }

  counts(): StorageCounts {
    const one = (sql: string): number => {
      const row = this.raw.prepare(sql).get() as { n: number | bigint } | undefined
      return row ? Number(row.n) : 0
    }
    return {
      devices: one('SELECT COUNT(*) AS n FROM devices'),
      albums: one('SELECT COUNT(DISTINCT device_id || bucket_id) AS n FROM media WHERE deleted = 0'),
      media: one('SELECT COUNT(*) AS n FROM media WHERE deleted = 0'),
      blobs: one('SELECT COUNT(*) AS n FROM blobs'),
      trash: one('SELECT COUNT(*) AS n FROM media WHERE deleted = 1')
    }
  }

  // ---------- 设备 ----------

  upsertDevice(device: { id: string; name: string; model?: string; androidId?: string }): void {
    this.raw
      .prepare(
        `INSERT INTO devices(id, name, model, android_id)
         VALUES(?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           model = COALESCE(excluded.model, devices.model),
           android_id = COALESCE(excluded.android_id, devices.android_id)`
      )
      .run(device.id, device.name, device.model ?? null, device.androidId ?? null)
  }

  touchDeviceSync(id: string, at = Date.now()): void {
    this.raw.prepare('UPDATE devices SET last_sync_at = ? WHERE id = ?').run(at, id)
  }

  /** 重命名设备（手机端和电脑端都可以改"我是哪台手机"） */
  renameDevice(id: string, name: string): boolean {
    const result = this.raw.prepare('UPDATE devices SET name = ? WHERE id = ?').run(name, id)
    return Number(result.changes) > 0
  }

  listDevices(): DeviceRecord[] {
    const rows = this.raw
      .prepare(
        `SELECT d.id, d.name, d.model, d.merged_into, d.last_sync_at, d.created_at,
                (SELECT COUNT(*) FROM media m WHERE m.device_id = d.id AND m.deleted = 0) AS media_count
         FROM devices d
         ORDER BY d.created_at ASC`
      )
      .all() as {
      id: string
      name: string
      model: string | null
      merged_into: string | null
      last_sync_at: number | null
      created_at: number
      media_count: number
    }[]

    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      model: r.model ?? undefined,
      mediaCount: Number(r.media_count),
      lastSyncAt: r.last_sync_at ?? undefined,
      createdAt: r.created_at,
      mergedInto: r.merged_into ?? undefined
    }))
  }

  getDevice(id: string): { id: string; name: string; mergedInto?: string } | undefined {
    const row = this.raw.prepare('SELECT id, name, merged_into FROM devices WHERE id = ?').get(id) as
      | { id: string; name: string; merged_into: string | null }
      | undefined
    if (!row) return undefined
    return { id: row.id, name: row.name, mergedInto: row.merged_into ?? undefined }
  }

  /**
   * 合并设备（可逆）：把 source 挂到 target 下作为副设备。
   * 只改归属关系，不动任何文件；媒体记录仍保留原始设备标签，随时可以分离。
   */
  mergeDevices(sourceId: string, targetId: string): { mediaCount: number } {
    if (sourceId === targetId) return { mediaCount: this.groupMediaCount(targetId) }
    const source = this.getDevice(sourceId)
    const target = this.getDevice(targetId)
    if (!source || !target) throw new Error('设备不存在')

    // 避免环：如果 target 原本挂在 source 下，先解除
    if (target.mergedInto === sourceId) {
      this.raw.prepare('UPDATE devices SET merged_into = NULL WHERE id = ?').run(targetId)
    }
    // 保持一层结构：target 提升为主设备
    this.raw.prepare('UPDATE devices SET merged_into = NULL WHERE id = ?').run(targetId)
    // source 原有的副设备一并转到 target 下
    this.raw.prepare('UPDATE devices SET merged_into = ? WHERE merged_into = ?').run(targetId, sourceId)
    // source 作为副设备挂到 target 下
    this.raw.prepare('UPDATE devices SET merged_into = ? WHERE id = ?').run(targetId, sourceId)

    return { mediaCount: this.groupMediaCount(targetId) }
  }

  /** 分离设备：副设备恢复独立；主设备则释放它下面所有副设备 */
  splitDevice(deviceId: string): { detached: number } {
    const device = this.getDevice(deviceId)
    if (!device) return { detached: 0 }
    let detached = 0
    if (device.mergedInto) {
      this.raw.prepare('UPDATE devices SET merged_into = NULL WHERE id = ?').run(deviceId)
      detached += 1
    }
    const children = this.raw.prepare('UPDATE devices SET merged_into = NULL WHERE merged_into = ?').run(deviceId)
    detached += Number(children.changes)
    return { detached }
  }

  /** 该设备所在组的全部设备 ID（主设备 + 副设备） */
  groupDeviceIds(deviceId: string): string[] {
    const device = this.getDevice(deviceId)
    if (!device) return [deviceId]
    const root = device.mergedInto ?? deviceId
    const rows = this.raw
      .prepare('SELECT id FROM devices WHERE id = ? OR merged_into = ?')
      .all(root, root) as { id: string }[]
    return rows.map((r) => r.id)
  }

  /** 该设备所在组的媒体总数 */
  groupMediaCount(deviceId: string): number {
    const ids = this.groupDeviceIds(deviceId)
    const placeholders = ids.map(() => '?').join(',')
    const row = this.raw
      .prepare(`SELECT COUNT(*) AS n FROM media WHERE deleted = 0 AND device_id IN (${placeholders})`)
      .get(...ids) as { n: number | bigint }
    return Number(row.n)
  }

  /** 没有被任何媒体引用的内容哈希（合并/删除后可能出现） */
  orphanBlobShas(): string[] {
    const rows = this.raw
      .prepare(
        `SELECT b.sha256 FROM blobs b
         LEFT JOIN media m ON m.blob_sha256 = b.sha256
         WHERE m.id IS NULL`
      )
      .all() as { sha256: string }[]
    return rows.map((row) => row.sha256)
  }

  deleteBlobs(shas: string[]): number {
    const stmt = this.raw.prepare('DELETE FROM blobs WHERE sha256 = ?')
    let count = 0
    for (const sha of shas) {
      stmt.run(sha)
      count += 1
    }
    return count
  }

  deleteMedia(id: number): void {
    this.raw.prepare('DELETE FROM media WHERE id = ?').run(id)
  }

  // ---------- 回收站 ----------

  /** 取出待操作的媒体行（只做一次查询，后面的循环都在内存里） */
  private mediaKeys(
    ids: number[],
    deleted: 0 | 1
  ): {
    id: number
    device_id: string
    relative_path: string
    display_name: string
    blob_sha256: string
    size: number
  }[] {
    if (ids.length === 0) return []
    const placeholders = ids.map(() => '?').join(',')
    return this.raw
      .prepare(
        `SELECT id, device_id, relative_path, display_name, blob_sha256, size
         FROM media WHERE deleted = ${deleted} AND id IN (${placeholders})`
      )
      .all(...ids) as {
      id: number
      device_id: string
      relative_path: string
      display_name: string
      blob_sha256: string
      size: number
    }[]
  }

  /**
   * 记墓碑：这条被用户删过，手机下次备份再上报同名文件时直接跳过。
   * （不记的话，删掉的照片会在手机下次同步时原样长回来）
   */
  private putTombstone(
    row: { device_id: string; relative_path: string; display_name: string; blob_sha256: string },
    at: number,
    purged: boolean
  ): void {
    this.raw
      .prepare(
        `INSERT INTO tombstones(device_id, relative_path, display_name, blob_sha256, deleted_at, purged_at)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id, relative_path, display_name) DO UPDATE SET
           blob_sha256 = excluded.blob_sha256,
           deleted_at = excluded.deleted_at,
           purged_at = excluded.purged_at`
      )
      .run(
        row.device_id,
        row.relative_path,
        row.display_name,
        row.blob_sha256,
        at,
        purged ? at : null
      )
  }

  /** 移入回收站（软删除）：只改标记，一个字节都不动 */
  trashMedia(ids: number[], at = Date.now()): number {
    const rows = this.mediaKeys(ids, 0)
    if (rows.length === 0) return 0
    const update = this.raw.prepare('UPDATE media SET deleted = 1, deleted_at = ? WHERE id = ? AND deleted = 0')
    let count = 0
    for (const row of rows) {
      const result = update.run(at, row.id)
      if (Number(result.changes) === 0) continue
      count += 1
      this.putTombstone(row, at, false)
    }
    return count
  }

  /**
   * 从回收站恢复：回到原来的位置。
   * 设备 / 相对路径 / 文件名都还留在记录里，所以能"原样放回去"，不需要额外记来源。
   */
  restoreMedia(ids: number[]): number {
    const rows = this.mediaKeys(ids, 1)
    if (rows.length === 0) return 0
    const update = this.raw.prepare('UPDATE media SET deleted = 0, deleted_at = NULL WHERE id = ? AND deleted = 1')
    const untomb = this.raw.prepare(
      'DELETE FROM tombstones WHERE device_id = ? AND relative_path = ? AND display_name = ?'
    )
    let count = 0
    for (const row of rows) {
      const result = update.run(row.id)
      if (Number(result.changes) === 0) continue
      count += 1
      untomb.run(row.device_id, row.relative_path, row.display_name)
    }
    return count
  }

  /** 回收站里到期的条目（deleted_at 早于 cutoff） */
  expiredTrashIds(cutoff: number): number[] {
    const rows = this.raw
      .prepare('SELECT id FROM media WHERE deleted = 1 AND deleted_at IS NOT NULL AND deleted_at <= ?')
      .all(cutoff) as { id: number }[]
    return rows.map((row) => row.id)
  }

  listTrash(deviceId?: string): MediaRecord[] {
    const where: string[] = ['deleted = 1']
    const params: (string | number)[] = []
    if (deviceId) {
      const ids = this.groupDeviceIds(deviceId)
      where.push(`device_id IN (${ids.map(() => '?').join(',')})`)
      params.push(...ids)
    }
    const rows = this.raw
      .prepare(
        `SELECT * FROM media
         WHERE ${where.join(' AND ')}
         ORDER BY deleted_at DESC, id DESC`
      )
      .all(...params) as unknown as MediaRow[]
    return rows.map(toMediaRecord)
  }

  /**
   * 彻底删除：删记录 + 在"没有任何记录再引用这份内容"时连 blobs 行一起删。
   * 返回需要调用方从磁盘上删掉的 sha 列表（blob 原文件 + 缩略图）。
   *
   * ⚠️ 顺序很重要：先删 media 行再删 blobs 行，否则会被外键（ON DELETE RESTRICT）拦住。
   * ⚠️ 同一个 sha 可能挂多条记录（跨设备/跨目录的去重），必须确认引用归零才动文件。
   */
  purgeMedia(ids: number[], at = Date.now()): { count: number; blobs: string[]; freedBytes: number } {
    if (ids.length === 0) return { count: 0, blobs: [], freedBytes: 0 }
    const placeholders = ids.map(() => '?').join(',')
    const rows = this.raw
      .prepare(
        `SELECT id, device_id, relative_path, display_name, blob_sha256 FROM media
         WHERE deleted = 1 AND id IN (${placeholders})`
      )
      .all(...ids) as {
      id: number
      device_id: string
      relative_path: string
      display_name: string
      blob_sha256: string
    }[]
    if (rows.length === 0) return { count: 0, blobs: [], freedBytes: 0 }

    // 相册封面引用着 media(id)（没有 ON DELETE 子句 → 默认拦截），先摘掉
    const clearCover = this.raw.prepare('UPDATE albums SET cover_media_id = NULL WHERE cover_media_id = ?')
    const delMedia = this.raw.prepare('DELETE FROM media WHERE id = ?')
    for (const row of rows) {
      clearCover.run(row.id)
      delMedia.run(row.id)
      // 墓碑留着（标记"已彻底删除"）：手机以后重新备份也不会把它传回来
      this.putTombstone(row, at, true)
    }

    const uniqueShas = [...new Set(rows.map((row) => row.blob_sha256))]
    const sizeStmt = this.raw.prepare('SELECT size FROM blobs WHERE sha256 = ?')
    const delBlob = this.raw.prepare('DELETE FROM blobs WHERE sha256 = ?')
    const blobs: string[] = []
    let freedBytes = 0
    for (const sha of uniqueShas) {
      if (this.blobRefCount(sha) > 0) continue // 还有别的记录在用这份内容
      const sizeRow = sizeStmt.get(sha) as { size: number } | undefined
      if (!sizeRow) continue
      freedBytes += Number(sizeRow.size)
      delBlob.run(sha)
      blobs.push(sha)
    }
    return { count: rows.length, blobs, freedBytes }
  }

  // ---------- 墓碑 ----------

  /** 该设备下所有"已删除"的 (相对路径, 文件名) 键，格式与 markMissing 的 presentKeys 一致 */
  tombstoneKeysOf(deviceId: string): Set<string> {
    const rows = this.raw
      .prepare('SELECT relative_path, display_name FROM tombstones WHERE device_id = ?')
      .all(deviceId) as { relative_path: string; display_name: string }[]
    return new Set(rows.map((row) => `${row.relative_path}\u0000${row.display_name}`))
  }

  isTombstoned(deviceId: string, relativePath: string, displayName: string): boolean {
    return !!this.raw
      .prepare('SELECT 1 FROM tombstones WHERE device_id = ? AND relative_path = ? AND display_name = ?')
      .get(deviceId, relativePath, displayName)
  }

  /** 用户明确要这个文件回来（手动导入文件夹 / 从回收站恢复）时清掉墓碑 */
  clearTombstone(deviceId: string, relativePath: string, displayName: string): boolean {
    const result = this.raw
      .prepare('DELETE FROM tombstones WHERE device_id = ? AND relative_path = ? AND display_name = ?')
      .run(deviceId, relativePath, displayName)
    return Number(result.changes) > 0
  }

  // ---------- 内容存储 ----------

  blobExists(sha256: string): boolean {
    return !!this.raw.prepare('SELECT 1 FROM blobs WHERE sha256 = ?').get(sha256)
  }

  blobSize(sha256: string): number | undefined {
    const row = this.raw.prepare('SELECT size FROM blobs WHERE sha256 = ?').get(sha256) as
      | { size: number | bigint }
      | undefined
    return row ? Number(row.size) : undefined
  }

  insertBlob(sha256: string, size: number, mime?: string): void {
    this.raw
      .prepare('INSERT INTO blobs(sha256, size, mime) VALUES(?, ?, ?) ON CONFLICT(sha256) DO NOTHING')
      .run(sha256, size, mime ?? null)
  }

  /** 内容寻址去重：同一个哈希可以挂多条媒体记录 */
  blobRefCount(sha256: string): number {
    const row = this.raw.prepare('SELECT COUNT(*) AS n FROM media WHERE blob_sha256 = ?').get(sha256) as {
      n: number
    }
    return Number(row.n)
  }

  // ---------- 媒体 ----------

  findMedia(
    deviceId: string,
    relativePath: string,
    displayName: string
  ): { id: number; size: number; dateModified: number | null } | undefined {
    const row = this.raw
      .prepare(
        `SELECT id, size, date_modified FROM media
         WHERE device_id = ? AND relative_path = ? AND display_name = ? AND deleted = 0`
      )
      .get(deviceId, relativePath, displayName) as
      | { id: number; size: number; date_modified: number | null }
      | undefined
    if (!row) return undefined
    return { id: row.id, size: row.size, dateModified: row.date_modified }
  }

  insertMedia(item: NewMediaInput): number {
    this.raw
      .prepare(
        `INSERT INTO media(
           device_id, blob_sha256, display_name, relative_path, bucket_id, bucket_name,
           kind, mime, size, width, height, orientation,
           date_taken, date_modified, date_added, is_favorite, is_motion, duration_ms, thumb_state
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id, relative_path, display_name) DO UPDATE SET
           blob_sha256 = excluded.blob_sha256,
           bucket_id = excluded.bucket_id,
           bucket_name = excluded.bucket_name,
           kind = excluded.kind,
           mime = excluded.mime,
           size = excluded.size,
           width = excluded.width,
           height = excluded.height,
           orientation = excluded.orientation,
           date_taken = excluded.date_taken,
           date_modified = excluded.date_modified,
           date_added = excluded.date_added,
           is_favorite = excluded.is_favorite,
           is_motion = excluded.is_motion,
           duration_ms = excluded.duration_ms,
           thumb_state = excluded.thumb_state,
           deleted = 0`
      )
      .run(
        item.deviceId,
        item.blobSha256,
        item.displayName,
        item.relativePath,
        item.bucketId,
        item.bucketName,
        item.kind,
        item.mime,
        item.size,
        item.width ?? null,
        item.height ?? null,
        item.orientation ?? null,
        item.dateTaken ?? null,
        item.dateModified ?? null,
        item.dateAdded ?? null,
        item.isFavorite ? 1 : 0,
        item.isMotion ? 1 : 0,
        item.durationMs ?? null,
        item.thumbState ?? 'none'
      )

    const row = this.raw
      .prepare(
        'SELECT id FROM media WHERE device_id = ? AND relative_path = ? AND display_name = ?'
      )
      .get(item.deviceId, item.relativePath, item.displayName) as { id: number }
    return row.id
  }

  setThumbState(id: number, state: ThumbState): void {
    this.raw.prepare('UPDATE media SET thumb_state = ? WHERE id = ?').run(state, id)
  }

  setFavorite(id: number, favorite: boolean): void {
    this.raw.prepare('UPDATE media SET is_favorite = ? WHERE id = ?').run(favorite ? 1 : 0, id)
  }

  /**
   * 按手机最新清单标记"手机上已删除"的项：
   * 清单里没有的标记为 source_deleted=1（电脑不删文件，只做标记）；
   * 后来又重新出现的自动清回 0。
   * @returns 状态发生变化的数量
   */
  markMissing(deviceId: string, presentKeys: Set<string>): number {
    const rows = this.raw
      .prepare('SELECT id, relative_path, display_name, source_deleted FROM media WHERE device_id = ? AND deleted = 0')
      .all(deviceId) as {
      id: number
      relative_path: string
      display_name: string
      source_deleted: number
    }[]
    const update = this.raw.prepare('UPDATE media SET source_deleted = ? WHERE id = ?')
    let changed = 0
    for (const row of rows) {
      const key = `${row.relative_path}\u0000${row.display_name}`
      const next = presentKeys.has(key) ? 0 : 1
      if ((row.source_deleted ?? 0) !== next) {
        update.run(next, row.id)
        changed += 1
      }
    }
    return changed
  }

  /** 手机上已删除但电脑仍保留的数量 */
  countSourceDeleted(deviceId?: string): number {
    if (!deviceId) {
      const row = this.raw
        .prepare('SELECT COUNT(*) AS n FROM media WHERE deleted = 0 AND source_deleted = 1')
        .get() as { n: number | bigint }
      return Number(row.n)
    }
    const ids = this.groupDeviceIds(deviceId)
    const placeholders = ids.map(() => '?').join(',')
    const row = this.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM media WHERE deleted = 0 AND source_deleted = 1 AND device_id IN (${placeholders})`
      )
      .get(...ids) as { n: number | bigint }
    return Number(row.n)
  }

  listMedia(query: { deviceId?: string; bucketId?: string; kind?: MediaKind; favoritesOnly?: boolean } = {}): MediaRecord[] {
    const where: string[] = ['deleted = 0']
    const params: (string | number)[] = []
    if (query.deviceId) {
      const ids = this.groupDeviceIds(query.deviceId)
      where.push(`device_id IN (${ids.map(() => '?').join(',')})`)
      params.push(...ids)
    }
    if (query.bucketId) {
      where.push('bucket_id = ?')
      params.push(query.bucketId)
    }
    if (query.kind) {
      where.push('kind = ?')
      params.push(query.kind)
    }
    if (query.favoritesOnly) where.push('is_favorite = 1')

    const rows = this.raw
      .prepare(
        `SELECT * FROM media
         WHERE ${where.join(' AND ')}
         ORDER BY COALESCE(date_taken, date_modified, date_added, created_at) DESC, id DESC`
      )
      .all(...params) as unknown as MediaRow[]
    return rows.map(toMediaRecord)
  }

  getMedia(id: number): (MediaRecord & { blobSha256: string }) | undefined {
    const row = this.raw.prepare('SELECT * FROM media WHERE id = ? AND deleted = 0').get(id) as
      | MediaRow
      | undefined
    if (!row) return undefined
    return { ...toMediaRecord(row), blobSha256: row.blob_sha256 }
  }

  /**
   * 按 id 取记录，**回收站里的也算**。
   * 缩略图/原文件接口用它 —— 回收站里也要能看预览，否则用户没法判断哪张要恢复。
   * （列表接口仍然只给 deleted = 0 的，所以手机端拉不到已删除的条目）
   */
  getMediaAny(id: number): (MediaRecord & { blobSha256: string }) | undefined {
    const row = this.raw.prepare('SELECT * FROM media WHERE id = ?').get(id) as MediaRow | undefined
    if (!row) return undefined
    return { ...toMediaRecord(row), blobSha256: row.blob_sha256 }
  }

  /** 需要生成缩略图的图片（未尝试或上次失败时重试） */
  pendingThumbs(limit = 200): { id: number; blobSha256: string }[] {
    const rows = this.raw
      .prepare(
        `SELECT id, blob_sha256 FROM media
         WHERE deleted = 0 AND kind = 'image' AND thumb_state IN ('none', 'pending')
         ORDER BY date_taken DESC LIMIT ?`
      )
      .all(limit) as { id: number; blob_sha256: string }[]
    return rows.map((r) => ({ id: r.id, blobSha256: r.blob_sha256 }))
  }

  countPendingThumbs(): number {
    const row = this.raw
      .prepare(
        `SELECT COUNT(*) AS n FROM media
         WHERE deleted = 0 AND kind = 'image' AND thumb_state IN ('none', 'pending')`
      )
      .get() as { n: number | bigint }
    return Number(row.n)
  }

  listAlbums(deviceId?: string): AlbumRecord[] {
    const params: string[] = []
    let where = 'deleted = 0'
    if (deviceId) {
      const ids = this.groupDeviceIds(deviceId)
      where += ` AND device_id IN (${ids.map(() => '?').join(',')})`
      params.push(...ids)
    }

    const rows = this.raw
      .prepare(
        `SELECT device_id, bucket_id, bucket_name, relative_path,
                COUNT(*) AS count,
                MAX(COALESCE(date_taken, date_modified, date_added, created_at)) AS latest
         FROM media
         WHERE ${where}
         GROUP BY device_id, bucket_id
         ORDER BY latest DESC`
      )
      .all(...params) as unknown as {
      device_id: string
      bucket_id: string
      bucket_name: string | null
      relative_path: string | null
      count: number
      latest: number
    }[]

    const coverStmt = this.raw.prepare(
      `SELECT id FROM media
       WHERE deleted = 0 AND device_id = ? AND bucket_id = ?
       ORDER BY COALESCE(date_taken, date_modified, date_added, created_at) DESC, id DESC LIMIT 1`
    )

    return rows.map((r) => {
      const cover = coverStmt.get(r.device_id, r.bucket_id) as { id: number } | undefined
      return {
        bucketId: r.bucket_id,
        bucketName: r.bucket_name || r.bucket_id,
        relativePath: r.relative_path ?? '',
        deviceId: r.device_id,
        count: Number(r.count),
        coverMediaId: cover?.id,
        latestDate: Number(r.latest ?? 0)
      }
    })
  }

  /** 导出用：带 blob 路径信息 */
  listForExport(query: { deviceId?: string; bucketId?: string } = {}): ExportRow[] {
    const where: string[] = ['deleted = 0']
    const params: string[] = []
    if (query.deviceId) {
      const ids = this.groupDeviceIds(query.deviceId)
      where.push(`device_id IN (${ids.map(() => '?').join(',')})`)
      params.push(...ids)
    }
    if (query.bucketId) {
      where.push('bucket_id = ?')
      params.push(query.bucketId)
    }

    const rows = this.raw
      .prepare(
        `SELECT id, device_id, blob_sha256, display_name, relative_path, date_modified, date_taken
         FROM media WHERE ${where.join(' AND ')}
         ORDER BY COALESCE(date_taken, date_modified, date_added, created_at) ASC`
      )
      .all(...params) as unknown as {
      id: number
      device_id: string
      blob_sha256: string
      display_name: string
      relative_path: string
      date_modified: number | null
      date_taken: number | null
    }[]

    return rows.map((r) => ({
      id: r.id,
      deviceId: r.device_id,
      blobSha256: r.blob_sha256,
      displayName: r.display_name,
      relativePath: r.relative_path,
      dateModified: r.date_modified ?? undefined,
      dateTaken: r.date_taken ?? undefined
    }))
  }
}
