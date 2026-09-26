/**
 * 临时诊断工具：验证"从 MP4 里读帧率"这段解析在**真实视频**上算得对不对。
 *
 * 冒烟测试里的 mp4 是假字节（几十个字符），根本没法验证解析 —— 所以这个探针直接对着
 * **正在运行的正式版**（只读 HTTP，不改任何数据）挑几个真视频来算。
 * 用法：node scripts/_probe-mp4fps.mjs [端口=8787]
 *
 * 注：这里直接把渲染端那份 `mediaInfo.ts` 拿来跑（Node 24 自带 TS 类型擦除），
 * 只把打包器风格的无扩展名 import 换掉 —— 保证"测的就是线上那段代码"。
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// 临时目录一律放**项目内**的 .cache/tmp —— 不用 C 盘的 %TEMP%（用户 C 盘敏感，2026-09-25 统一改）
const SCRATCH_DIR = resolve(import.meta.dirname, '..', '.cache', 'tmp')
mkdirSync(SCRATCH_DIR, { recursive: true })


const port = Number(process.argv[2] || 8787)
const base = `http://127.0.0.1:${port}/api/v1`

const sourcePath = join(import.meta.dirname, '..', 'src', 'renderer', 'src', 'utils', 'mediaInfo.ts')
const patched = readFileSync(sourcePath, 'utf8').replace(
  /import \{ fileUrl \} from '\.\.\/api'/,
  'const fileUrl = (base, id) => `${base}/file/${id}`'
)
const probePath = join(SCRATCH_DIR, 'gm-mediaInfo-probe.ts')
writeFileSync(probePath, patched)
const { probeVideoFrameRate } = await import(pathToFileURL(probePath).href)

const media = (await (await fetch(`${base}/media?kind=video`)).json()).media
console.log(`库里的视频共 ${media.length} 个，挑前 5 个算帧率：`)

const COMMON = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60]
for (const item of media.slice(0, 5)) {
  const started = Date.now()
  let fps = null
  let error = ''
  try {
    fps = await probeVideoFrameRate(base, item.id, item.size)
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  const plausible = fps !== null && COMMON.some((v) => Math.abs(v - fps) < 0.6)
  const verdict = fps === null ? '(读不出)' : plausible ? '✅ 常见帧率' : '⚠️ 非常见帧率，解析可疑'
  console.log(
    `  #${item.id} ${item.displayName}  ${(item.size / 1024 / 1024).toFixed(1)}MB  ` +
      `${((item.durationMs ?? 0) / 1000).toFixed(1)}s  →  ${fps === null ? '—' : fps.toFixed(3)} 帧/秒  ` +
      `${verdict}${error ? `  错误=${error}` : ''}  [${Date.now() - started}ms]`
  )
}
