import { app, nativeImage, type IpcMainEvent, type NativeImage } from 'electron'
import { copyFile, link, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { DragPrepareResult } from '@shared/types'
import type { Database } from './hub/db'
import { blobPath, type StoragePaths } from './hub/storage'

/**
 * 拖出到资源管理器（Windows 原生拖放）。
 *
 * 仓库里的原文件是**内容寻址**的：`blobs/<sha 前两位>/<sha>`，文件名是一串哈希、没有扩展名。
 * 直接把它交给系统，用户拖到桌面上会得到一个打不开的怪文件。所以先在 tmp 里做一层
 * **硬链接**并起上原始文件名（IMG_20240101_123456.jpg），再把这一层交给系统拖。
 *
 * 为什么用硬链接而不是复制：
 *   - 同一分区上硬链接是元数据操作，**毫秒级**；复制 4GB 的视频要几十秒，拖拽早就结束了
 *   - 不占额外空间（两份名字指向同一份数据）
 *   - 就算资源管理器把这一层"移动"走了，仓库里的 blob 仍然完好
 */

/** 一次最多拖多少个文件（再多系统拖放会很难用，也容易误拖） */
const MAX_DRAG_FILES = 500

/** 拖拽中转目录：tmp/drag/<时间戳>-<pid> */
function dragRoot(tmpDir: string): string {
  return join(tmpDir, 'drag')
}

/** 文件名消毒：手机传来的名字可能带路径分隔符，不能让它跑出中转目录 */
function safeName(displayName: string): string {
  const base = basename(displayName.replace(/\\/g, '/'))
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  return base || '未命名文件'
}

/**
 * 清理上次遗留的中转文件。
 * 硬链接不占空间，但有拖出记录就会越攒越多，启动时按时间清一遍。
 * （不在拖拽结束时立刻删：资源管理器可能是异步复制的，这时候删掉会让复制失败）
 */
export async function cleanupDragStaging(tmpDir: string, maxAgeMs: number): Promise<number> {
  const root = dragRoot(tmpDir)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return 0 // 还没拖过，正常
  }
  const now = Date.now()
  let removed = 0
  for (const entry of entries) {
    const dir = join(root, entry.name)
    try {
      const info = await stat(dir)
      if (now - info.mtimeMs > maxAgeMs) {
        await rm(dir, { recursive: true, force: true })
        removed += 1
      }
    } catch {
      // 单个目录异常不影响其它
    }
  }
  return removed
}

/**
 * 把媒体准备成"资源管理器认识的真实文件"，返回真实路径。
 * 这一步不依赖任何界面状态，所以可以单独测（回归测试走 prepareDrag 这条 IPC）。
 */
export async function prepareDragFiles(
  db: Database,
  paths: StoragePaths,
  ids: number[]
): Promise<DragPrepareResult> {
  const files: DragPrepareResult['files'] = []
  const wanted = [...new Set(ids.map(Number).filter((id) => Number.isFinite(id)))].slice(
    0,
    MAX_DRAG_FILES
  )
  if (wanted.length === 0) return { files }

  const stageDir = join(dragRoot(paths.tmpDir), `${Date.now()}-${process.pid}`)
  await mkdir(stageDir, { recursive: true })
  const usedNames = new Set<string>()

  for (const id of wanted) {
    const media = db.getMediaAny(id)
    if (!media) continue
    const source = blobPath(paths.blobsDir, media.blobSha256)

    // 同名文件加 (1)、(2) 序号，和资源管理器一致
    const base = safeName(media.displayName)
    let name = base
    let counter = 1
    while (usedNames.has(name.toLowerCase())) {
      const dot = base.lastIndexOf('.')
      name = dot > 0 ? `${base.slice(0, dot)} (${counter})${base.slice(dot)}` : `${base} (${counter})`
      counter += 1
    }
    usedNames.add(name.toLowerCase())

    const target = join(stageDir, name)
    try {
      await link(source, target)
    } catch {
      // 跨卷 / 文件系统不支持硬链接时退回复制（同一分区不会走到这里）
      try {
        await copyFile(source, target)
      } catch {
        continue // 源文件丢了：跳过这一张，不影响其它
      }
    }
    files.push({ path: target, name, size: media.size })
  }

  return { files }
}

/** 拖拽时跟着鼠标的小图标：用系统给这个扩展名配的图标，拿不到就用本程序自己的图标 */
async function dragIcon(sampleFile: string): Promise<NativeImage> {
  try {
    const icon = await app.getFileIcon(sampleFile, { size: 'large' })
    if (!icon.isEmpty()) return icon
  } catch {
    // 忽略，走兜底
  }
  try {
    const icon = await app.getFileIcon(process.execPath, { size: 'large' })
    if (!icon.isEmpty()) return icon
  } catch {
    // 忽略，走兜底
  }
  return nativeImage.createEmpty()
}

/**
 * 开始一次真正的原生拖放。
 * ⚠️ 必须由渲染端在 dragstart 里 preventDefault 之后调用 —— 否则渲染进程会卡死；
 * 而且这个调用会进入系统的模态拖放循环，直到用户松手才返回。
 */
export async function startNativeDrag(
  event: IpcMainEvent,
  db: Database,
  paths: StoragePaths,
  ids: number[]
): Promise<void> {
  const { files } = await prepareDragFiles(db, paths, ids)
  if (files.length === 0) return
  const icon = await dragIcon(files[0].path)
  const sender = event.sender
  if (sender.isDestroyed()) return
  // `file` 是必填字段（Electron 的 d.ts 如此），但多文件时 `files` 会覆盖它（见 Item 类型注释）。
  // 两个都给：单文件时也不会出错。
  sender.startDrag({ file: files[0].path, files: files.map((file) => file.path), icon })
}
