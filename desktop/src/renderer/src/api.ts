import type { AlbumRecord, DeviceRecord, MediaRecord } from '@shared/types'

export function apiBase(port: number): string {
  return `http://127.0.0.1:${port}/api/v1`
}

export function thumbUrl(base: string, mediaId: number): string {
  return `${base}/thumb/${mediaId}`
}

export function fileUrl(base: string, mediaId: number): string {
  return `${base}/file/${mediaId}`
}

/** 查看器用的大预览图（Hub 端按需生成 webp，最长边 2560） */
export function previewUrl(base: string, mediaId: number): string {
  return `${base}/preview/${mediaId}`
}

/**
 * Chromium 能直接显示的图片格式。**不在这个表里的，查看器必须走 `/preview`** ——
 * 原始字节（DNG / HEIC / HEIF / TIFF…）交给 `<img>` 会**静默失败**，
 * 用户看到的就是"点开什么都没有"（2026-09-24 实测：DNG 的 4000×3000 原图打不开，网格缩略图却正常）。
 */
const WEB_VIEWABLE_IMAGE_MIMES = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/svg+xml'
])

export function needsRenderedPreview(mime: string | undefined): boolean {
  return !mime || !WEB_VIEWABLE_IMAGE_MIMES.has(mime.toLowerCase())
}

export interface MediaQuery {
  deviceId?: string
  bucketId?: string
  kind?: 'image' | 'video'
  favorites?: boolean
}

export async function fetchMedia(base: string, query: MediaQuery = {}): Promise<MediaRecord[]> {
  const params = new URLSearchParams()
  if (query.deviceId) params.set('deviceId', query.deviceId)
  if (query.bucketId) params.set('bucketId', query.bucketId)
  if (query.kind) params.set('kind', query.kind)
  if (query.favorites) params.set('favorites', '1')
  const res = await fetch(`${base}/media?${params.toString()}`)
  if (!res.ok) throw new Error(`加载媒体失败：${res.status}`)
  const data = (await res.json()) as { media: MediaRecord[] }
  return data.media
}

export async function fetchAlbums(base: string, deviceId?: string): Promise<AlbumRecord[]> {
  const params = new URLSearchParams()
  if (deviceId) params.set('deviceId', deviceId)
  const res = await fetch(`${base}/albums?${params.toString()}`)
  if (!res.ok) throw new Error(`加载相册失败：${res.status}`)
  const data = (await res.json()) as { albums: AlbumRecord[] }
  return data.albums
}

export async function fetchDevices(base: string): Promise<DeviceRecord[]> {
  const res = await fetch(`${base}/devices`)
  if (!res.ok) throw new Error(`加载设备失败：${res.status}`)
  const data = (await res.json()) as { devices: DeviceRecord[] }
  return data.devices
}

export async function setFavorite(base: string, id: number, favorite: boolean): Promise<void> {
  await fetch(`${base}/favorite`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, favorite })
  })
}

/** 回收站列表（顺手带上保留天数，倒计时以服务端为准） */
export async function fetchTrash(
  base: string,
  deviceId?: string
): Promise<{ media: MediaRecord[]; retentionDays: number }> {
  const params = new URLSearchParams()
  if (deviceId) params.set('deviceId', deviceId)
  const res = await fetch(`${base}/trash?${params.toString()}`)
  if (!res.ok) throw new Error(`加载回收站失败：${res.status}`)
  return (await res.json()) as { media: MediaRecord[]; retentionDays: number }
}

/** 移入回收站（软删除，文件还在） */
export async function trashMedia(base: string, ids: number[]): Promise<number> {
  const res = await fetch(`${base}/media/trash`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids })
  })
  if (!res.ok) throw new Error(`删除失败：${res.status}`)
  return ((await res.json()) as { count: number }).count
}

/** 从回收站恢复（放回原来的位置） */
export async function restoreMedia(base: string, ids: number[]): Promise<number> {
  const res = await fetch(`${base}/media/restore`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids })
  })
  if (!res.ok) throw new Error(`恢复失败：${res.status}`)
  return ((await res.json()) as { count: number }).count
}

/** 彻底删除（记录 + 磁盘文件；不可恢复） */
export async function purgeMedia(
  base: string,
  ids: number[]
): Promise<{ count: number; freedBytes: number }> {
  const res = await fetch(`${base}/media/purge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids })
  })
  if (!res.ok) throw new Error(`彻底删除失败：${res.status}`)
  const data = (await res.json()) as { count: number; freedBytes?: number }
  return { count: data.count, freedBytes: data.freedBytes ?? 0 }
}

/** 修改设备显示名（手机端和电脑端都可以改） */
export async function renameDevice(base: string, deviceId: string, name: string): Promise<void> {
  await fetch(`${base}/device/rename`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, name })
  })
}
