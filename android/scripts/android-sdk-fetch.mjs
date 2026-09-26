#!/usr/bin/env node
/**
 * 从腾讯云镜像并行下载 Android SDK 包并解压到 SDK 目录。
 * 比 sdkmanager 直连 dl.google.com 快很多。
 *
 * 用法：
 *   node scripts/android-sdk-fetch.mjs <SDK目录> <包名...>
 * 例：
 *   node scripts/android-sdk-fetch.mjs D:\Android\Sdk "platforms;android-34" "build-tools;34.0.0"
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
const execFileAsync = promisify(execFile)

/** 各下载源的根地址（包路径相对官方仓库根目录） */
const MIRROR_BASES = [
  'https://mirrors.cloud.tencent.com/AndroidSDK/',
  'https://repo.huaweicloud.com/android/repository/',
  'https://mirrors.ustc.edu.cn/android/repository/',
  'https://mirrors.nju.edu.cn/android/repository/',
  'https://dl.google.com/android/repository/'
]
const PRIMARY_MIRROR = MIRROR_BASES[0]
const OFFICIAL_BASE = 'https://dl.google.com/android/repository/'

/** 包元数据清单（很小很快），系统镜像在单独的子目录清单里 */
const METADATA_PATHS = [
  'repository2-3.xml',
  'addon2-3.xml',
  'sys-img/google_apis/sys-img2-3.xml',
  'sys-img/google_apis_playstore/sys-img2-3.xml',
  'sys-img/android/sys-img2-3.xml'
]

const CONNECTIONS = 8
const SPEED_SAMPLE = 2 * 1024 * 1024

/** 合并多个仓库清单，包路径 -> { relativePath, size, sha1 } */
async function loadRepository() {
  const map = new Map()
  for (const metadataPath of METADATA_PATHS) {
    try {
      const xml = await fetchText(`${OFFICIAL_BASE}${metadataPath}`)
      const dir = metadataPath.includes('/') ? metadataPath.slice(0, metadataPath.lastIndexOf('/') + 1) : ''
      for (const [path, info] of parseRepository(xml)) {
        map.set(path, { ...info, relativePath: `${dir}${info.url}` })
      }
    } catch {
      // 某个清单拿不到就跳过
    }
  }
  return map
}

/** 测单个源速度（下载样本），失败返回 0 */
async function testMirrorSpeed(base, relativePath) {
  const started = Date.now()
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    const res = await fetch(`${base}${relativePath}`, {
      headers: { Range: `bytes=0-${SPEED_SAMPLE - 1}` },
      signal: controller.signal
    })
    clearTimeout(timer)
    if (res.status !== 206 && !res.ok) return 0
    const buf = Buffer.from(await res.arrayBuffer())
    const seconds = (Date.now() - started) / 1000
    return buf.length / seconds
  } catch {
    return 0
  }
}

/** 多源测速，返回最快的源 */
async function pickFastestMirror(relativePath) {
  const results = await Promise.all(
    MIRROR_BASES.map(async (base) => ({ base, speed: await testMirrorSpeed(base, relativePath) }))
  )
  results.sort((a, b) => b.speed - a.speed)
  for (const r of results) {
    if (r.speed > 0) {
      console.log(`  测速 ${r.base.replace(/^https?:\/\//, '').slice(0, 42)}  ${(r.speed / 1048576).toFixed(1)} MB/s`)
    }
  }
  const best = results[0]
  if (best.speed === 0) throw new Error(`所有下载源都拿不到文件：${relativePath}`)
  return best.base
}

const sdkRoot = process.argv[2]
const packages = process.argv.slice(3)
if (sdkRoot === '--list') {
  const keyword = packages[0] ?? ''
  const repo = await loadRepository()
  const matches = [...repo.entries()].filter(([path]) => path.includes(keyword))
  console.log(`匹配 "${keyword}" 的包 ${matches.length} 个：`)
  for (const [path, info] of matches) {
    console.log(`  ${path}  ${(info.size / 1048576).toFixed(1)}MB  ${info.url}`)
  }
  process.exit(0)
}
if (!sdkRoot || packages.length === 0) {
  console.error('用法：node scripts/android-sdk-fetch.mjs <SDK目录> <包名...>')
  console.error('      node scripts/android-sdk-fetch.mjs --list <关键字>')
  process.exit(1)
}

async function fetchText(url) {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`下载失败 ${res.status}: ${url}`)
  return res.text()
}

/** 从包的 XML 块里挑出 Windows 版（或无 host-os 的通用版）的压缩包信息 */
function pickArchive(block) {
  const archives = [...block.matchAll(/<archive>([\s\S]*?)<\/archive>/g)].map((m) => m[1])
  const candidates = archives.length > 0 ? archives : [block]
  for (const archive of candidates) {
    const host = (archive.match(/<host-os>([^<]+)<\/host-os>/) ?? [])[1]
    if (host && host !== 'windows') continue
    const url = (archive.match(/<url>([^<]+)<\/url>/) ?? [])[1]
    if (!url) continue
    return {
      url,
      size: Number((archive.match(/<size>(\d+)<\/size>/) ?? [])[1] ?? 0),
      sha1: (archive.match(/<checksum[^>]*>([0-9a-f]{40})<\/checksum>/) ?? [])[1] ?? ''
    }
  }
  return null
}

/** 解析 repository XML，返回 path -> { url, size, sha1 } */
function parseRepository(xml) {
  const map = new Map()
  const blocks = xml.split('<remotePackage path="').slice(1)
  for (const raw of blocks) {
    const path = raw.slice(0, raw.indexOf('"'))
    const end = raw.indexOf('</remotePackage>')
    const block = end >= 0 ? raw.slice(0, end) : raw
    const picked = pickArchive(block)
    if (picked) map.set(path, picked)
  }
  return map
}

/** 多连接并行下载到目标文件 */
async function downloadParallel(url, dest, size) {
  if (size === 0) {
    const res = await fetch(url)
    const buf = Buffer.from(await res.arrayBuffer())
    const handle = await open(dest, 'w')
    await handle.write(buf)
    await handle.close()
    return
  }

  const chunkSize = Math.ceil(size / CONNECTIONS)
  const handle = await open(dest, 'w')
  await handle.truncate(size)
  let done = 0

  const worker = async (index) => {
    const start = index * chunkSize
    const end = Math.min(size - 1, start + chunkSize - 1)
    if (start > end) return
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } })
    if (res.status !== 206) throw new Error(`分块下载失败 HTTP ${res.status}（源不支持断点或路径错误）`)
    const buf = Buffer.from(await res.arrayBuffer())
    await handle.write(buf, 0, buf.length, start)
    done += buf.length
    process.stdout.write(`\r  下载中 ${(done / 1048576).toFixed(1)}/${(size / 1048576).toFixed(1)} MB`)
  }

  await Promise.all(Array.from({ length: CONNECTIONS }, (_, i) => worker(i)))
  await handle.close()
  process.stdout.write('\n')
}

async function sha1File(file) {
  const hash = createHash('sha1')
  const handle = await open(file, 'r')
  const buf = Buffer.alloc(4 * 1024 * 1024)
  for (;;) {
    const { bytesRead } = await handle.read(buf, 0, buf.length, null)
    if (bytesRead <= 0) break
    hash.update(buf.subarray(0, bytesRead))
  }
  await handle.close()
  return hash.digest('hex')
}

/** 解压 zip 到临时目录，返回其中的顶层目录 */
async function extractZip(zipFile, workDir) {
  await mkdir(workDir, { recursive: true })
  await execFileAsync('tar', ['-xf', zipFile, '-C', workDir])
  const entries = await readdir(workDir)
  return entries
}

function targetDirFor(pkgPath) {
  const parts = pkgPath.split(';')
  if (parts[0] === 'cmdline-tools') return join(sdkRoot, 'cmdline-tools', parts[1] ?? 'latest')
  if (pkgPath === 'platform-tools') return join(sdkRoot, 'platform-tools')
  if (pkgPath === 'emulator') return join(sdkRoot, 'emulator')
  if (parts[0] === 'platforms') return join(sdkRoot, 'platforms', parts[1])
  if (parts[0] === 'build-tools') return join(sdkRoot, 'build-tools', parts[1])
  if (parts[0] === 'system-images') return join(sdkRoot, 'system-images', parts[1], parts[2], parts[3])
  return join(sdkRoot, ...parts)
}

/** 校验是不是有效的 zip（防止下到错误页） */
async function isZipFile(file) {
  try {
    const handle = await open(file, 'r')
    const buf = Buffer.alloc(2)
    await handle.read(buf, 0, 2, 0)
    await handle.close()
    return buf.toString('latin1') === 'PK'
  } catch {
    return false
  }
}

async function main() {
  console.log(`SDK 目录: ${sdkRoot}`)
  const repo = await loadRepository()
  console.log(`仓库包数量: ${repo.size}`)

  const tmpRoot = join(sdkRoot, '.tmp-download')

  for (const pkg of packages) {
    const info = repo.get(pkg)
    if (!info) {
      console.log(`✗ ${pkg}：镜像里没有这个包`)
      continue
    }
    const target = targetDirFor(pkg)
    const zipFile = join(tmpRoot, basename(info.url))
    await mkdir(tmpRoot, { recursive: true })

    console.log(`\n=== ${pkg} ===`)
    console.log(`  ${info.url}  ${(info.size / 1048576).toFixed(1)} MB -> ${target}`)

    if (existsSync(zipFile) && (await stat(zipFile)).size === info.size && (await isZipFile(zipFile))) {
      console.log('  已下载，跳过')
    } else {
      await rm(zipFile, { force: true })
      const mirror = await pickFastestMirror(info.relativePath)
      console.log(`  使用源: ${mirror.replace(/^https?:\/\//, '')}`)
      const started = Date.now()
      await downloadParallel(`${mirror}${info.relativePath}`, zipFile, info.size)
      const seconds = (Date.now() - started) / 1000
      console.log(`  下载完成 ${seconds.toFixed(1)}s (${(info.size / 1048576 / seconds).toFixed(1)} MB/s)`)
      if (!(await isZipFile(zipFile))) {
        await rm(zipFile, { force: true })
        throw new Error('下载内容不是有效压缩包，已删除')
      }
    }

    if (info.sha1) {
      const actual = await sha1File(zipFile)
      if (actual !== info.sha1) {
        console.log(`  ✗ 校验失败，删除重下`)
        await rm(zipFile, { force: true })
        continue
      }
      console.log('  ✓ SHA-1 校验通过')
    }

    const workDir = join(tmpRoot, `extract-${Date.now()}`)
    const roots = await extractZip(zipFile, workDir)
    await mkdir(target, { recursive: true })

    // 解压结果通常有一层顶层目录（cmdline-tools/、android-14/ 等），把它的内容放平到目标目录
    const sourceRoots = roots.length === 1 ? [join(workDir, roots[0])] : roots.map((r) => join(workDir, r))
    const moveInto = async (src, destDir) => {
      await mkdir(destDir, { recursive: true })
      const entries = await readdir(src)
      for (const entry of entries) {
        const dest = join(destDir, entry)
        await rm(dest, { recursive: true, force: true })
        try {
          await rename(join(src, entry), dest)
        } catch {
          await execFileAsync('cmd', [
            '/c',
            'robocopy',
            join(src, entry),
            dest,
            '/E',
            '/MOVE',
            '/NFL',
            '/NDL',
            '/NJH',
            '/NJS',
            '/NC',
            '/NS',
            '/NP'
          ])
        }
      }
    }

    for (const sourceRoot of sourceRoots) {
      await moveInto(sourceRoot, target)
    }
    await rm(workDir, { recursive: true, force: true })
    console.log(`  ✓ 已安装到 ${target}`)
  }

  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  console.log('\n全部完成')
}

main().catch((err) => {
  console.error('出错：', err instanceof Error ? err.message : err)
  process.exit(1)
})
