import { fileUrl } from '../api'

/**
 * 视频首帧缩略图（**在渲染端抽帧**）。
 *
 * 为什么在渲染端做：
 *   - 主进程**绝不解码视频** —— 2026-09-24 的闪退根因就是视频原文件被送进 libvips（sharp）解码。
 *     而 Chromium 本来就在播放这些视频，用它抽帧最安全：同一个解码器、同一个能力边界，
 *     解不了就只是这一格没有预览图，绝不会把应用带走。
 *   - 不引入 ffmpeg（70MB 二进制、要走代理下载、还要 asarUnpack 配置），零新依赖。
 *   - canvas 直接编 webp（Chromium 原生支持），编好的字节交给主进程落盘（它只校验魔数 + 写文件）。
 *
 * 限流（用户库里有 4.4GB 的视频，不能乱来）：
 *   - 一次只跑一个；只给"当前真正渲染出来的"格子抽帧（由 VirtualGrid 在可见行里调用）
 *   - 每个视频每个会话最多试一次；超时的不记 failed（可能只是这次慢），以后滚动到再试
 *   - 解码不了的（Chromium 报 error）记 failed，永久不再试
 */

const pending: number[] = []
const attempted = new Set<number>()
/** 超时重试计数（最多试 2 次，防止某个"天生卡住"的视频被无限捞起来白烧时间） */
const retries = new Map<number, number>()
let running = false
/** 打开查看器（看图/看视频）时暂停抽帧：别跟播放抢解码器和带宽 */
let paused = false
/** 每个视频之间歇一下，让机器始终有余量 */
const GAP_MS = 250

/** 抽帧的等待上限；超时按"这次没成"处理（不写死 failed，交给 60 秒一轮的重扫再试） */
const EXTRACT_TIMEOUT_MS = 40000
/** 生成的缩略图最长边（缩略图本来就是小图） */
const MAX_EDGE = 640

/**
 * 正在**看视频**时暂停后台抽帧（Viewer 打开视频时调用）。
 * 看图片不用停 —— 抽帧是串行的、每张之间还歇一下，不会跟"翻图片"抢什么资源；
 * 之前做法是"打开查看器就全停"，结果用户一边看图一边等缩略图，永远等不到（实测反馈）。
 */
export function setVideoThumbPaused(next: boolean): void {
  paused = next
}

/**
 * 请求给某个视频抽首帧（同一个 id 只会真正跑一次）。
 *
 * ⚠️ 就算这个 id 已经试过了，也**一定要再踹一脚队列**：万一上一轮队列因为某个意外中断了
 * （`running` 还是 true、`pending` 里还堆着东西），只有这里能把它救活。
 * 实测踩过：队列停在中途，后面所有请求都因为"已 attempt"直接 return，缩略图就永远停在那个数字上。
 */
export function requestVideoThumb(id: number, base: string): void {
  if (!attempted.has(id)) {
    attempted.add(id)
    pending.push(id)
  }
  void runQueue(base)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

async function runQueue(base: string): Promise<void> {
  if (running) return
  running = true
  try {
    while (pending.length > 0) {
      const id = pending.shift()
      if (id === undefined) break
      // 窗口不可见 / 用户正在看大图时不抽：前者 Chromium 不产帧（seeked 可能永不触发），
      // 后者是别跟播放抢资源。每 500ms 看一眼，恢复后继续。
      while (document.hidden || paused) {
        await sleep(500)
      }
      try {
        // ⚠️ 整段抽帧再套一层硬超时：里面任何一个 await 卡住（`toBlob` 的回调不来、seek 不响应…）
        //    都会把**整条队列**永久堵死（实测卡在 346/422 一动不动，连每秒 60 秒的重扫都救不回来）。
        const blob = await withTimeout(extractFrame(base, id), EXTRACT_TIMEOUT_MS)
        if (!blob) {
          await window.gm.markVideoThumbFailed(id)
          continue
        }
        const ok = await window.gm.saveVideoThumb(id, await blob.arrayBuffer())
        if (!ok) attempted.delete(id) // 主进程没收（字节不合法等）：允许以后重试一次
        await sleep(GAP_MS)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        if (message === 'timeout') {
          // 超时可能只是这次慢：再给一次机会；连续两次都卡住就认了（记 failed），
          // 否则它会被"每分钟重扫"反复捞起来，每次白烧 40 秒
          const count = (retries.get(id) ?? 0) + 1
          retries.set(id, count)
          if (count >= 2) {
            await window.gm.markVideoThumbFailed(id).catch(() => undefined)
          } else {
            attempted.delete(id)
          }
        } else {
          await window.gm.markVideoThumbFailed(id).catch(() => undefined)
        }
      }
    }
  } finally {
    running = false
  }
}

/** 抽一帧 → 编成 webp。失败抛错，超时抛 'timeout'。 */
async function extractFrame(base: string, id: number): Promise<Blob | null> {
  const video = document.createElement('video')
  video.src = fileUrl(base, id)
  video.muted = true
  video.preload = 'auto'
  // 从本机 Hub 取视频再画到 canvas：不声明 anonymous 的话 canvas 会被跨域污染，
  // toBlob 直接抛 SecurityError（Hub 会对受信任的桌面来源返回 CORS 许可）
  video.crossOrigin = 'anonymous'
  video.style.position = 'fixed'
  video.style.left = '-10000px'
  video.style.width = '360px'
  document.body.appendChild(video)

  try {
    await withTimeout(waitForEvent(video, 'loadeddata'), EXTRACT_TIMEOUT_MS)
    // 往后挪一点，避免抽到全黑的片头
    const duration = Number.isFinite(video.duration) ? video.duration : 0
    const target = duration > 2 ? Math.min(2, duration / 3) : 0
    if (target > 0) {
      video.currentTime = target
      await withTimeout(waitForEvent(video, 'seeked'), EXTRACT_TIMEOUT_MS)
    }
    const width = video.videoWidth
    const height = video.videoHeight
    if (!width || !height) return null
    const scale = Math.min(1, MAX_EDGE / Math.max(width, height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(width * scale))
    canvas.height = Math.max(1, Math.round(height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) return null
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/webp', 0.78))
  } finally {
    video.removeAttribute('src')
    video.load() // 释放解码器
    video.remove()
  }
}

function waitForEvent(video: HTMLVideoElement, name: 'loadeddata' | 'seeked'): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      video.removeEventListener(name, onDone)
      video.removeEventListener('error', onFail)
    }
    const onDone = (): void => {
      cleanup()
      resolve()
    }
    const onFail = (): void => {
      cleanup()
      reject(new Error('decode_failed'))
    }
    video.addEventListener(name, onDone)
    video.addEventListener('error', onFail)
  })
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('timeout')), ms)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        window.clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    )
  })
}
