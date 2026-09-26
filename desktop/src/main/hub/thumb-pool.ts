import { cpus } from 'node:os'
import { basename, join } from 'node:path'
import { utilityProcess, type UtilityProcess } from 'electron'

/**
 * 缩略图子进程池。
 *
 * sharp 的原生模块在这个 Electron 环境下会偶发**原生崩溃**（fail-fast，JS 拦不住），
 * 崩了整个应用就闪退。所以把缩略图生成全部放到 `utilityProcess` 子进程里：
 * 子进程崩了只影响它手上那一个任务，主程序记录一下继续跑。
 *
 * 两个设计取舍：
 * - **懒启动**：只有真有缩略图要生成时才 fork 子进程，用完 30 秒就全部关掉，
 *   不给"小内存机器"留常驻开销。
 * - **崩溃不重试**：同一个源文件崩过一次就记下来，之后直接判失败 ——
 *   否则会陷入"崩 → 重试 → 再崩"的死循环（界面上就是反复闪退）。
 */

export const MAX_WORKERS = Math.max(2, Math.min(6, cpus().length - 2))
/** 没有任务后多久关掉子进程（释放内存） */
const IDLE_SHUTDOWN_MS = 30_000
/** 记多少个"崩溃过的源文件"，防止死循环；超了就清空重来 */
const CRASH_MEMO_MAX = 500

interface Job {
  id: number
  source: string
  target: string
  /** 最长边与质量（不给就用缩略图默认值）；查看器的大预览图会传更大的尺寸 */
  size?: number
  quality?: number
  format?: 'jpeg' | 'webp'
  resolve: (ok: boolean) => void
}

interface Slot {
  proc: UtilityProcess
  busy: Job | null
}

class ThumbWorkerPool {
  private slots = new Set<Slot>()
  private queue: Job[] = []
  private nextId = 1
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private crashedSources = new Set<string>()
  private stopped = false

  /** 生成一张图（缩略图或查看器用的大预览图）。子进程崩溃时返回 false（调用方标为失败即可，不会抛） */
  generate(
    source: string,
    target: string,
    options?: { size?: number; quality?: number; format?: 'jpeg' | 'webp' }
  ): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false)
    if (this.crashedSources.has(source)) {
      // 这个源文件之前已经把子进程搞崩过一次，别再试了
      return Promise.resolve(false)
    }
    return new Promise<boolean>((resolve) => {
      this.queue.push({ id: this.nextId++, source, target, ...options, resolve })
      this.clearIdleTimer()
      this.pump()
    })
  }

  /** 应用退出时调用：把所有子进程收掉 */
  shutdown(): void {
    this.stopped = true
    this.clearIdleTimer()
    for (const job of this.queue) job.resolve(false)
    this.queue = []
    for (const slot of [...this.slots]) this.kill(slot)
  }

  // ---------------- 内部 ----------------

  private pump(): void {
    if (this.stopped) return
    while (this.queue.length > 0) {
      const idle = [...this.slots].find((s) => s.busy === null)
      if (idle) {
        this.dispatch(idle, this.queue.shift()!)
        continue
      }
      if (this.slots.size < MAX_WORKERS) {
        this.dispatch(this.spawn(), this.queue.shift()!)
        continue
      }
      break // 所有子进程都在忙，等它们回来
    }
    if (this.queue.length === 0) this.armIdleTimer()
  }

  private spawn(): Slot {
    const proc = utilityProcess.fork(join(__dirname, 'thumb-worker.js'), [], {
      serviceName: 'gallery-mirror-thumb',
      stdio: 'pipe'
    })
    const slot: Slot = { proc, busy: null }
    this.slots.add(slot)

    // 子进程里的报错要能看见，否则出问题只能看到一句"异常退出"
    proc.stderr?.on('data', (chunk: Buffer) => {
      console.error('[thumb] 子进程 stderr:', chunk.toString().trim())
    })

    proc.on('message', (message: unknown) => {
      const job = slot.busy
      slot.busy = null
      if (job) {
        const ok = Boolean((message as { ok?: boolean } | null)?.ok)
        job.resolve(ok)
      }
      this.pump()
    })

    proc.on('exit', (code) => {
      this.slots.delete(slot)
      const job = slot.busy
      if (job) {
        // ★ 这就是要隔离的场景：sharp 原生崩溃把子进程带走了
        console.error(
          `[thumb] 子进程异常退出（code=${code}），跳过这张缩略图：${basename(job.source)}`
        )
        if (this.crashedSources.size >= CRASH_MEMO_MAX) this.crashedSources.clear()
        this.crashedSources.add(job.source)
        job.resolve(false)
      }
      if (!this.stopped) this.pump()
    })

    return slot
  }

  private dispatch(slot: Slot, job: Job): void {
    slot.busy = job
    try {
      slot.proc.postMessage({
        id: job.id,
        source: job.source,
        target: job.target,
        size: job.size,
        quality: job.quality,
        format: job.format
      })
    } catch (err) {
      // 进程刚好挂了之类：交给 exit 处理，这里只保证不抛
      console.error('[thumb] 派发失败：', err instanceof Error ? err.message : String(err))
    }
  }

  private kill(slot: Slot): void {
    this.slots.delete(slot)
    slot.busy?.resolve(false)
    slot.busy = null
    try {
      slot.proc.kill()
    } catch {
      /* 已经退出 */
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.queue.length > 0) return
      for (const slot of [...this.slots]) {
        if (slot.busy === null) this.kill(slot)
      }
    }, IDLE_SHUTDOWN_MS)
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
      this.idleTimer = null
    }
  }
}

export const thumbPool = new ThumbWorkerPool()
