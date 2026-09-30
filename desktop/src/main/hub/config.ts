import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { app } from 'electron'

/** 记录仓库位置的引导文件，放在程序目录（安装目录）下，不占 C 盘 */
const POINTER_FILE = 'data-location.json'

/**
 * 便携版 exe 实际所在的目录。
 *
 * 便携版是自解压到临时目录再运行的，`process.execPath` 指向那个临时目录（程序一关就没了），
 * 所以必须用 electron-builder 设的 `PORTABLE_EXECUTABLE_DIR` 才能拿到 U 盘上的真实位置。
 * 安装版/开发模式没有这个变量，返回 undefined。
 */
function portableDir(): string | undefined {
  const dir = process.env.PORTABLE_EXECUTABLE_DIR
  return dir && dir.trim() ? dir.trim() : undefined
}

/** 程序所在目录：便携版为 exe 所在目录，安装版为安装目录，开发时为项目目录 */
export function appRootDir(): string {
  const portable = portableDir()
  if (portable) return portable
  return app.isPackaged ? dirname(process.execPath) : process.cwd()
}

function pointerPath(): string {
  return join(appRootDir(), POINTER_FILE)
}

/**
 * 安装到另一个目录时，安装目录内的指针不会随新安装复制过去。
 * 再留一份用户级指针，保证同一台电脑上的覆盖更新和迁移安装继续使用原数据仓库。
 * 便携版不写这里，避免 U 盘上的多个副本互相串库。
 */
function sharedPointerPath(): string | undefined {
  if (!app.isPackaged || portableDir()) return undefined
  try {
    return join(app.getPath('appData'), 'Neko_Spark', POINTER_FILE)
  } catch {
    return undefined
  }
}

function readPointer(file: string): string | undefined {
  try {
    if (!existsSync(file)) return undefined
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as { dataDir?: string }
    return parsed.dataDir && parsed.dataDir.trim() ? parsed.dataDir.trim() : undefined
  } catch {
    return undefined
  }
}

function isWritable(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, `.write-test-${process.pid}`)
    writeFileSync(probe, '')
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

/** 读取用户配置的仓库位置（环境变量优先，其次引导文件） */
export function readConfiguredDataDir(): string | undefined {
  const fromEnv = process.env.GALLERY_MIRROR_DATA
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()

  const local = readPointer(pointerPath())
  if (local) return local
  const shared = sharedPointerPath()
  return shared ? readPointer(shared) : undefined
}

export function writeConfiguredDataDir(dataDir: string): void {
  writeFileSync(pointerPath(), `${JSON.stringify({ dataDir }, null, 2)}\n`, 'utf-8')
  const shared = sharedPointerPath()
  if (shared) {
    mkdirSync(dirname(shared), { recursive: true })
    writeFileSync(shared, `${JSON.stringify({ dataDir }, null, 2)}\n`, 'utf-8')
  }
}

/**
 * 默认仓库位置：与程序目录同级（例如装到 D:\GalleryMirror → 数据在 D:\GalleryMirrorData）。
 * 放在安装目录"外面"是为了卸载/升级时不会被卸载程序一起删掉。
 * 若同级目录不可写，才退回安装目录内，最后才退回系统用户目录。
 */
export function defaultDataDir(): string {
  if (!app.isPackaged) return join(process.cwd(), '.data')

  const root = appRootDir()

  // 便携版：数据就放在 exe 同一个文件夹里（U 盘拔了就走，真正的绿色软件）。
  // 注意不能走下面的"上一级"逻辑 —— 那会落到 U 盘根目录，不跟着这个文件夹走。
  if (portableDir()) {
    const beside = join(root, 'GalleryMirrorData')
    if (isWritable(beside)) return beside
    // U 盘只读等极端情况：退回系统用户目录，至少还能跑
    return join(app.getPath('userData'), 'GalleryMirrorData')
  }

  const sibling = join(dirname(root), 'GalleryMirrorData')
  const legacy = join(root, 'GalleryMirrorData') // 旧布局：在安装目录内（升级会被清掉）

  // 旧布局 → 新布局自动迁移
  if (!existsSync(sibling) && existsSync(legacy)) {
    try {
      renameSync(legacy, sibling)
    } catch {
      // 迁移失败就继续用旧位置，至少数据还在
    }
  }

  if (isWritable(sibling)) return sibling
  if (isWritable(legacy)) return legacy
  return join(app.getPath('userData'), 'GalleryMirrorData')
}

export function resolveDataDir(): string {
  return readConfiguredDataDir() ?? defaultDataDir()
}

/** 启动时把 Chromium 缓存、崩溃转储等运行时文件也放到仓库目录，避免写入 C 盘 */
export function applyRuntimePaths(dataDir: string): void {
  const runtime = join(dataDir, 'runtime')
  mkdirSync(runtime, { recursive: true })
  app.setPath('userData', runtime)
  try {
    app.setPath('crashDumps', join(runtime, 'crash-dumps'))
  } catch {
    // 某些平台不支持该路径，忽略
  }
}
