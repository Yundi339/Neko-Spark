import { createReadStream, existsSync } from 'node:fs'
import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { networkInterfaces } from 'node:os'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import {
  APP_NAME,
  PROTOCOL_VERSION,
  TRASH_RETENTION_DAYS,
  type AlbumRecord,
  type CommitRequest,
  type DeviceRecord,
  type HubStatus,
  type ManifestRequest,
  type ManifestResponse,
  type MediaItem,
  type MediaRecord,
  type SyncPrepareRequest,
  type SyncProgress,
  type TaskProgress,
  type TrashActionResult,
  type TrashResponse,
  type UploadStatus
} from '@shared/types'
import type { Database, NewMediaInput } from './db'
import type { StoragePaths } from './storage'
import { blobPath, isStickerFile, stickerContentType, thumbPath, videoThumbPath } from './storage'
import { hashFile } from './importer'
import { detectKind, guessMime } from './media'
import { ensurePreview, ensureThumbnail, processPendingThumbs } from './thumbs'
import { purgeTrash, restoreMedia, sweepExpiredTrash, trashMedia } from './trash'

const DEFAULT_PORT = 8787
const MAX_PORT_TRIES = 20
const MAX_JSON_BODY = 512 * 1024 * 1024
/** 局域网发现：手机广播这个口令，电脑回自己的地址信息 */
export const DISCOVERY_PORT = 8788
export const DISCOVERY_REQUEST = 'GALLERY_MIRROR_DISCOVER'

export interface HubOptions {
  db: Database
  paths: StoragePaths
  version: string
  port?: number
  onDataChanged?: () => void
  onTaskProgress?: (progress: TaskProgress) => void
  onTaskDone?: (progress: TaskProgress) => void
  /** 手机上传进度（电脑端显示进度条） */
  onSyncProgress?: (progress: SyncProgress) => void
}

export interface HubHandle {
  status: HubStatus
  stop(): Promise<void>
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store'
  })
  res.end(payload)
}

function lanAddresses(port: number): string[] {
  const VIRTUAL_ADAPTER_HINT =
    /(vethernet|hyper-v|vmware|virtualbox|tap|tun|clash|wsl|docker|zerotier|tailscale|npcap|loopback)/i
  const score = (adapterName: string, address: string): number => {
    let value = 0
    if (/^192\.168\./.test(address)) value += 40
    else if (/^10\./.test(address)) value += 35
    else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) value += 30
    else if (/^169\.254\./.test(address)) value -= 60
    else if (/^198\.(18|19)\./.test(address)) value -= 50
    else value += 10
    if (VIRTUAL_ADAPTER_HINT.test(adapterName)) value -= 25
    return value
  }

  const candidates: { address: string; score: number }[] = []
  for (const [name, list] of Object.entries(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === 'IPv4' && !net.internal) {
        candidates.push({ address: net.address, score: score(name, net.address) })
      }
    }
  }
  const real = candidates.filter((item) => item.score > 0)
  const usable = real.length > 0 ? real : candidates
  return usable.sort((a, b) => b.score - a.score).map((item) => `http://${item.address}:${port}`)
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener('listening', onListening)
      reject(err)
    }
    const onListening = (): void => {
      server.removeListener('error', onError)
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '0.0.0.0')
  })
}

async function listenWithFallback(server: Server, preferred: number): Promise<number> {
  for (let i = 0; i < MAX_PORT_TRIES; i += 1) {
    try {
      return await listen(server, preferred + i)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err
    }
  }
  throw new Error(`端口 ${preferred}-${preferred + MAX_PORT_TRIES - 1} 全部被占用`)
}

function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_JSON_BODY) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('error', reject)
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')) as T)
      } catch (err) {
        reject(err)
      }
    })
  })
}

/**
 * 清单条目是否带齐了"入库必需"的字段。
 * 清单的核心用途是比对，历史客户端/测试可能只发 sha256+文件名（不带 size 等），
 * 这种情况不能让它 500 —— 跳过流式入库，交给 commit 兜底即可。
 */
function canIngestItem(item: MediaItem): boolean {
  return Boolean(item.sha256) && Boolean(item.displayName) && Number.isFinite(item.size)
}

function mediaItemToInput(deviceId: string, item: MediaItem): NewMediaInput {
  const ext = item.displayName.includes('.') ? item.displayName.slice(item.displayName.lastIndexOf('.')) : ''
  const kind = detectKind(`x${ext}`) ?? (item.mimeType?.startsWith('video') ? 'video' : 'image')
  const relativePath = item.relativePath || ''
  return {
    deviceId,
    blobSha256: item.sha256,
    displayName: item.displayName,
    relativePath,
    bucketId: item.bucketId || relativePath || '/',
    bucketName: item.bucketName || (relativePath ? relativePath.replace(/\/$/, '').split('/').pop() ?? '' : ''),
    kind,
    mime: item.mimeType || guessMime(item.displayName),
    size: item.size,
    width: item.width,
    height: item.height,
    orientation: item.orientation,
    dateTaken: item.dateTaken,
    dateModified: item.dateModified,
    dateAdded: item.dateAdded,
    isFavorite: item.isFavorite,
    isMotion: item.isMotionPhoto,
    durationMs: item.durationMs,
    thumbState: kind === 'image' ? 'pending' : 'none'
  }
}

/** 启动局域网发现应答（手机端"搜索电脑"用的） */
function startDiscovery(version: string, getPort: () => number): () => void {
  let socket: UdpSocket | null = null
  try {
    socket = createSocket({ type: 'udp4', reuseAddr: true })
    socket.on('error', () => {
      try {
        socket?.close()
      } catch {
        /* 忽略 */
      }
      socket = null
    })
    socket.on('message', (message, remote) => {
      if (message.toString().trim() !== DISCOVERY_REQUEST) return
      const payload = JSON.stringify({
        name: APP_NAME,
        version,
        port: getPort(),
        protocolVersion: PROTOCOL_VERSION
      })
      try {
        socket?.send(payload, remote.port, remote.address)
      } catch {
        /* 忽略单次发送失败 */
      }
    })
    socket.bind(DISCOVERY_PORT, () => {
      try {
        socket?.setBroadcast(true)
      } catch {
        /* 某些环境不支持，忽略 */
      }
    })
  } catch {
    socket = null
  }
  return () => {
    try {
      socket?.close()
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 清理过期的分片残留。
 * `.part` 是断点续传的凭据（手机下次接着传要用），所以不能见着就删；
 * 只有长时间没人来续的才算垃圾 —— 否则中断一次就会永久留下几十上百 MB。
 */
async function cleanupStaleParts(uploadsDir: string, maxAgeMs: number): Promise<number> {
  let removed = 0
  let entries
  try {
    entries = await readdir(uploadsDir, { withFileTypes: true })
  } catch {
    return 0 // 目录不存在：还没上传过，正常
  }
  const now = Date.now()
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.part')) continue
    const file = join(uploadsDir, entry.name)
    try {
      const info = await stat(file)
      if (now - info.mtimeMs > maxAgeMs) {
        await rm(file, { force: true })
        removed += 1
      }
    } catch {
      // 单个文件异常不影响其他
    }
  }
  return removed
}

export async function startHub(options: HubOptions): Promise<HubHandle> {
  const startedAt = Date.now()
  const { db, paths } = options
  const activeUploads = new Map<string, { received: number }>()

  // 本次清单的元数据暂存：blob 一落盘就立刻入库，照片边传边出现（不用等整轮同步结束）
  const pendingMeta = new Map<string, { deviceId: string; item: MediaItem }>()

  // 手机本次同步会话（用于电脑端进度条）
  let sync: SyncProgress | null = null
  const emitSync = (): void => {
    if (sync) options.onSyncProgress?.({ ...sync })
  }

  // 「准备中」阶段没有后续（手机被杀/断网）时的兜底：撤掉进度条，免得电脑端一直挂着
  const PREPARE_TIMEOUT_MS = 3 * 60 * 1000
  let prepareTimer: ReturnType<typeof setTimeout> | null = null
  const clearPrepareTimer = (): void => {
    if (prepareTimer) {
      clearTimeout(prepareTimer)
      prepareTimer = null
    }
  }
  const armPrepareTimer = (): void => {
    clearPrepareTimer()
    prepareTimer = setTimeout(() => {
      prepareTimer = null
      if (sync && sync.phase === 'preparing' && !sync.done) {
        sync.done = true
        sync.phase = 'done'
        emitSync()
      }
    }, PREPARE_TIMEOUT_MS)
  }

  const notifyChanged = (): void => {
    options.onDataChanged?.()
  }

  const runThumbBackfill = (): void => {
    void processPendingThumbs(db, paths.blobsDir, paths.thumbsDir).then((count) => {
      if (count > 0) notifyChanged()
    })
  }

  const THUMB_BACKFILL_EVERY_MS = 3000
  const THUMB_BACKFILL_BATCH = 120
  let thumbBackfillTimer: ReturnType<typeof setTimeout> | null = null
  const scheduleThumbBackfill = (): void => {
    if (thumbBackfillTimer) return
    thumbBackfillTimer = setTimeout(() => {
      thumbBackfillTimer = null
      void processPendingThumbs(db, paths.blobsDir, paths.thumbsDir, undefined, THUMB_BACKFILL_BATCH)
    }, THUMB_BACKFILL_EVERY_MS)
  }
  const clearThumbBackfillTimer = (): void => {
    if (thumbBackfillTimer) {
      clearTimeout(thumbBackfillTimer)
      thumbBackfillTimer = null
    }
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    const segments = url.pathname.split('/').filter(Boolean)
    const method = req.method ?? 'GET'

    res.setHeader('Access-Control-Allow-Origin', '*')
    // ⚠️ 必须带上 Range：渲染端读视频 moov 盒子算帧率时会带 Range 头去 fetch，
    //    不带 Range 的话预检失败，浏览器直接拦掉请求（帧率就永远取不到）
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Content-Range, Range')
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Accept-Ranges')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, OPTIONS, HEAD')
    if (method === 'OPTIONS') {
      res.writeHead(204)
      res.end()
      return
    }

    void handleRoute().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      if (!res.headersSent) sendJson(res, 500, { error: 'internal_error', message })
      else res.end()
    })

    async function handleRoute(): Promise<void> {
      // GET /api/v1/health
      if (method === 'GET' && url.pathname === '/api/v1/health') {
        sendJson(res, 200, {
          name: APP_NAME,
          version: options.version,
          protocolVersion: PROTOCOL_VERSION,
          pid: process.pid,
          uptimeMs: Date.now() - startedAt,
          time: new Date().toISOString()
        })
        return
      }

      // GET /api/v1/info
      if (method === 'GET' && url.pathname === '/api/v1/info') {
        sendJson(res, 200, {
          dataDir: paths.dataDir,
          dbPath: paths.dbPath,
          counts: db.counts(),
          sourceDeleted: db.countSourceDeleted()
        })
        return
      }

      // GET /api/v1/devices
      if (method === 'GET' && url.pathname === '/api/v1/devices') {
        const devices: DeviceRecord[] = db.listDevices()
        sendJson(res, 200, { devices })
        return
      }

      // GET /api/v1/albums
      if (method === 'GET' && url.pathname === '/api/v1/albums') {
        const deviceId = url.searchParams.get('deviceId') ?? undefined
        const albums: AlbumRecord[] = db.listAlbums(deviceId)
        sendJson(res, 200, { albums })
        return
      }

      // GET /api/v1/media
      if (method === 'GET' && url.pathname === '/api/v1/media') {
        const devices = url.searchParams.get('deviceId') ?? undefined
        const bucketId = url.searchParams.get('bucketId') ?? undefined
        const kindParam = url.searchParams.get('kind')
        const favorites = url.searchParams.get('favorites') === '1'
        const media: MediaRecord[] = db.listMedia({
          deviceId: devices,
          bucketId,
          kind: kindParam === 'video' || kindParam === 'image' ? kindParam : undefined,
          favoritesOnly: favorites
        })
        sendJson(res, 200, { media })
        return
      }

      // GET /api/v1/thumb/:id
      if (method === 'GET' && segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'thumb' && segments[3]) {
        const id = Number(segments[3])
        // 回收站里的也要能出缩略图（用户得看得见自己删了什么才好挑着恢复）
        const media = db.getMediaAny(id)
        if (!media) {
          sendJson(res, 404, { error: 'not_found' })
          return
        }
        // ⚠️ 只有图片才谈得上"现场生成缩略图"。视频（甚至 900MB 的）一旦被送进 sharp 解码，
        // libvips 会原生崩溃、把整个应用带走 —— 实测 2026-09-24 的闪退就是这个。
        //
        // 视频的首帧由**渲染端的 Chromium 抽**（`utils/videoThumb.ts`）编成 webp 存进缩略图目录，
        // 这里只负责把它吐出去：所以判据是"已经生成好了（thumbState === 'ready'）"，
        // 只要不是 ready 就 404 —— 下面那行 `ensureThumbnail` 永远不会碰到视频。
        if (media.kind !== 'image' && media.thumbState !== 'ready') {
          sendJson(res, 404, { error: 'thumb_unavailable' })
          return
        }
        // 图片缩略图现在是 **JPEG**（同尺寸同观感，但 Chromium 解 JPEG 比解 WebP 快 3.2 倍），
        // 视频首帧仍是 **webp**（那些字节是渲染端用 canvas 编的）。
        // 迁移期老库里还留着 webp 的图片缩略图 —— 按"哪个文件在"决定类型，两个都认。
        let file = thumbPath(paths.thumbsDir, media.blobSha256)
        let contentType = 'image/jpeg'
        if (media.thumbState !== 'ready') {
          const generated = await ensureThumbnail(db, paths.blobsDir, paths.thumbsDir, media.id, media.blobSha256)
          if (!generated) {
            sendJson(res, 404, { error: 'thumb_unavailable' })
            return
          }
          file = generated
        }
        if (!existsSync(file)) {
          const legacy = videoThumbPath(paths.thumbsDir, media.blobSha256)
          if (existsSync(legacy)) {
            file = legacy
            contentType = 'image/webp'
          }
        }
        try {
          const info = await stat(file)
          res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': info.size,
            'Cache-Control': 'public, max-age=31536000, immutable'
          })
          createReadStream(file).pipe(res)
        } catch {
          sendJson(res, 404, { error: 'thumb_missing' })
        }
        return
      }

      // GET /api/v1/preview/:id —— 查看器用的大预览图（webp，最长边 2560）
      //
      // 为什么单独开一个接口：**Chromium 解不了 DNG / HEIC / HEIF / TIFF**，
      // 查看器直接拿 `/file/:id` 的原始字节会静默失败（界面表现："点开什么都没有"）。
      //
      // ⚠️ 绝不能在 `/file/:id` 上做这件事：手机恢复（回写相册）走的就是它，
      // 协议承诺"不转码、不压缩、不改名"——必须是原始字节。所以预览另起一条路。
      if (method === 'GET' && segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'preview' && segments[3]) {
        const id = Number(segments[3])
        const media = db.getMediaAny(id)
        // 只有图片谈得上"生成预览"（视频由 Chromium 自己播，走 /file 的 Range）
        if (!media || media.kind !== 'image') {
          sendJson(res, 404, { error: 'preview_unavailable' })
          return
        }
        const file = await ensurePreview(paths.thumbsDir, paths.blobsDir, media.blobSha256)
        if (!file) {
          sendJson(res, 404, { error: 'preview_unavailable' })
          return
        }
        try {
          const info = await stat(file)
          res.writeHead(200, {
            'Content-Type': 'image/webp',
            'Content-Length': info.size,
            'Cache-Control': 'public, max-age=31536000, immutable'
          })
          createReadStream(file).pipe(res)
        } catch {
          sendJson(res, 404, { error: 'preview_missing' })
        }
        return
      }

      // GET /api/v1/file/:id （支持 Range，供视频播放）
      if (method === 'GET' && segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'file' && segments[3]) {
        const id = Number(segments[3])
        const media = db.getMediaAny(id)
        if (!media) {
          sendJson(res, 404, { error: 'not_found' })
          return
        }
        const file = blobPath(paths.blobsDir, media.blobSha256)
        let info
        try {
          info = await stat(file)
        } catch {
          sendJson(res, 404, { error: 'blob_missing' })
          return
        }

        const range = req.headers.range
        const contentType = media.mime || 'application/octet-stream'
        if (range) {
          const match = /bytes=(\d*)-(\d*)/.exec(range)
          let start = match?.[1] ? Number(match[1]) : 0
          let end = match?.[2] ? Number(match[2]) : info.size - 1
          if (Number.isNaN(start) || start < 0) start = 0
          if (Number.isNaN(end) || end >= info.size) end = info.size - 1
          if (start > end) {
            res.writeHead(416, { 'Content-Range': `bytes */${info.size}` })
            res.end()
            return
          }
          res.writeHead(206, {
            'Content-Type': contentType,
            'Content-Length': end - start + 1,
            'Content-Range': `bytes ${start}-${end}/${info.size}`,
            'Accept-Ranges': 'bytes'
          })
          createReadStream(file, { start, end }).pipe(res)
          return
        }

        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': info.size,
          'Accept-Ranges': 'bytes'
        })
        createReadStream(file).pipe(res)
        return
      }

      // GET /api/v1/background/:n —— 空状态用的高清背景图（可放 background-1..4.webp，可选）
      if (
        method === 'GET' &&
        segments[0] === 'api' &&
        segments[1] === 'v1' &&
        segments[2] === 'background'
      ) {
        const index = segments[3] ?? ''
        const candidates =
          index && /^\d$/.test(index)
            ? [join(paths.dataDir, `background-${index}.webp`), join(paths.dataDir, 'background.webp')]
            : [join(paths.dataDir, 'background.webp')]
        for (const file of candidates) {
          try {
            const info = await stat(file)
            res.writeHead(200, {
              'Content-Type': 'image/webp',
              'Content-Length': info.size,
              'Cache-Control': 'no-store'
            })
            createReadStream(file).pipe(res)
            return
          } catch {
            // 试下一个
          }
        }
        sendJson(res, 404, { error: 'no_background' })
        return
      }

      // GET /api/v1/stickers —— 列出用户自定义贴图
      if (method === 'GET' && url.pathname === '/api/v1/stickers') {
        let names: string[] = []
        try {
          const entries = await readdir(paths.stickersDir, { withFileTypes: true })
          names = entries
            .filter((entry) => entry.isFile() && isStickerFile(entry.name))
            .map((entry) => entry.name)
            .sort()
        } catch {
          names = []
        }
        sendJson(res, 200, { stickers: names })
        return
      }

      // GET /api/v1/sticker/:name —— 读取自定义贴图
      if (
        method === 'GET' &&
        segments[0] === 'api' &&
        segments[1] === 'v1' &&
        segments[2] === 'sticker' &&
        segments[3]
      ) {
        const name = decodeURIComponent(segments[3])
        // 防目录穿越：只允许纯文件名
        if (name.includes('/') || name.includes('\\') || name.includes('..') || !isStickerFile(name)) {
          sendJson(res, 400, { error: 'invalid_name' })
          return
        }
        try {
          const file = join(paths.stickersDir, name)
          const info = await stat(file)
          res.writeHead(200, {
            'Content-Type': stickerContentType(name),
            'Content-Length': info.size,
            'Cache-Control': 'public, max-age=3600'
          })
          createReadStream(file).pipe(res)
        } catch {
          sendJson(res, 404, { error: 'sticker_missing' })
        }
        return
      }

      // POST /api/v1/device/merge —— 合并设备（可逆：source 作为副设备挂到 target 下）
      if (method === 'POST' && url.pathname === '/api/v1/device/merge') {
        const body = await readJsonBody<{ sourceDeviceId?: string; targetDeviceId?: string }>(req)
        const sourceId = body?.sourceDeviceId?.trim()
        const targetId = body?.targetDeviceId?.trim()
        if (!sourceId || !targetId) {
          sendJson(res, 400, { error: 'missing_params' })
          return
        }
        try {
          const result = db.mergeDevices(sourceId, targetId)
          notifyChanged()
          sendJson(res, 200, { ok: true, ...result })
        } catch (err) {
          sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) })
        }
        return
      }

      // POST /api/v1/device/split —— 分离设备（恢复独立）
      if (method === 'POST' && url.pathname === '/api/v1/device/split') {
        const body = await readJsonBody<{ deviceId?: string }>(req)
        const deviceId = body?.deviceId?.trim()
        if (!deviceId) {
          sendJson(res, 400, { error: 'missing_params' })
          return
        }
        const result = db.splitDevice(deviceId)
        notifyChanged()
        sendJson(res, 200, { ok: true, ...result })
        return
      }

      // POST /api/v1/device/rename —— 手机端/电脑端都可以改设备名
      if (method === 'POST' && url.pathname === '/api/v1/device/rename') {
        const body = await readJsonBody<{ deviceId?: string; name?: string }>(req)
        const deviceId = body?.deviceId?.trim()
        const name = body?.name?.trim()
        if (!deviceId || !name) {
          sendJson(res, 400, { error: 'missing_params' })
          return
        }
        const ok = db.renameDevice(deviceId, name)
        if (ok) notifyChanged()
        sendJson(res, 200, { ok })
        return
      }

      // POST /api/v1/favorite
      if (method === 'POST' && url.pathname === '/api/v1/favorite') {
        const body = await readJsonBody<{ id?: number; favorite?: boolean }>(req)
        if (!body?.id) {
          sendJson(res, 400, { error: 'missing_id' })
          return
        }
        db.setFavorite(Number(body.id), !!body.favorite)
        notifyChanged()
        sendJson(res, 200, { ok: true })
        return
      }

      // GET /api/v1/trash —— 回收站列表（顺手做一次到期清理，界面打开时看到的必然是最新的）
      if (method === 'GET' && url.pathname === '/api/v1/trash') {
        const swept = await sweepExpiredTrash(db, paths)
        const deviceId = url.searchParams.get('deviceId') ?? undefined
        const media: MediaRecord[] = db.listTrash(deviceId)
        if (swept.count > 0) notifyChanged()
        const payload: TrashResponse = { media, retentionDays: TRASH_RETENTION_DAYS }
        sendJson(res, 200, payload)
        return
      }

      // POST /api/v1/media/trash —— 移入回收站（软删除，不删文件）
      if (method === 'POST' && url.pathname === '/api/v1/media/trash') {
        const body = await readJsonBody<{ ids?: number[] }>(req)
        const ids = (body?.ids ?? []).map(Number).filter((id) => Number.isFinite(id))
        if (ids.length === 0) {
          sendJson(res, 400, { error: 'missing_ids' })
          return
        }
        const result: TrashActionResult = trashMedia(db, ids)
        if (result.count > 0) notifyChanged()
        sendJson(res, 200, result)
        return
      }

      // POST /api/v1/media/restore —— 从回收站恢复（放回原来的相册位置）
      if (method === 'POST' && url.pathname === '/api/v1/media/restore') {
        const body = await readJsonBody<{ ids?: number[] }>(req)
        const ids = (body?.ids ?? []).map(Number).filter((id) => Number.isFinite(id))
        if (ids.length === 0) {
          sendJson(res, 400, { error: 'missing_ids' })
          return
        }
        const result: TrashActionResult = restoreMedia(db, ids)
        if (result.count > 0) notifyChanged()
        sendJson(res, 200, result)
        return
      }

      // POST /api/v1/media/purge —— 彻底删除（记录 + 磁盘文件）
      if (method === 'POST' && url.pathname === '/api/v1/media/purge') {
        const body = await readJsonBody<{ ids?: number[] }>(req)
        const ids = (body?.ids ?? []).map(Number).filter((id) => Number.isFinite(id))
        if (ids.length === 0) {
          sendJson(res, 400, { error: 'missing_ids' })
          return
        }
        const result = await purgeTrash(db, paths, ids)
        if (result.count > 0) notifyChanged()
        sendJson(res, 200, result)
        return
      }

      // GET /api/v1/upload-status?sha256=
      if (method === 'GET' && url.pathname === '/api/v1/upload-status') {
        const sha = url.searchParams.get('sha256') ?? ''
        const exists = db.blobExists(sha)
        let received = activeUploads.get(sha)?.received ?? 0
        if (!exists) {
          try {
            const info = await stat(join(paths.uploadsDir, `${sha}.part`))
            received = info.size
          } catch {
            received = 0
          }
        }
        const payload: UploadStatus = { exists, received, size: 0 }
        sendJson(res, 200, payload)
        return
      }

      // PUT /api/v1/blob/:sha256
      if (method === 'PUT' && segments[0] === 'api' && segments[1] === 'v1' && segments[2] === 'blob' && segments[3]) {
        const sha = segments[3].toLowerCase()
        if (!/^[0-9a-f]{64}$/.test(sha)) {
          sendJson(res, 400, { error: 'invalid_sha256' })
          return
        }
        if (db.blobExists(sha)) {
          req.resume()
          sendJson(res, 200, { received: 0, complete: true, existed: true })
          return
        }

        await mkdir(paths.uploadsDir, { recursive: true })
        const partPath = join(paths.uploadsDir, `${sha}.part`)

        const rangeHeader = req.headers['content-range']
        let offset = 0
        let total = 0
        if (typeof rangeHeader === 'string') {
          const match = /bytes\s+(\d+)-(\d+)\/(\d+)/.exec(rangeHeader)
          if (match) {
            offset = Number(match[1])
            total = Number(match[3])
          }
        } else {
          offset = Number(url.searchParams.get('offset') ?? '0') || 0
          total = Number(url.searchParams.get('total') ?? '0') || 0
        }
        if (total === 0) total = offset + Number(req.headers['content-length'] ?? '0')

        // 断点续传：如果本地没有分片文件，只能从 0 开始
        if (offset > 0 && !existsSync(partPath)) offset = 0

        const handle = await open(partPath, offset === 0 ? 'w' : 'r+')
        try {
          await handle.truncate(offset)
        } catch {
          // 忽略截断失败（文件尚不存在时）
        }
        const writeStream = handle.createWriteStream({ start: offset })
        await pipeline(req, writeStream)

        const info = await stat(partPath)
        const received = info.size
        activeUploads.set(sha, { received })
        if (sync && !sync.done) {
          // 传输中的字节数也实时上报，界面进度条更平滑
          sync.currentBytes = received
          emitSync()
        }

        if (total > 0 && received >= total) {
          const actual = await hashFile(partPath)
          if (actual !== sha) {
            await rm(partPath, { force: true })
            activeUploads.delete(sha)
            sendJson(res, 409, { error: 'hash_mismatch', expected: sha, actual })
            return
          }
          const dest = blobPath(paths.blobsDir, sha)
          await mkdir(dirname(dest), { recursive: true })
          await rename(partPath, dest)
          db.insertBlob(sha, received)
          activeUploads.delete(sha)

          // 落盘即入库：这一张照片立刻出现在电脑界面上，不必等整轮同步结束
          const meta = pendingMeta.get(sha)
          if (meta) {
            const { relativePath, displayName } = meta.item
            if (!db.isTombstoned(meta.deviceId, relativePath || '', displayName)) {
              db.insertMedia(mediaItemToInput(meta.deviceId, meta.item))
              notifyChanged()
              scheduleThumbBackfill()
            }
            pendingMeta.delete(sha)
          }

          if (sync && !sync.done) {
            sync.received += 1
            sync.bytes += received
            sync.currentBytes = 0
            emitSync()
          }
          sendJson(res, 200, { received, complete: true })
          return
        }

        sendJson(res, 200, { received, complete: false })
        return
      }

      // POST /api/v1/sync/prepare —— 手机开始扫描/算指纹前先打招呼
      // 老客户端不发这个请求也不影响（电脑端就按原来的样子，只在收到清单后才显示进度）
      if (method === 'POST' && url.pathname === '/api/v1/sync/prepare') {
        const body = await readJsonBody<SyncPrepareRequest>(req)
        const device = body?.device
        const deviceId = device?.deviceId ?? ''
        // 换了一台手机 / 上一轮已结束 → 开一段新的准备会话
        const isNewSession = !sync || sync.deviceId !== deviceId || sync.done
        if (isNewSession) {
          if (deviceId) {
            db.upsertDevice({
              id: deviceId,
              name: device.name || deviceId,
              model: device.model,
              androidId: device.androidVersion
            })
          }
          sync = {
            deviceId,
            deviceName: device?.name || deviceId,
            phase: 'preparing',
            needed: 0,
            received: 0,
            bytes: 0,
            currentBytes: 0,
            neededBytes: 0,
            prepareTotal: 0,
            prepareTotalBytes: 0,
            hashed: 0,
            hashedBytes: 0,
            done: false,
            startedAt: Date.now()
          }
        }
        if (sync) {
          sync.phase = 'preparing'
          if (Number(body?.total) > 0) sync.prepareTotal = Number(body.total)
          if (Number(body?.totalBytes) > 0) sync.prepareTotalBytes = Number(body.totalBytes)
          // 进度只允许前进，避免乱序到达的请求让百分比回退
          sync.hashed = Math.max(sync.hashed ?? 0, Number(body?.hashed) || 0)
          sync.hashedBytes = Math.max(sync.hashedBytes ?? 0, Number(body?.hashedBytes) || 0)
        }
        armPrepareTimer()
        emitSync()
        sendJson(res, 200, { ok: true })
        return
      }

      // POST /api/v1/manifest
      if (method === 'POST' && url.pathname === '/api/v1/manifest') {
        const body = await readJsonBody<ManifestRequest>(req)
        const items = body.items ?? []
        // 用户在电脑上删过的（墓碑）：既不要它再传、也不要它再入库 ——
        // 否则删掉的照片会在手机下次备份时原样长回来。对手机就回"这边已经有了"。
        const tombstoned = body.device?.deviceId ? db.tombstoneKeysOf(body.device.deviceId) : new Set<string>()
        const keyOf = (item: MediaItem): string => `${item.relativePath || ''}\u0000${item.displayName}`
        const needed: string[] = []
        const knownShas = new Set<string>()
        let known = 0
        for (const item of items) {
          if (!item.sha256) continue
          if (tombstoned.has(keyOf(item))) {
            known += 1
            continue
          }
          if (db.blobExists(item.sha256)) {
            knownShas.add(item.sha256)
            known += 1
          } else {
            needed.push(item.sha256)
          }
        }

        // 对比手机当前清单：清单里没有的 = 手机上已删除（电脑保留文件，只打标记）
        let markedMissing = 0
        let ingested = 0
        const device = body.device
        if (device?.deviceId) {
          db.upsertDevice({
            id: device.deviceId,
            name: device.name || device.deviceId,
            model: device.model,
            androidId: device.androidVersion
          })
          const presentKeys = new Set(
            items.map((item) => `${item.relativePath || ''}\u0000${item.displayName}`)
          )
          markedMissing = db.markMissing(device.deviceId, presentKeys)

          // 流式入库（清单阶段）：
          //   数据已经在电脑上的（上次中断未入库的、断点续传的）→ 立刻建好媒体记录
          //   还需要上传的 → 暂存元数据，等 blob 落盘那一刻入库
          pendingMeta.clear()
          for (const item of items) {
            if (!canIngestItem(item)) continue
            // 删过的条目绝不入库（insertMedia 的 UPSERT 会把 deleted 清回 0，直接"复活"）
            if (tombstoned.has(keyOf(item))) continue
            if (knownShas.has(item.sha256)) {
              db.insertMedia(mediaItemToInput(device.deviceId, item))
              ingested += 1
            } else {
              pendingMeta.set(item.sha256, { deviceId: device.deviceId, item })
            }
          }
          if (markedMissing > 0 || ingested > 0) notifyChanged()
        }

        // 开始一次同步会话：电脑端据此显示进度条
        clearPrepareTimer()
        const neededSet = new Set(needed)
        const neededBytes = items
          .filter((item) => neededSet.has(item.sha256))
          .reduce((sum, item) => sum + (item.size || 0), 0)
        sync = {
          deviceId: device?.deviceId ?? '',
          deviceName: device?.name || device?.deviceId || '',
          phase: needed.length === 0 ? 'done' : 'uploading',
          needed: needed.length,
          received: 0,
          bytes: 0,
          currentBytes: 0,
          neededBytes,
          done: needed.length === 0,
          startedAt: Date.now()
        }
        emitSync()

        const payload: ManifestResponse = {
          needed,
          known,
          total: items.length,
          missing: db.countSourceDeleted(device?.deviceId),
          changed: markedMissing
        }
        sendJson(res, 200, payload)
        return
      }

      // POST /api/v1/commit
      if (method === 'POST' && url.pathname === '/api/v1/commit') {
        const body = await readJsonBody<CommitRequest>(req)
        const device = body.device
        if (!device?.deviceId) {
          sendJson(res, 400, { error: 'missing_device' })
          return
        }
        db.upsertDevice({
          id: device.deviceId,
          name: device.name || device.deviceId,
          model: device.model,
          androidId: device.androidVersion
        })

        const tombstoned = db.tombstoneKeysOf(device.deviceId)
        let inserted = 0
        let skipped = 0
        for (const item of body.items ?? []) {
          if (!item.sha256 || !db.blobExists(item.sha256)) {
            skipped += 1
            continue
          }
          // 电脑上删过的：不让它借 commit 复活（手机端会以为备份成功，这是期望行为）
          if (tombstoned.has(`${item.relativePath || ''}\u0000${item.displayName}`)) {
            skipped += 1
            continue
          }
          db.insertMedia(mediaItemToInput(device.deviceId, item))
          inserted += 1
        }
        db.touchDeviceSync(device.deviceId)
        if (sync) {
          sync.received = Math.max(sync.received, 0)
          sync.done = true
          sync.phase = 'done'
          emitSync()
        }
        notifyChanged()
        runThumbBackfill()
        sendJson(res, 200, { inserted, skipped, total: (body.items ?? []).length })
        return
      }

      sendJson(res, 404, { error: 'not_found', path: url.pathname })
    }
  })

  // 启动时清理过期分片：断点续传凭据保留 7 天，超过就当地垃圾回收
  void cleanupStaleParts(paths.uploadsDir, 7 * 24 * 60 * 60 * 1000)

  /**
   * 回收站到期清理：启动时一次 + 每 6 小时一次（打开回收站时还会惰性再跑一遍）。
   * 一天一次其实就够，但"删了之后一直不重启"是常态，隔 6 小时兜一次更稳。
   */
  const sweepTrash = (): void => {
    void sweepExpiredTrash(db, paths).then((result) => {
      if (result.count > 0) notifyChanged()
    })
  }
  sweepTrash()
  const trashSweepTimer = setInterval(sweepTrash, 6 * 60 * 60 * 1000)
  trashSweepTimer.unref?.()


  const port = await listenWithFallback(server, options.port ?? DEFAULT_PORT)
  const status: HubStatus = {
    running: true,
    host: '0.0.0.0',
    port,
    addresses: lanAddresses(port)
  }
  const stopDiscovery = startDiscovery(options.version, () => status.port)

  return {
    status,
    stop: () =>
      new Promise<void>((resolve) => {
        clearPrepareTimer()
        clearThumbBackfillTimer()
        clearInterval(trashSweepTimer)
        stopDiscovery()
        server.close(() => resolve())
      })
  }
}
