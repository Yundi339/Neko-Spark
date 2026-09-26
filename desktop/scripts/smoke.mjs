/**
 * 端到端冒烟测试：
 *   启动构建后的应用 → 导入真实图片 → 跑协议 v1（模拟手机端）→ 检查界面/查看器 → 导出还原
 * 运行：npm.cmd run test:smoke
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createSocket } from 'node:dgram'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import sharp from 'sharp'

// 临时目录一律放**项目内**的 .cache/tmp —— 不用 C 盘的 %TEMP%（用户 C 盘敏感，2026-09-25 统一改）
const SCRATCH_DIR = resolve(import.meta.dirname, '..', '.cache', 'tmp')
mkdirSync(SCRATCH_DIR, { recursive: true })


const projectRoot = resolve(import.meta.dirname, '..')
const isWindows = process.platform === 'win32'
const electronExe = join(
  projectRoot,
  'node_modules',
  'electron',
  'dist',
  isWindows ? 'electron.exe' : 'electron'
)
/** 指定后测试打包产物：GM_SMOKE_APP=release/win-unpacked/GalleryMirror.exe */
const appExe = process.env.GM_SMOKE_APP ? resolve(projectRoot, process.env.GM_SMOKE_APP) : electronExe

const HUB_PORT = 8799
const CDP_PORT = 9223
const dataDir = mkdtempSync(join(SCRATCH_DIR, 'gm-smoke-'))
const importDir = mkdtempSync(join(SCRATCH_DIR, 'gm-import-'))
const mockDir = mkdtempSync(join(SCRATCH_DIR, 'gm-mock-'))
const exportDir = mkdtempSync(join(SCRATCH_DIR, 'gm-export-'))
// 兜底解码器（HEIC/BMP）的样本目录
const decoderDir = mkdtempSync(join(SCRATCH_DIR, 'gm-decoder-'))
// 导入视频的元数据（mvhd/tkhd 解析）样本目录
const videoMetaDir = mkdtempSync(join(SCRATCH_DIR, 'gm-videometa-'))

const results = []

function check(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? `  (${detail})` : ''}`)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 确保查看器是关着的。
 * ⚠️ 有些段落会把查看器留在打开状态，那层覆盖物会**挡住侧栏点击** ——
 * 于是"点侧栏切视图"切不过去，后面的格子查找当然找不到目标
 * （2026-09-25 实测偶发过 3 条假失败："没滚动到那个格子"）。
 *
 * ⚠️ `evaluate` 是在 try 里定义的 const（不是顶层函数），所以得从调用方传进来。
 */
async function closeViewerIfOpen(evaluate) {
  const open = await evaluate(`!!document.querySelector('.viewer')`)
  if (!open) return
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`)
  await waitFor(async () => ((await evaluate(`!document.querySelector('.viewer')`)) ? 'closed' : null), 8000)
}

async function waitFor(fn, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  let lastErr
  while (Date.now() < deadline) {
    try {
      const value = await fn()
      if (value) return value
    } catch (err) {
      lastErr = err
    }
    await sleep(intervalMs)
  }
  throw new Error(`等待超时${lastErr ? `：${lastErr.message}` : ''}`)
}

function killTree(pid) {
  if (!pid) return
  if (isWindows) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      /* 已退出 */
    }
  }
}

async function prepareTestMedia() {
  mkdirSync(join(importDir, 'Camera'), { recursive: true })
  mkdirSync(join(importDir, 'Screenshots'), { recursive: true })
  mkdirSync(join(mockDir, 'DCIM', 'Camera'), { recursive: true })
  mkdirSync(join(mockDir, 'Camera'), { recursive: true })

  const makeJpeg = (file, r, g, b) =>
    sharp({ create: { width: 1200, height: 900, channels: 3, background: { r, g, b } } })
      .jpeg({ quality: 80 })
      .toFile(file)

  await makeJpeg(join(importDir, 'Camera', 'IMG_0001.jpg'), 210, 90, 70)
  await makeJpeg(join(importDir, 'Camera', 'IMG_0002.jpg'), 70, 150, 210)
  await makeJpeg(join(importDir, 'Camera', 'IMG_0003.jpg'), 90, 200, 120)
  await sharp({ create: { width: 1080, height: 2340, channels: 3, background: { r: 40, g: 40, b: 60 } } })
    .png()
    .toFile(join(importDir, 'Screenshots', 'Screenshot_20260108.png'))
  writeFileSync(join(importDir, 'Camera', 'VID_0001.mp4'), Buffer.from('fake-video-content-for-test'))

  const setTime = (file, iso) => utimesSync(file, new Date(iso), new Date(iso))
  // 数据目录里放一张背景大图：相册视图会把它渲染成 `.page-bg`（position:absolute）。
  // 不放的话"背景图不许盖住相册卡片"那条回归测试就没意义（没有背景图可盖）。
  await sharp({ create: { width: 64, height: 40, channels: 3, background: { r: 90, g: 160, b: 220 } } })
    .webp()
    .toFile(join(dataDir, 'background-4.webp'))
  setTime(join(importDir, 'Camera', 'IMG_0001.jpg'), '2026-01-05T10:00:00')
  setTime(join(importDir, 'Camera', 'IMG_0002.jpg'), '2026-01-06T11:00:00')
  setTime(join(importDir, 'Camera', 'IMG_0003.jpg'), '2026-01-07T12:00:00')
  setTime(join(importDir, 'Screenshots', 'Screenshot_20260108.png'), '2026-01-08T09:00:00')
  setTime(join(importDir, 'Camera', 'VID_0001.mp4'), '2026-01-04T08:00:00')

  // 模拟手机：前两张与导入内容完全相同（测去重），第三张是新的
  writeFileSync(
    join(mockDir, 'DCIM', 'Camera', 'IMG_0001.jpg'),
    readFileSync(join(importDir, 'Camera', 'IMG_0001.jpg'))
  )
  writeFileSync(
    join(mockDir, 'DCIM', 'Camera', 'IMG_0002.jpg'),
    readFileSync(join(importDir, 'Camera', 'IMG_0002.jpg'))
  )
  // 与本地导入的设备"同路径同名"，用于测试合并时的去重
  writeFileSync(
    join(mockDir, 'Camera', 'IMG_0001.jpg'),
    readFileSync(join(importDir, 'Camera', 'IMG_0001.jpg'))
  )
  await makeJpeg(join(mockDir, 'DCIM', 'Camera', 'IMG_MOCK_NEW.jpg'), 240, 200, 60)
  setTime(join(mockDir, 'DCIM', 'Camera', 'IMG_MOCK_NEW.jpg'), '2026-02-01T15:30:00')
}

function sha256FileSync(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

let child = null
let ws = null
let passed = false

try {
  if (!existsSync(appExe)) throw new Error(`找不到应用：${appExe}`)
  if (appExe === electronExe && !existsSync(join(projectRoot, 'out', 'main', 'index.js'))) {
    throw new Error('缺少构建产物 out/，请先执行 npm.cmd run build')
  }

  await prepareTestMedia()

  console.log('Neko_Spark 端到端测试')
  console.log(`  数据目录: ${dataDir}`)
  console.log(`  导入目录: ${importDir}`)
  console.log('')

  const spawnArgs =
    appExe === electronExe ? ['.', `--remote-debugging-port=${CDP_PORT}`] : [`--remote-debugging-port=${CDP_PORT}`]
  child = spawn(appExe, spawnArgs, {
    cwd: projectRoot,
    env: {
      ...process.env,
      GALLERY_MIRROR_DATA: dataDir,
      GALLERY_MIRROR_PORT: String(HUB_PORT)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})

  // ---------- 一、Hub 服务 ----------
  console.log('一、Hub 服务')
  const base = `http://127.0.0.1:${HUB_PORT}/api/v1`
  const health = await waitFor(async () => {
    const res = await fetch(`${base}/health`)
    return res.ok ? res.json() : null
  }, 30000)
  check('健康检查返回 protocolVersion=1', health.protocolVersion === 1, `version=${health.version}`)

  const info0 = await (await fetch(`${base}/info`)).json()
  check('仓库信息指向测试目录', info0.dataDir === dataDir, info0.dataDir)
  check('初始统计为 0', info0.counts.media === 0 && info0.counts.blobs === 0)

  const notFound = await fetch(`${base}/nope`)
  check('未知路由返回 404', notFound.status === 404)

  const stickerList = await (await fetch(`${base}/stickers`)).json()
  check(
    '贴图接口可用（默认使用内置吉祥物）',
    Array.isArray(stickerList.stickers) && stickerList.stickers.length === 0,
    `stickers=${stickerList.stickers.length}`
  )

  // 局域网发现（手机端"搜索电脑"用的 UDP 应答）
  // 注意：本机可能同时运行着正式版程序，会一起应答，所以收集所有应答再判断
  const discoveredPorts = await new Promise((resolve) => {
    const socket = createSocket('udp4')
    const ports = new Set()
    const timer = setTimeout(() => {
      try {
        socket.close()
      } catch {
        /* 忽略 */
      }
      resolve([...ports])
    }, 3000)
    socket.on('message', (msg) => {
      try {
        const data = JSON.parse(msg.toString())
        if (data.port) ports.add(Number(data.port))
      } catch {
        /* 忽略非法包 */
      }
    })
    socket.on('error', () => {
      clearTimeout(timer)
      resolve([...ports])
    })
    socket.bind(() => {
      try {
        socket.setBroadcast(true)
      } catch {
        /* 忽略 */
      }
      const payload = Buffer.from('GALLERY_MIRROR_DISCOVER')
      // 用广播地址，保证本机所有 Hub 实例都能收到（点对点会被先绑定的实例独占）
      for (const target of ['255.255.255.255', '127.0.0.1']) {
        try {
          socket.send(payload, 0, payload.length, 8788, target)
        } catch {
          /* 忽略 */
        }
      }
    })
  })
  check(
    '局域网发现应答正常（手机搜索电脑）',
    discoveredPorts.includes(HUB_PORT),
    `应答端口=${discoveredPorts.join(',')}`
  )

  // ---------- 二、磁盘与数据库 ----------
  console.log('')
  console.log('二、磁盘与数据库')
  for (const dir of ['blobs', 'thumbs', 'mirror', 'tmp']) {
    check(`目录 ${dir}/ 自动创建`, existsSync(join(dataDir, dir)))
  }

  const sqlite = new DatabaseSync(join(dataDir, 'manifest.db'), { readOnly: true })
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all()
    .map((r) => r.name)
  for (const t of ['devices', 'blobs', 'media', 'albums', 'meta']) {
    check(`数据表 ${t}`, tables.includes(t))
  }
  const journal = sqlite.prepare('PRAGMA journal_mode').get().journal_mode
  check('SQLite 使用 WAL 模式', journal === 'wal', journal)
  sqlite.close()

  // ---------- 三、建立 CDP 连接 ----------
  console.log('')
  console.log('三、界面基础')
  const target = await waitFor(async () => {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
    if (!res.ok) return null
    const list = await res.json()
    return list.find((t) => t.type === 'page') ?? null
  }, 30000)

  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = () => res()
    ws.onerror = () => rej(new Error('CDP WebSocket 连接失败'))
  })

  let msgId = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data)
    const handler = pending.get(msg.id)
    if (handler) {
      pending.delete(msg.id)
      handler(msg)
    }
  }
  const cdp = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++msgId
      pending.set(id, (msg) => (msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)))
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
    return r.result.value
  }

  await waitFor(async () => {
    const text = await evaluate('document.body ? document.body.innerText : ""')
    return text && text.includes('运行中') ? text : null
  }, 20000)

  const dom0 = JSON.parse(
    await evaluate(`JSON.stringify({
      title: document.title,
      navCount: document.querySelectorAll('.nav-item').length,
      hasApi: typeof window.gm === 'object' && typeof window.gm.importFolder === 'function',
      hasExport: typeof window.gm.exportTo === 'function',
      body: document.body.innerText.replace(/\\s+/g, ' ')
    })`)
  )
  check('窗口标题包含 Neko_Spark', dom0.title.includes('Neko_Spark'), dom0.title)
  check('preload 桥接暴露导入/导出 API', dom0.hasApi && dom0.hasExport)
  check('侧栏含 7 个导航项（含回收站）', dom0.navCount === 7, `nav=${dom0.navCount}`)
  check('空库时显示"还没有照片"', dom0.body.includes('还没有照片'))

  // ---------- 四、设置页 ----------
  console.log('')
  console.log('四、设置页')
  await evaluate(`document.querySelectorAll('.nav-item')[6].click(); true`)
  await sleep(400)
  const settingsText = await evaluate('document.body.innerText.replace(/\\s+/g, " ")')
  check('设置页显示存储位置', settingsText.includes('存储位置'))
  check('设置页显示运行时缓存', settingsText.includes('运行时缓存'))
  check('设置页显示贴图设置', settingsText.includes('贴图'))
  check('设置页显示已删除文件开关', settingsText.includes('显示已删除的文件'))
  check('设置页显示仓库路径', settingsText.includes(dataDir))
  await evaluate(`document.querySelectorAll('.nav-item')[0].click(); true`)
  await sleep(300)

  // ---------- 五、导入管线 ----------
  console.log('')
  console.log('五、导入管线（本地文件夹）')
  const importResult = JSON.parse(
    await evaluate(
      `window.gm.importFolder(${JSON.stringify(importDir)}).then((p) => JSON.stringify({
        phase: p.phase, total: p.total, imported: p.imported, skipped: p.skipped, failed: p.failed
      }))`
    )
  )
  check('导入任务完成', importResult.phase === 'done', `phase=${importResult.phase}`)
  check('导入 5 个媒体文件', importResult.imported === 5 && importResult.total === 5, JSON.stringify(importResult))
  check('无失败项', importResult.failed === 0)

  const mediaAfterImport = (await (await fetch(`${base}/media`)).json()).media
  check('媒体列表返回 5 条', mediaAfterImport.length === 5, `count=${mediaAfterImport.length}`)
  check(
    '图片与视频分类正确',
    mediaAfterImport.filter((m) => m.kind === 'image').length === 4 &&
      mediaAfterImport.filter((m) => m.kind === 'video').length === 1
  )
  check('拍摄时间按现有时间戳排序（最新在前）', mediaAfterImport[0].displayName === 'Screenshot_20260108.png')

  const albums = (await (await fetch(`${base}/albums`)).json()).albums
  check('识别出 2 个相册', albums.length === 2, albums.map((a) => a.bucketName).join(','))

  const firstImage = mediaAfterImport.find((m) => m.kind === 'image')
  const thumbRes = await waitFor(async () => {
    const res = await fetch(`${base}/thumb/${firstImage.id}`)
    return res.ok ? res : null
  }, 20000)
  const thumbBuffer = Buffer.from(await thumbRes.arrayBuffer())
  // 缩略图现在是 JPEG（解码比 WebP 快 3.2 倍，观感不变）—— 校验 JPEG 魔数 FFD8FF
  check(
    '缩略图接口返回 JPEG（解码比 webp 快 3 倍）',
    thumbRes.headers.get('content-type') === 'image/jpeg' &&
      thumbBuffer.length > 100 &&
      thumbBuffer[0] === 0xff &&
      thumbBuffer[1] === 0xd8,
    `${thumbBuffer.length} 字节`
  )

  const videoItem = mediaAfterImport.find((m) => m.kind === 'video')
  if (videoItem) {
    const videoThumb = await fetch(`${base}/thumb/${videoItem.id}`)
    check('视频缩略图直接返回 404（不送进 sharp）', videoThumb.status === 404, `HTTP ${videoThumb.status}`)
  } else {
    check('视频缩略图直接返回 404（不送进 sharp）', false, '测试库里没有视频，无法验证')
  }

  const fileRes = await fetch(`${base}/file/${firstImage.id}`)
  check('原图接口可访问', fileRes.ok && Number(fileRes.headers.get('content-length')) > 0)
  const rangeRes = await fetch(`${base}/file/${firstImage.id}`, { headers: { Range: 'bytes=0-99' } })
  check(
    '原图支持 Range（视频拖动）',
    rangeRes.status === 206 && (rangeRes.headers.get('content-range') || '').startsWith('bytes 0-99/')
  )

  const devAfterImport = (await (await fetch(`${base}/devices`)).json()).devices
  check('生成 1 个设备记录', devAfterImport.length === 1, devAfterImport[0]?.name)

  // ---------- 六、协议 v1（模拟手机端） ----------
  console.log('')
  console.log('六、协议 v1（mock-phone 全流程）')
  const mockRun = spawnSync(
    process.execPath,
    [join(projectRoot, 'tools', 'mock-phone', 'index.mjs'), mockDir, '--url', `http://127.0.0.1:${HUB_PORT}`, '--device', '模拟手机'],
    { encoding: 'utf-8' }
  )
  const mockOut = `${mockRun.stdout ?? ''}${mockRun.stderr ?? ''}`
  check('mock-phone 退出码为 0', mockRun.status === 0, `status=${mockRun.status}`)
  check('识别出 4 个文件', mockOut.includes('发现 4 个媒体文件'))
  check('去重生效（只需上传 1 个新文件）', mockOut.includes('需要上传 1 个'), mockOut.split('\n').find((l) => l.includes('需要上传')) ?? '')

  const counts = (await (await fetch(`${base}/info`)).json()).counts
  check('媒体总数 = 9', counts.media === 9, `media=${counts.media}`)
  check('去重后文件数 = 6', counts.blobs === 6, `blobs=${counts.blobs}`)
  check('设备数 = 2（两台手机分开记录）', counts.devices === 2, `devices=${counts.devices}`)

  // ---------- 七、相册界面与查看器 ----------
  console.log('')
  console.log('七、相册界面与查看器')
  // 等列表真正加载完再断言。注意不能只等"格子数 ≥6" —— 旧数据也能满足这个条件，
  // 那样会在界面刷新前就开始断言（界面收到 data:changed 后最多晚 600ms 才刷新）。
  await waitFor(async () => {
    const text = await evaluate(`document.body.innerText.replace(/\\s+/g, ' ')`)
    return text.includes('9 项媒体') ? text : null
  }, 20000)
  const tileCount = await evaluate(`document.querySelectorAll('.tile:not(.tile-empty)').length`)
  check('时间线渲染出可见格子（虚拟滚动只渲染视口内）', tileCount >= 6, `tiles=${tileCount}`)
  const topbarText = await evaluate(`document.body.innerText.replace(/\\s+/g, ' ')`)
  check('顶栏媒体总数正确（9 项）', topbarText.includes('9 项媒体'))
  const headerText = await evaluate(`(document.querySelector('.row-header') || {}).innerText || ''`)
  check('时间线按日期分组显示表头', headerText.includes('月') && headerText.includes('项'), headerText.replace(/\n/g, ' '))

  const deviceItems = await evaluate(`document.querySelectorAll('.device-filter-item').length`)
  check('侧栏列出"全部设备" + 2 台设备', deviceItems === 3, `items=${deviceItems}`)

  await evaluate(
    `Array.from(document.querySelectorAll('.device-filter-item')).find(b => b.innerText.includes('模拟手机')).click(); true`
  )
  const filteredTiles = await waitFor(async () => {
    const count = await evaluate(`document.querySelectorAll('.tile:not(.tile-empty)').length`)
    return count === 4 ? count : null
  }, 10000)
  check('按设备筛选后只显示该设备的内容', filteredTiles === 4, `tiles=${filteredTiles}`)
  const filteredText = await evaluate(`document.body.innerText.replace(/\\s+/g, ' ')`)
  check('顶栏提示当前筛选的设备', filteredText.includes('只看：模拟手机'))
  await evaluate(`document.querySelectorAll('.device-filter-item')[0].click(); true`)
  await sleep(500)

  await evaluate(`document.querySelectorAll('.nav-item')[1].click(); true`)
  await waitFor(async () => {
    const count = await evaluate(`document.querySelectorAll('.album-card').length`)
    return count >= 4 ? count : null
  }, 15000)
  const albumCards = await evaluate(`document.querySelectorAll('.album-card').length`)
  check('相册页按"设备 + 相册"显示 4 个相册', albumCards === 4, `albums=${albumCards}`)

  // 回归（2026-09-25 用户实测："显示异常"）：相册视图那张背景大图（`.page-bg`，position:absolute）
  // **曾经盖在相册卡片上面** —— 卡片被罩成半透明、右侧还被整块挡住。
  // 按 CSS 绘制顺序，定位元素画在非定位元素之上，而 `.album-grid` 当时没有任何定位
  // （别的视图没事：`.vgrid-inner` 本来就有 position:relative，`.empty-content`/`.grid-toolbar` 有 z-index）。
  //
  // ⚠️ 这里**不能用 elementFromPoint** 断言：`.page-bg` 是 `pointer-events: none`，
  // 命中测试会穿透它、照样命中卡片 —— 盖住了也测不出来。所以改成**真的截屏取色**：
  // 卡片内边距那一小块本该是卡片的纯白底（#ffffff），被背景图（本测试里是一整块 rgb(90,160,220)）盖住就会变蓝。
  const cardBox = JSON.parse(
    await evaluate(`(() => {
      const card = document.querySelector('.album-card');
      const bg = document.querySelector('.page-bg');
      if (!card) return JSON.stringify({ card: false, bg: !!bg });
      const r = card.getBoundingClientRect();
      return JSON.stringify({ card: true, bg: !!bg, x: r.left, y: r.top, w: r.width, dpr: window.devicePixelRatio || 1 });
    })()`)
  )
  if (cardBox.card && cardBox.bg) {
    // 窗口被遮挡/最小化时 Chromium 不产帧、截图会是空白 —— 先提到前台（附录 C 有记这条坑）
    await cdp('Page.bringToFront').catch(() => undefined)
    await sleep(400)
    const shot = await cdp('Page.captureScreenshot', { format: 'png' })
    const raw = await sharp(Buffer.from(shot.data, 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    // 取"卡片上边内边距中间"那一点：避开圆角（16px 半径）和封面图，落点是卡片的白色底
    const px = Math.round((cardBox.x + cardBox.w / 2) * cardBox.dpr)
    const py = Math.round((cardBox.y + 5) * cardBox.dpr)
    const at = (py * raw.info.width + px) * raw.info.channels
    const [r, g, b] = [raw.data[at], raw.data[at + 1], raw.data[at + 2]]
    check(
      '相册卡片没被背景大图盖住（截屏取色是卡片白底，不是背景图的蓝）',
      r > 235 && g > 235 && b > 235,
      `取样点 rgb(${r},${g},${b})`
    )
  } else {
    check('相册卡片没被背景大图盖住（截屏取色是卡片白底，不是背景图的蓝）', false, `卡片=${cardBox.card} 背景图=${cardBox.bg}`)
  }

  // Ctrl + 滚轮缩放相册卡片（2026-09-25 用户反馈："相册 tab 加鼠标滚轮无法放大放小"）。
  //
  // ⚠️⚠️ 这段**必须复现线上的挂载时序**：相册视图是在"相册还是空的"时候挂载的
  //（用户点"相册"时媒体数据常常还没加载完）。第一版实现就挂在这儿 ——
  // 滚轮监听挂在 ref 上、空状态却 return 了另一个 div，而 effect 只在挂载时跑一次，
  // 于是监听**永远没挂上**。当时我在"数据已就绪"的状态下派发滚轮事件，测试是绿的，
  // 真机却是死的（**合成事件 + 错误的挂载时机 = 假阳性**，实测踩过）。
  // 所以这里先制造"空"：把导入设备的媒体临时移进回收站 → 以空状态挂载相册视图 → 再恢复。
  const zoomTestDeviceName = importDir.split(/[\\/]/).pop()
  const importDevice = (await (await fetch(`${base}/devices`)).json()).devices.find(
    (d) => d.name === zoomTestDeviceName
  )
  const importIds = (
    await (await fetch(`${base}/media?deviceId=${importDevice?.id ?? ''}`)).json()
  ).media.map((m) => m.id)
  const postJson = (path, body) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })

  await postJson('/media/trash', { ids: importIds })
  await evaluate(`Array.from(document.querySelectorAll('.device-filter-item')).find(b => b.innerText.includes(${JSON.stringify(zoomTestDeviceName)})).click(); true`)
  await evaluate(`document.querySelectorAll('.nav-item')[0].click(); true`) // 切走
  await sleep(300)
  await evaluate(`document.querySelectorAll('.nav-item')[1].click(); true`) // 以"空"的状态挂载相册视图
  const emptyMounted = await waitFor(
    async () => ((await evaluate(`!!document.querySelector('.empty-state')`)) ? true : null),
    10000
  )
  check('相册视图能在"空的"状态下挂载（复现用户点开时的时序）', emptyMounted === true)

  await postJson('/media/restore', { ids: importIds })
  const cardsBack = await waitFor(
    async () => ((await evaluate(`document.querySelectorAll('.album-card').length > 0`)) ? true : null),
    15000
  )
  check('恢复后相册卡片出现（同一个组件实例从"空"变"有"）', cardsBack === true)

  const albumCardWidth = async () =>
    Number(
      await evaluate(
        `(() => { const c = document.querySelector('.album-card'); return c ? Math.round(c.getBoundingClientRect().width) : 0 })()`
      )
    )
  const wheelZoomAlbums = async (deltaY) => {
    await evaluate(`(() => {
      const el = document.querySelector('.grid-wrap');
      el.dispatchEvent(new WheelEvent('wheel', { deltaY: ${deltaY}, ctrlKey: true, bubbles: true, cancelable: true }));
      return true;
    })()`)
    await sleep(250)
  }
  await wheelZoomAlbums(120) // 缩小一档
  const shrunkWidth = await albumCardWidth()
  await wheelZoomAlbums(-120) // 放大一档
  const grownWidth = await albumCardWidth()
  check(
    '相册视图里 Ctrl+滚轮能放大/缩小卡片（含"先空后有"的时序）',
    shrunkWidth > 0 && grownWidth > shrunkWidth,
    `一档缩小后 ${shrunkWidth}px → 一档放大后 ${grownWidth}px`
  )
  // 收尾：筛选回到"全部设备"，免得后面的段落只在某个设备里找东西
  await evaluate(`document.querySelectorAll('.device-filter-item')[0].click(); true`)
  await sleep(400)

  // 侧键＝退出当前这一层：进了相册详情之后，按它应当退回相册列表（2026-09-25 用户反馈）
  // ⚠️ 用户鼠标上"下/后侧键"发的是 DOM **button 3**（不是 4）—— 这两个都验一遍，
  //    免得哪天物理映射又对不上、他按哪个都出不来。
  const inAlbumDetail = async () =>
    (await evaluate(`document.querySelectorAll('.album-card').length === 0 && !!document.querySelector('.title-with-back')`))
      ? true
      : null
  const backInAlbumList = async () =>
    (await evaluate(
      `document.querySelectorAll('.album-card').length > 0 && !document.querySelector('.title-with-back')`
    ))
      ? true
      : null

  await evaluate(`document.querySelector('.album-card').click(); true`)
  const enteredAlbum = await waitFor(inAlbumDetail, 10000)
  check('点相册卡片进入相册详情', enteredAlbum === true)
  await sleep(400)
  await evaluate(`window.dispatchEvent(new MouseEvent('mouseup', { button: 3, bubbles: true })); true`)
  const backByRear = await waitFor(backInAlbumList, 8000)
  check('相册详情里按【下/后侧键】（button 3）退回相册列表', backByRear === true)

  // 另一个侧键（button 4）在相册里也应当能退出（浏览器的"后退"本来就是退一层）
  await evaluate(`document.querySelector('.album-card').click(); true`)
  await waitFor(inAlbumDetail, 10000)
  await sleep(400)
  await evaluate(`window.dispatchEvent(new MouseEvent('mouseup', { button: 4, bubbles: true })); true`)
  const backByFront = await waitFor(backInAlbumList, 8000)
  check('相册详情里按【上/前侧键】（button 4）也能退回相册列表', backByFront === true)

  await evaluate(`document.querySelectorAll('.nav-item')[0].click(); true`)
  await sleep(400)
  await evaluate(`document.querySelector('.tile').click(); true`)
  await waitFor(async () => {
    const open = await evaluate(`!!document.querySelector('.viewer')`)
    return open ? true : null
  }, 10000)
  const viewerInfo = JSON.parse(
    await waitFor(async () => {
      const result = await evaluate(`(() => {
        const img = document.querySelector('img.viewer-media');
        const video = document.querySelector('video.viewer-media');
        return JSON.stringify({
          tag: img ? 'IMG' : (video ? 'VIDEO' : 'NONE'),
          loaded: img ? (img.complete && img.naturalWidth > 0) : false,
          info: (document.querySelector('.viewer-info') || {}).innerText || ''
        });
      })()`)
      const parsed = JSON.parse(result)
      const ready = parsed.tag === 'IMG' ? parsed.loaded : parsed.tag === 'VIDEO'
      return ready && parsed.info.includes('文件名') ? result : null
    }, 15000)
  )
  check('查看器打开的是图片', viewerInfo.tag === 'IMG', viewerInfo.tag)
  check('查看器图片加载成功', viewerInfo.loaded === true)
  check('查看器显示文件信息', viewerInfo.info.includes('文件名') && viewerInfo.info.includes('拍摄时间'))

  // 图片必须被完整容纳在舞台内、不许溢出。
  // 回归：曾经给 .viewer-motion 写 height:100%，造成"百分比高度循环依赖"，
  // 竖长图（手机截图 1080×2340）会撑破容器、超出屏幕 1400+ px。
  // 这里翻几张挨个量，保证覆盖到竖长的那张。
  const fitResults = []
  for (let i = 0; i < 5; i += 1) {
    const one = JSON.parse(
      await evaluate(`(() => {
        const stage = document.querySelector('.viewer-stage')
        const img = document.querySelector('img.viewer-media')
        if (!stage || !img) return JSON.stringify({ err: 'no img' })
        const s = stage.getBoundingClientRect()
        const b = img.getBoundingClientRect()
        return JSON.stringify({
          natural: img.naturalWidth + 'x' + img.naturalHeight,
          stageH: Math.round(s.height),
          imgH: Math.round(b.height),
          imgW: Math.round(b.width),
          stageW: Math.round(s.width)
        })
      })()`)
    )
    if (!one.err) fitResults.push(one)
    if (i < 4) {
      await evaluate(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })); return true })()`)
      await sleep(500)
    }
  }
  const bad = fitResults.filter((r) => r.imgH > r.stageH + 1 || r.imgW > r.stageW + 1)
  const portrait = fitResults.find((r) => {
    const [w, h] = r.natural.split('x').map(Number)
    return h > w
  })
  check(
    `图片完整容纳在舞台内（量了 ${fitResults.length} 张${portrait ? `，含竖长图 ${portrait.natural}` : ''}）`,
    fitResults.length > 0 && bad.length === 0,
    bad.length
      ? bad.map((r) => `${r.natural} 渲染 ${r.imgW}×${r.imgH} 超出舞台 ${r.stageW}×${r.stageH}`).join('; ')
      : `全部 ≤ 舞台 ${fitResults[0].stageW}×${fitResults[0].stageH}`
  )

  // 收藏功能
  await evaluate(`Array.from(document.querySelectorAll('.viewer-actions .btn')).find(b => b.innerText.includes('收藏')).click(); true`)
  await sleep(600)
  const favCount = (await (await fetch(`${base}/media?favorites=1`)).json()).media.length
  check('收藏状态可保存', favCount === 1, `favorites=${favCount}`)
  await evaluate(`Array.from(document.querySelectorAll('.viewer-actions .btn')).find(b => b.innerText.includes('关闭')).click(); true`)
  await sleep(300)

  // ---------- 八、导出还原 ----------
  console.log('')
  console.log('八、导出还原（文件夹树 + 时间）')
  const exportResult = JSON.parse(
    await evaluate(
      `window.gm.exportTo(${JSON.stringify(exportDir)}, {}).then((p) => JSON.stringify({
        phase: p.phase, total: p.total, imported: p.imported, failed: p.failed
      }))`
    )
  )
  check('导出任务完成', exportResult.phase === 'done' && exportResult.imported === 9, JSON.stringify(exportResult))
  check('导出无失败项', exportResult.failed === 0)

  const importDeviceName = importDir.split(/[\\/]/).pop()
  const exportedImage = join(exportDir, importDeviceName, 'Camera', 'IMG_0001.jpg')
  const exportedMock = join(exportDir, '模拟手机', 'DCIM', 'Camera', 'IMG_MOCK_NEW.jpg')
  check('导出目录结构与手机一致', existsSync(exportedImage), exportedImage.replace(exportDir, '...'))
  check('模拟手机的文件也按目录树导出', existsSync(exportedMock))

  if (existsSync(exportedImage)) {
    const originalHash = sha256FileSync(join(importDir, 'Camera', 'IMG_0001.jpg'))
    const exportedHash = sha256FileSync(exportedImage)
    check('导出文件内容一致（逐字节）', originalHash === exportedHash)
    const originalStat = await stat(join(importDir, 'Camera', 'IMG_0001.jpg'))
    const exportedStat = await stat(exportedImage)
    check(
      '导出文件保留修改时间',
      Math.abs(Math.round(originalStat.mtimeMs) - Math.round(exportedStat.mtimeMs)) < 2000,
      `${new Date(originalStat.mtimeMs).toISOString()} vs ${new Date(exportedStat.mtimeMs).toISOString()}`
    )
  }

  // ---------- 九、多设备区分与可逆合并 ----------
  console.log('')
  console.log('九、多设备区分与可逆合并（主/副设备）')
  const importDeviceId = devAfterImport[0].id
  const deviceList = (await (await fetch(`${base}/devices`)).json()).devices
  const mockDeviceId = deviceList.find((d) => d.id !== importDeviceId)?.id ?? ''

  const countForDevice = async (deviceId) =>
    (await (await fetch(`${base}/media?deviceId=${encodeURIComponent(deviceId)}`)).json()).media.length
  check('按设备查询：本地导入 5 项', (await countForDevice(importDeviceId)) === 5)
  check('按设备查询：模拟手机 4 项', (await countForDevice(mockDeviceId)) === 4, `device=${mockDeviceId}`)

  const mergeResult = JSON.parse(
    await evaluate(
      `window.gm.mergeDevices(${JSON.stringify(mockDeviceId)}, ${JSON.stringify(importDeviceId)}).then((r) => JSON.stringify(r))`
    )
  )
  check('合并成功（副设备挂到主设备下）', mergeResult.mediaCount === 9, JSON.stringify(mergeResult))

  const devicesAfterMerge = (await (await fetch(`${base}/devices`)).json()).devices
  const mergedChild = devicesAfterMerge.find((d) => d.id === mockDeviceId)
  check('副设备记录保留（原始标签未改）', mergedChild?.mergedInto === importDeviceId, JSON.stringify(mergedChild))

  const groupMedia = (await (await fetch(`${base}/media?deviceId=${encodeURIComponent(importDeviceId)}`)).json()).media
  check('主设备视图包含副设备媒体（9 项）', groupMedia.length === 9, `count=${groupMedia.length}`)
  check('媒体仍带各自设备标签', new Set(groupMedia.map((m) => m.deviceId)).size === 2)

  const infoAfterMerge = await (await fetch(`${base}/info`)).json()
  check('合并不移动文件：媒体数仍为 9', infoAfterMerge.counts.media === 9, `media=${infoAfterMerge.counts.media}`)
  check('合并不删设备：设备数仍为 2', infoAfterMerge.counts.devices === 2, `devices=${infoAfterMerge.counts.devices}`)
  check('合并后去重文件数仍为 6', infoAfterMerge.counts.blobs === 6, `blobs=${infoAfterMerge.counts.blobs}`)

  const deviceItemsAfter = await waitFor(async () => {
    const count = await evaluate(`document.querySelectorAll('.device-filter-item').length`)
    return count === 2 ? count : null
  }, 15000)
  check('侧栏只列主设备（全部设备 + 1 台）', deviceItemsAfter === 2, `items=${deviceItemsAfter}`)

  const splitResult = JSON.parse(
    await evaluate(`window.gm.splitDevice(${JSON.stringify(importDeviceId)}).then((r) => JSON.stringify(r))`)
  )
  check('分离成功（副设备恢复独立）', splitResult.detached === 1, JSON.stringify(splitResult))
  const devicesAfterSplit = (await (await fetch(`${base}/devices`)).json()).devices
  check('分离后两台设备都独立', devicesAfterSplit.every((d) => !d.mergedInto))
  check(
    '分离后各查各的媒体',
    (await countForDevice(importDeviceId)) === 5 && (await countForDevice(mockDeviceId)) === 4
  )
  const deviceItemsRestored = await waitFor(async () => {
    const count = await evaluate(`document.querySelectorAll('.device-filter-item').length`)
    return count === 3 ? count : null
  }, 15000)
  check('界面恢复显示两台主设备', deviceItemsRestored === 3, `items=${deviceItemsRestored}`)

  // ---------- 十、手机已删除标记 ----------
  console.log('')
  console.log('十、手机已删除标记（电脑保留 + 界面标注）')
  const db2 = new DatabaseSync(join(dataDir, 'manifest.db'), { readOnly: true })
  const rows = db2
    .prepare('SELECT id, blob_sha256, display_name, relative_path FROM media WHERE device_id = ? AND deleted = 0')
    .all(importDeviceId)
  db2.close()

  const victim = rows[0]
  const toItems = (list) =>
    list.map((r) => ({
      sha256: r.blob_sha256,
      displayName: r.display_name,
      relativePath: r.relative_path
    }))

  const postManifest = async (list) => {
    const res = await fetch(`${base}/manifest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        device: { deviceId: importDeviceId, name: '已删除标记测试' },
        items: toItems(list)
      })
    })
    return res.json()
  }

  const res1 = await postManifest(rows.slice(1))
  check('清单少了 1 项 → 服务端标记删除', res1.changed >= 1 && res1.missing === 1, JSON.stringify(res1))

  const afterDelete = (await (await fetch(`${base}/media?deviceId=${encodeURIComponent(importDeviceId)}`)).json()).media
  const marked = afterDelete.find((m) => m.id === victim.id)
  check(
    '被标记的项 sourceDeleted=true 且文件仍保留',
    marked?.sourceDeleted === true && Number(marked?.size) > 0,
    `size=${marked?.size}`
  )

  const infoMarked = await (await fetch(`${base}/info`)).json()
  check('仓库信息统计已删除数量', infoMarked.sourceDeleted === 1, `sourceDeleted=${infoMarked.sourceDeleted}`)

  // 虚拟滚动只渲染视口内的格子，需要滚动找到带角标的那张
  let badges = 0
  for (let i = 0; i < 40; i += 1) {
    badges = await evaluate(`document.querySelectorAll('.tile-deleted').length`)
    if (badges > 0) break
    await evaluate(`(() => {
      const grid = document.querySelector('.vgrid');
      if (grid) { grid.scrollTop += 520; grid.dispatchEvent(new Event('scroll')); }
      return true;
    })()`)
    await sleep(150)
  }
  check('界面缩略图显示"已删除"角标', badges === 1, `badges=${badges}`)

  const res2 = await postManifest(rows)
  check('文件重新出现后标记自动清除', res2.missing === 0 && res2.changed >= 1, JSON.stringify(res2))
  // 回到顶部再确认角标消失
  await evaluate(`(() => {
    const grid = document.querySelector('.vgrid');
    if (grid) { grid.scrollTop = 0; grid.dispatchEvent(new Event('scroll')); }
    return true;
  })()`)
  const cleared = await waitFor(async () => {
    const count = await evaluate(`document.querySelectorAll('.tile-deleted').length`)
    return count === 0 ? 'cleared' : null
  }, 15000)
  check('界面角标随之消失', cleared === 'cleared')

  // ---------- 十一、手机「准备中」阶段反馈 ----------
  // 手机算指纹可能要十几分钟且一个字节都不传，这段时间电脑端必须能看出"在干活"
  console.log('')
  console.log('十一、手机准备阶段反馈（扫描/算指纹时电脑端不再空白）')
  const prepDevice = {
    deviceId: 'mock-prepare',
    name: '准备测试机',
    model: 'MockPhone',
    androidVersion: '14'
  }
  const postPrepare = async (payload) => {
    const res = await fetch(`${base}/sync/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ protocolVersion: 1, device: prepDevice, ...payload })
    })
    return res.json()
  }
  const bannerText = async () => {
    const text = await evaluate(
      `(() => { const el = document.querySelector('.sync-banner-text'); return el ? el.textContent.replace(/\\s+/g, ' ').trim() : '' })()`
    )
    return String(text ?? '')
  }

  const startRes = await postPrepare({
    total: 500,
    totalBytes: 500 * 1024 * 1024,
    hashed: 0,
    hashedBytes: 0
  })
  check('手机上报「准备中」被接受', startRes.ok === true)

  const banner0 = await waitFor(async () => {
    const text = await bannerText()
    return text.includes('正在准备') ? text : null
  }, 10000)
  check('电脑端显示「正在准备」而不是一片空白', banner0.includes('正在准备'), banner0)

  await postPrepare({
    total: 500,
    totalBytes: 500 * 1024 * 1024,
    hashed: 320,
    hashedBytes: 320 * 1024 * 1024
  })
  const banner1 = await waitFor(async () => {
    const text = await bannerText()
    return text.includes('320') ? text : null
  }, 10000)
  check('准备进度（已算指纹 320 / 500）实时可见', banner1.includes('320') && banner1.includes('500'), banner1)

  // 网络上乱序到达的旧请求不能把进度拽回去
  await postPrepare({
    total: 500,
    totalBytes: 500 * 1024 * 1024,
    hashed: 100,
    hashedBytes: 100 * 1024 * 1024
  })
  await sleep(400)
  const banner2 = await bannerText()
  check('乱序到达的旧进度不会让进度回退', banner2.includes('320'), banner2)

  // 收到清单 = 指纹算完，应立刻切换成上传进度
  const prepareSha = createHash('sha256').update('prepare-stage-test').digest('hex')
  await fetch(`${base}/manifest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      protocolVersion: 1,
      device: prepDevice,
      items: [
        {
          sha256: prepareSha,
          displayName: 'prepare.jpg',
          relativePath: 'DCIM/Prepare/',
          bucketId: 'DCIM/Prepare',
          bucketName: 'Prepare',
          mimeType: 'image/jpeg',
          size: 1024,
          dateTaken: 1767225600000,
          dateModified: 1767225600000
        }
      ]
    })
  })
  const banner3 = await waitFor(async () => {
    const text = await bannerText()
    return text.includes('正在接收') ? text : null
  }, 10000)
  check('收到清单后切换为「正在接收」上传进度', banner3.includes('正在接收') && banner3.includes('0 / 1'), banner3)

  await fetch(`${base}/commit`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1, device: prepDevice, items: [] })
  })
  const bannerGone = await waitFor(async () => ((await bannerText()) === '' ? 'gone' : null), 15000)
  check('同步结束后提示自动消失', bannerGone === 'gone')

  // ---------- 十二、回收站 ----------
  console.log('')
  console.log('十二、回收站（删除 → 30 天倒计时 → 恢复 / 彻底删除）')

  const db3 = new DatabaseSync(join(dataDir, 'manifest.db'), { readOnly: true })
  const allRows = db3
    .prepare('SELECT id, device_id, blob_sha256, display_name, relative_path, kind FROM media ORDER BY id')
    .all()
  // 同一个内容被多条记录引用（跨设备去重）—— 彻底删除必须尊重它
  const sharedSha = db3
    .prepare('SELECT blob_sha256, COUNT(*) AS n FROM media GROUP BY blob_sha256 HAVING n > 1 LIMIT 1')
    .get()
  const uniqueSha = db3
    .prepare('SELECT blob_sha256, COUNT(*) AS n FROM media GROUP BY blob_sha256 HAVING n = 1 LIMIT 1')
    .get()
  db3.close()

  const trashOf = async () => (await (await fetch(`${base}/trash`)).json()).media
  const postIds = async (path, ids) => {
    const res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids })
    })
    return res.json()
  }
  const listOf = async (deviceId) =>
    (await (await fetch(`${base}/media?deviceId=${encodeURIComponent(deviceId)}`)).json()).media
  const blobFile = (sha) => join(dataDir, 'blobs', sha.slice(0, 2), sha)

  check('回收站初始为空', (await trashOf()).length === 0)

  const victimRow = allRows.find((r) => r.kind === 'image')
  const trash1 = await postIds('/media/trash', [victimRow.id])
  check('移入回收站返回 1 条', trash1.count === 1, JSON.stringify(trash1))

  const mediaAfterTrash = await listOf(importDeviceId)
  check(
    '移入回收站后从媒体列表消失（但记录还在）',
    !mediaAfterTrash.some((m) => m.id === victimRow.id),
    `items=${mediaAfterTrash.length}`
  )

  const trashList1 = await trashOf()
  const trashed = trashList1.find((m) => m.id === victimRow.id)
  check(
    '回收站里能看到它，且带删除时间与到期时间',
    !!trashed?.deletedAt && !!trashed?.purgeAt && trashed.purgeAt - trashed.deletedAt === 30 * 24 * 60 * 60 * 1000,
    `deletedAt=${trashed?.deletedAt} purgeAt=${trashed?.purgeAt}`
  )

  const trashThumb = await fetch(`${base}/thumb/${victimRow.id}`)
  check('回收站里的条目仍能出缩略图（要能挑着恢复）', trashThumb.status === 200, `HTTP ${trashThumb.status}`)

  const infoTrash = await (await fetch(`${base}/info`)).json()
  check(
    '仓库统计里回收站计数 = 1（界面角标用它）',
    infoTrash.counts.trash === 1,
    `trash=${infoTrash.counts.trash}`
  )

  const restore1 = await postIds('/media/restore', [victimRow.id])
  const restoredList = await listOf(importDeviceId)
  check(
    '恢复后回到原来的列表，回收站清空',
    restore1.count === 1 &&
      restoredList.some((m) => m.id === victimRow.id) &&
      (await trashOf()).length === 0,
    JSON.stringify(restore1)
  )

  // 去重安全：同一个 sha 还被别的记录引用时，绝不能删磁盘上的原文件
  if (sharedSha) {
    const sharedRows = allRows.filter((r) => r.blob_sha256 === sharedSha.blob_sha256)
    const purgedOne = sharedRows[0]
    const keptOne = sharedRows[1]
    await postIds('/media/trash', [purgedOne.id])
    const purged = await postIds('/media/purge', [purgedOne.id])
    check('彻底删除 1 条（记录 + 若有独占内容则连文件）', purged.count === 1, JSON.stringify(purged))
    check(
      '内容还被别的记录引用 → 磁盘文件必须保留',
      existsSync(blobFile(sharedSha.blob_sha256)),
      `refs=${sharedSha.n}`
    )
    const keptRes = await fetch(`${base}/file/${keptOne.id}`)
    const keptBuf = Buffer.from(await keptRes.arrayBuffer())
    check(
      '另一条同内容记录仍能取到完整文件',
      keptRes.status === 200 && keptBuf.length > 1000,
      `bytes=${keptBuf.length}`
    )

    // 墓碑：手机下次备份再上报这个文件时，不能再把它传回来 / 塞回列表
    // （墓碑是按 设备+路径+文件名 记的，所以要用它原本那台设备的身份上报）
    const replayDeviceId = purgedOne.device_id
    const replay = await fetch(`${base}/manifest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        protocolVersion: 1,
        device: { deviceId: replayDeviceId, name: '回收站测试机' },
        items: [
          {
            sha256: purgedOne.blob_sha256,
            displayName: purgedOne.display_name,
            relativePath: purgedOne.relative_path
          }
        ]
      })
    })
    const replayRes = await replay.json()
    check(
      '删过的文件再上报 → 不需要重新上传',
      !replayRes.needed.includes(purgedOne.blob_sha256),
      JSON.stringify(replayRes)
    )
    const afterReplay = await listOf(replayDeviceId)
    check(
      '删过的文件不会被清单重新塞回列表（防复活）',
      !afterReplay.some(
        (m) => m.displayName === purgedOne.display_name && m.relativePath === purgedOne.relative_path
      )
    )
  } else {
    check('找到共享同一内容的媒体记录（去重安全用例）', false, '测试库里没有共享内容')
  }

  // 到期自动清理：直接把 deleted_at 改成 31 天前，再打开回收站触发惰性清理
  if (uniqueSha) {
    const expiring = allRows.find((r) => r.blob_sha256 === uniqueSha.blob_sha256)
    await postIds('/media/trash', [expiring.id])
    const db4 = new DatabaseSync(join(dataDir, 'manifest.db'))
    db4
      .prepare('UPDATE media SET deleted_at = ? WHERE id = ?')
      .run(Date.now() - 31 * 24 * 60 * 60 * 1000, expiring.id)
    db4.close()
    const sweptList = await trashOf()
    check(
      '超过 30 天的条目打开回收站时自动彻底删除',
      !sweptList.some((m) => m.id === expiring.id),
      `left=${sweptList.length}`
    )
    check(
      '自动清理把原文件也从磁盘删掉了（独占内容）',
      !existsSync(blobFile(uniqueSha.blob_sha256)),
      uniqueSha.blob_sha256.slice(0, 12)
    )
  } else {
    check('找到独占内容的媒体记录（自动清理用例）', false, '测试库里没有独占内容')
  }

  // ---------- 界面：回收站视图 / 框选 / 查看器新交互 ----------
  const uiVictims = (await listOf(importDeviceId)).slice(0, 2)
  await postIds('/media/trash', uiVictims.map((m) => m.id))
  // ⚠️ 要等"变成 2"，不能只等"角标存在" —— 上一次删除留下的旧角标（1）会让断言提前通过
  const navBadge = await waitFor(async () => {
    const badge = await evaluate(
      `(() => { const el = document.querySelector('.nav-badge'); return el ? el.innerText.trim() : '' })()`
    )
    return String(badge) === '2' ? '2' : null
  }, 20000)
  check('侧栏回收站显示条目数角标', navBadge === '2', `badge=${navBadge}`)

  await evaluate(
    `Array.from(document.querySelectorAll('.nav-item')).find(b => b.innerText.includes('回收站')).click(); true`
  )
  const expireBadges = await waitFor(async () => {
    const text = await evaluate(
      `(() => { const el = document.querySelector('.tile-expire'); return el ? el.innerText.trim() : '' })()`
    )
    return text ? String(text) : null
  }, 15000)
  check('回收站格子右上角显示剩余天数', expireBadges.includes('剩') && expireBadges.includes('天'), expireBadges)

  // 框选：从空白处往左上拖，扫过第一行
  // ⚠️ 先把窗口提到前台：窗口被遮挡时 Chromium 不产帧、rAF 完全不触发（实测坑），
  //    框选每帧要算命中集合，被遮住就会假失败。
  await cdp('Page.bringToFront').catch(() => undefined)
  await sleep(300)
  await evaluate(`(() => {
    const grid = document.querySelector('.vgrid');
    const r = grid.getBoundingClientRect();
    const opts = (x, y) => ({ clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true, button: 0, buttons: 1 });
    grid.dispatchEvent(new MouseEvent('mousedown', opts(40, 430)));
    window.dispatchEvent(new MouseEvent('mousemove', opts(520, 40)));
    return true;
  })()`)
  const marqueeState = await waitFor(async () => {
    const raw = await evaluate(`JSON.stringify({
      box: !!document.querySelector('.marquee') && document.querySelector('.marquee').style.display !== 'none',
      selected: document.querySelectorAll('.tile.is-selected').length
    })`)
    const parsed = JSON.parse(raw)
    return parsed.box && parsed.selected > 0 ? parsed : null
  }, 10000)
  await evaluate(`window.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); true`)
  check(
    '框选（橡皮筋）选中了框内的图片',
    marqueeState.selected >= 1,
    `selected=${marqueeState.selected}`
  )

  await evaluate(
    `Array.from(document.querySelectorAll('.grid-toolbar .btn')).find(b => b.innerText.includes('恢复')).click(); true`
  )
  const trashCleared = await waitFor(async () => {
    const text = await evaluate(`document.body.innerText.replace(/\\s+/g, ' ')`)
    return text.includes('回收站是空的') ? text : null
  }, 20000)
  check('点"恢复"把选中的照片放回原处（回收站变空）', trashCleared.includes('回收站是空的'))
  const badgeGone = await evaluate(`!document.querySelector('.nav-badge')`)
  check('恢复后侧栏角标消失', badgeGone === true)

  // 查看器新交互：先测"点画面外的空白退出"
  await evaluate(`document.querySelectorAll('.nav-item')[0].click(); true`)
  await sleep(500)
  await evaluate(`document.querySelector('.tile').click(); true`)
  await waitFor(async () => ((await evaluate(`!!document.querySelector('.viewer')`)) ? 'open' : null), 10000)
  // 等图片真的解码完：空白区的位置要按 naturalWidth/Height 算
  await waitFor(async () => {
    const loaded = await evaluate(
      `(() => { const img = document.querySelector('img.viewer-media'); return !!(img && img.complete && img.naturalWidth > 0) })()`
    )
    return loaded ? 'loaded' : null
  }, 15000)
  const blankPoint = JSON.parse(
    await evaluate(`(() => {
      const stage = document.querySelector('.viewer-stage');
      const img = document.querySelector('img.viewer-media');
      const r = stage.getBoundingClientRect();
      const fit = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
      const top = (r.height - img.naturalHeight * fit) / 2;
      if (top > 16) return JSON.stringify({ x: r.left + r.width / 2, y: r.top + top / 2 });
      const left = (r.width - img.naturalWidth * fit) / 2;
      return JSON.stringify({ x: r.left + left / 2, y: r.top + r.height / 2 });
    })()`)
  )
  await evaluate(`(() => {
    const stage = document.querySelector('.viewer-stage');
    const opts = { clientX: ${blankPoint.x}, clientY: ${blankPoint.y}, bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true };
    stage.dispatchEvent(new PointerEvent('pointerdown', opts));
    stage.dispatchEvent(new PointerEvent('pointerup', opts));
    return true;
  })()`)
  const closedByBlank = await waitFor(
    async () => ((await evaluate(`!document.querySelector('.viewer')`)) ? 'closed' : null),
    8000
  )
  check('点画面外的空白处退出查看器', closedByBlank === 'closed')

  // 滚轮缩放：上滚放大（以鼠标位置为中心）
  await evaluate(`document.querySelector('.tile[data-id]').click(); true`)
  await waitFor(async () => ((await evaluate(`!!document.querySelector('.viewer')`)) ? 'open' : null), 15000)
  // ⚠️ 查看器的滚轮监听是 React 被动 effect 挂上去的，可能比紧接着的这次 CDP 调用晚一步，
  //    所以"派发一次 → 检查 → 还没生效就再派发"，不要只派发一次然后干等。
  let zoomed = 0
  for (let i = 0; i < 20 && !zoomed; i += 1) {
    await evaluate(`(() => {
      const stage = document.querySelector('.viewer-stage');
      if (stage) stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true, clientX: 400, clientY: 300 }));
      return true;
    })()`)
    await sleep(200)
    const transform = String(
      await evaluate(
        `(() => { const img = document.querySelector('img.viewer-media'); return img ? img.style.transform : '' })()`
      ) ?? ''
    )
    const scaled = Number(transform.split('scale(')[1]?.replace(')', '') ?? 0)
    if (scaled > 1) zoomed = scaled
  }
  check('查看器滚轮上滚放大（不需要按 Ctrl）', zoomed > 1, `scale=${zoomed || '没缩放'}`)

  // 滚轮**只管缩放，绝不翻页**（2026-09-24 用户明确要求：原来"缩到最小继续下滚就翻页"和缩放冲突）
  // 先把缩放退回"适应窗口"，再多滚几下，断言当前张数完全没变
  const indexBefore = await evaluate(`(document.querySelector('.viewer-title span') || {}).innerText || ''`)
  for (let i = 0; i < 25; i += 1) {
    await evaluate(`(() => {
      const stage = document.querySelector('.viewer-stage');
      stage.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true, clientX: 400, clientY: 300 }));
      return true;
    })()`)
    await sleep(60)
  }
  const indexAfter = await evaluate(`(document.querySelector('.viewer-title span') || {}).innerText || ''`)
  check('滚轮在最小档继续下滚不会换图（滚轮只负责缩放）', indexBefore === indexAfter, `${indexBefore} → ${indexAfter}`)
  const backToFit = await evaluate(
    `(() => { const img = document.querySelector('img.viewer-media'); return img ? img.style.transform : '' })()`
  )
  check('下滚能把画面缩回"适应窗口"', String(backToFit).includes('scale(1)'), String(backToFit))

  // 侧键映射（2026-09-25 用户实测后**对调过**，别再按老注释理解）：
  //   用户鼠标上"下/后侧键"= DOM button 3、"上/前侧键"= button 4。
  //   以前把"撤回上一步"挂在 3 上，他按后侧键时走的是 back() —— 没有历史记录就是**静默空操作**，
  //   所以在相册详情/查看器里都像"坏了"（2026-09-24 那次"按了没反应"也是同一个原因）。
  //   现在：button 3 = 退出当前这一层（等同 Esc）；button 4 = 沿历史撤回上一步。
  await sleep(300)
  await evaluate(`window.dispatchEvent(new MouseEvent('mouseup', { button: 3, bubbles: true })); true`)
  await waitFor(async () => ((await evaluate(`!document.querySelector('.viewer')`)) ? 'closed' : null), 8000)
  check('【下/后侧键】（button 3）直接退出查看器（等同 Esc）', true)

  // button 4 = 沿历史撤回上一步：先翻一张，再撤回，应当回到原来那张
  await evaluate(`document.querySelector('.tile[data-id]').click(); true`)
  await waitFor(async () => ((await evaluate(`!!document.querySelector('.viewer')`)) ? 'open' : null), 10000)
  await sleep(400)
  const viewerSrc = async () =>
    String(
      await evaluate(
        `(() => { const m = document.querySelector('.viewer-stage img') || document.querySelector('.viewer-stage video'); return m ? m.getAttribute('src') : '' })()`
      )
    )
  const firstSrc = await viewerSrc()
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); true`)
  await waitFor(async () => ((await viewerSrc()) !== firstSrc ? 'moved' : null), 8000)
  const secondSrc = await viewerSrc()
  await evaluate(`window.dispatchEvent(new MouseEvent('mouseup', { button: 4, bubbles: true })); true`)
  const backToFirst = await waitFor(async () => ((await viewerSrc()) === firstSrc ? 'back' : null), 8000)
  check(
    '【上/前侧键】（button 4）沿历史撤回上一步（回到上一张）',
    Boolean(backToFirst) && secondSrc !== firstSrc,
    `翻到 …${String(secondSrc).split('/').pop()} → 撤回 …${String(firstSrc).split('/').pop()}`
  )
  // 撤到底（第一张）就把查看器关掉 —— 和浏览器一致
  await evaluate(`window.dispatchEvent(new MouseEvent('mouseup', { button: 4, bubbles: true })); true`)
  const closedByBack = await waitFor(
    async () => ((await evaluate(`!document.querySelector('.viewer')`)) ? 'closed' : null),
    8000
  )
  check('撤回到底会把查看器关掉（和浏览器一致）', closedByBack === 'closed')
  // 查看器已关时，前侧键 = "前进重开"（浏览器的前进）
  await evaluate(`window.dispatchEvent(new MouseEvent('mouseup', { button: 4, bubbles: true })); true`)
  const reopened = await waitFor(
    async () => ((await evaluate(`!!document.querySelector('.viewer')`)) ? 'open' : null),
    8000
  ).catch(() => null)
  check('查看器已关时，前侧键能"前进重开"', reopened === 'open')
  // 收个干净的状态：确保查看器关着，下面的视频用例要从列表点进去
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`)
  await sleep(400)

  // 视频：点画面外的留白**不能**退出（用户实测反馈"看视频点到黑边就被踢回主界面"）。
  // 视频还有自己的全屏按钮，全屏后这套"留白几何"根本不成立，所以视频整体不参与这条规则。
  await evaluate(
    `Array.from(document.querySelectorAll('.nav-item')).find(b => b.innerText.includes('视频')).click(); true`
  )
  await sleep(600)
  const videoTiles = await evaluate(`document.querySelectorAll('.tile[data-id]').length`)
  if (videoTiles > 0) {
    await evaluate(`document.querySelector('.tile[data-id]').click(); true`)
    await waitFor(async () => ((await evaluate(`!!document.querySelector('.viewer')`)) ? 'open' : null), 10000)
    await sleep(400)
    // 往舞台的左上角点（那里对任何比例的片子都是留白区域）
    await evaluate(`(() => {
      const stage = document.querySelector('.viewer-stage');
      const r = stage.getBoundingClientRect();
      const opts = { clientX: r.left + 3, clientY: r.top + 3, bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true };
      stage.dispatchEvent(new PointerEvent('pointerdown', opts));
      stage.dispatchEvent(new PointerEvent('pointerup', opts));
      return true;
    })()`)
    await sleep(500)
    const stillOpen = await evaluate(`!!document.querySelector('.viewer')`)
    check('视频里点画面外的留白不会退出查看器', stillOpen === true)
    await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`)
    await sleep(400)
    await evaluate(`document.querySelectorAll('.nav-item')[0].click(); true`)
    await sleep(400)
  } else {
    check('视频里点画面外的留白不会退出查看器', false, '测试库里没有视频，无法验证')
  }
  // 回到"全部"并重新打开一张图 —— 下面的 Delete 键测试需要查看器是开着的
  await evaluate(`document.querySelector('.tile[data-id]').click(); true`)
  await waitFor(async () => ((await evaluate(`!!document.querySelector('.viewer')`)) ? 'open' : null), 10000)

  // Delete 键：直接移入回收站（不弹确认）
  await sleep(400) // 等查看器把键盘监听挂稳（切图会让 effect 重挂一次）
  const mediaCountBefore = await evaluate(
    `(() => { const m = /([\\d,]+) 项媒体/.exec(document.body.innerText); return m ? m[1] : '' })()`
  )
  await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); true`)
  const afterDeleteText = await waitFor(async () => {
    const text = await evaluate(`document.body.innerText.replace(/\\s+/g, ' ')`)
    const match = /([\d,]+) 项媒体/.exec(text)
    return match && match[1] !== mediaCountBefore ? match[1] : null
  }, 20000)
  check('查看器里按 Delete 直接移入回收站（列表数量随之减少）', afterDeleteText !== mediaCountBefore, `${mediaCountBefore} → ${afterDeleteText}`)
  const trashAfterKey = await trashOf()
  check('Delete 删掉的确实进了回收站', trashAfterKey.length === 1, `trash=${trashAfterKey.length}`)

  // 收尾：把这批恢复回去，别给后面的手工验证留下垃圾
  await postIds('/media/restore', trashAfterKey.map((m) => m.id))
  check('收尾：恢复后回收站清空', (await trashOf()).length === 0)

  // 拖出到资源管理器："准备"这一步（真正交给系统的原生拖放测不了 —— 它会进入系统模态循环，
  // 但把仓库里的内容寻址文件落成"带原始文件名的真实文件"这一步是可以测的）
  const dragItem = (await listOf(importDeviceId))[0]
  const dragRow = allRows.find((r) => r.id === dragItem.id)
  const dragPrep = JSON.parse(
    await evaluate(`window.gm.prepareDrag([${dragItem.id}]).then((r) => JSON.stringify(r))`)
  )
  const staged = dragPrep.files?.[0]
  check(
    '拖出前落成带原始文件名的真实文件（不是一串哈希）',
    !!staged && staged.name === dragItem.displayName && existsSync(staged.path),
    `name=${staged?.name}`
  )
  const stagedStat = staged ? await stat(staged.path) : null
  check(
    '拖出用的是硬链接（瞬间完成、不占额外空间），内容与仓库逐字节一致',
    !!stagedStat && stagedStat.nlink >= 2 && sha256FileSync(staged.path) === dragRow.blob_sha256,
    `nlink=${stagedStat?.nlink}`
  )

  // ---------- 十三、老库升级（v2 → v3）----------
  // ⚠️ 上面全程用的是全新库（SCHEMA 建表路径），**老库的 ALTER 迁移路径一次都没走到**。
  // 而用户机器上就是老库（4166 项），这条路一旦走不通，用户的应用直接起不来。
  // 所以这里专门造一个 v2 结构（media 没有 deleted_at、没有 tombstones）的库，用新版本打开它。
  console.log('')
  console.log('十三、老库升级（v2 结构 + 已有数据）')
  const oldDataDir = mkdtempSync(join(SCRATCH_DIR, 'gm-olddb-'))
  const oldSha = 'b'.repeat(64)
  const oldDbPath = join(oldDataDir, 'manifest.db')
  const oldDb = new DatabaseSync(oldDbPath)
  oldDb.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE devices (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, model TEXT, android_id TEXT,
      merged_into TEXT, last_sync_at INTEGER, created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE TABLE blobs (
      sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, mime TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    );
    CREATE TABLE media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      blob_sha256 TEXT NOT NULL REFERENCES blobs(sha256) ON DELETE RESTRICT,
      display_name TEXT NOT NULL, relative_path TEXT NOT NULL, bucket_id TEXT, bucket_name TEXT,
      kind TEXT NOT NULL DEFAULT 'image', mime TEXT, size INTEGER NOT NULL DEFAULT 0,
      width INTEGER, height INTEGER, orientation INTEGER,
      date_taken INTEGER, date_modified INTEGER, date_added INTEGER,
      is_favorite INTEGER NOT NULL DEFAULT 0, is_motion INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER, thumb_state TEXT NOT NULL DEFAULT 'none',
      deleted INTEGER NOT NULL DEFAULT 0,
      -- v2 结构：source_deleted 是当年用 ALTER 追加在末尾的，deleted_at 还没有
      source_deleted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
      UNIQUE (device_id, relative_path, display_name)
    );
    CREATE TABLE albums (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      bucket_id TEXT NOT NULL, bucket_name TEXT, relative_path TEXT,
      cover_media_id INTEGER REFERENCES media(id),
      UNIQUE (device_id, bucket_id)
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
  `)
  oldDb.prepare("INSERT INTO devices(id, name) VALUES('old-dev', '老库设备')").run()
  oldDb.prepare('INSERT INTO blobs(sha256, size, mime) VALUES(?, ?, ?)').run(oldSha, 2048, 'image/jpeg')
  oldDb
    .prepare(
      `INSERT INTO media(device_id, blob_sha256, display_name, relative_path, kind, mime, size, source_deleted)
       VALUES('old-dev', ?, 'OLD_0001.jpg', 'DCIM/Camera/', 'image', 'image/jpeg', 2048, 1)`
    )
    .run(oldSha)
  oldDb.prepare("INSERT INTO meta(key, value) VALUES('schema_version', '2')").run()
  oldDb.close()

  const oldChild = spawn(appExe, spawnArgs, {
    cwd: projectRoot,
    env: {
      ...process.env,
      GALLERY_MIRROR_DATA: oldDataDir,
      GALLERY_MIRROR_PORT: String(HUB_PORT - 1)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  oldChild.stdout.on('data', () => {})
  oldChild.stderr.on('data', () => {})
  const oldBase = `http://127.0.0.1:${HUB_PORT - 1}/api/v1`
  try {
    const oldHealth = await waitFor(async () => {
      try {
        const res = await fetch(`${oldBase}/health`)
        return res.ok ? res.json() : null
      } catch {
        return null
      }
    }, 40000)
    check('老库（v2 结构）能被新版本正常打开', oldHealth.protocolVersion === 1, `pid=${oldHealth.pid}`)

    const migrated = new DatabaseSync(oldDbPath, { readOnly: true })
    const mediaCols = migrated.prepare('PRAGMA table_info(media)').all().map((c) => c.name)
    const hasIndex = !!migrated
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_media_deleted'")
      .get()
    const hasTombstones = !!migrated
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tombstones'")
      .get()
    const oldRows = migrated.prepare('SELECT display_name, source_deleted FROM media').all()
    const oldVersion = migrated.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
    migrated.close()
    check('升级后补上了 deleted_at 列', mediaCols.includes('deleted_at'), mediaCols.join(','))
    check('升级后补上了回收站索引', hasIndex)
    check('升级后建好了墓碑表', hasTombstones)
    check(
      '升级不动老数据（1 条记录、source_deleted 保持原样）',
      oldRows.length === 1 && oldRows[0].source_deleted === 1,
      JSON.stringify(oldRows)
    )
    check('schema_version 升到 3', String(oldVersion?.value) === '3', `value=${oldVersion?.value}`)

    // 老库上的新功能也要能用：列表能读、能删进回收站、能恢复
    const oldList = (await (await fetch(`${oldBase}/media`)).json()).media
    check('老库的媒体列表照常读出（source_deleted 仍返回）', oldList.length === 1 && oldList[0].sourceDeleted === true)
    const oldId = oldList[0].id
    const oldTrashRes = await (
      await fetch(`${oldBase}/media/trash`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [oldId] })
      })
    ).json()
    const oldTrashList = (await (await fetch(`${oldBase}/trash`)).json()).media
    check(
      '老库升级后回收站可用（移入 + 列出 + 倒计时）',
      oldTrashRes.count === 1 && oldTrashList.length === 1 && oldTrashList[0].purgeAt > Date.now(),
      `trash=${oldTrashList.length}`
    )
    const oldRestoreRes = await (
      await fetch(`${oldBase}/media/restore`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: [oldId] })
      })
    ).json()
    check('老库升级后恢复可用', oldRestoreRes.count === 1 && (await (await fetch(`${oldBase}/trash`)).json()).media.length === 0)
  } finally {
    killTree(oldChild?.pid)
    await sleep(500)
    rmSync(oldDataDir, { recursive: true, force: true })
  }

  // ---------- 视频首帧缩略图 ----------
  // 真实抽帧要有"Chromium 能解码的片子"（测试库里那个 mp4 是假字节，只能人工在真库上看）。
  // 这里验证的是链路本身：渲染端编好的 webp → IPC → 主进程校验魔数 → 落盘 → 接口能取到。
  const deviceMedia = await listOf(importDeviceId)
  const thumbImage = deviceMedia.find((m) => m.kind === 'image')
  const thumbVideo = deviceMedia.find((m) => m.kind === 'video')
  if (thumbVideo && thumbImage) {
    const noThumbYet = await fetch(`${base}/thumb/${thumbVideo.id}`)
    check(
      '视频还没有首帧时缩略图接口 404（服务端绝不把视频送进 sharp）',
      noThumbYet.status === 404,
      `HTTP ${noThumbYet.status}`
    )

    // 首帧接口只收 webp（那些字节由渲染端 canvas 编出来）—— 这里现造一张真 webp 冒充"抽好的首帧"
    // ⚠️ 别再用图片缩略图的字节：图片缩略图现在是 JPEG，主进程的 RIFF/WEBP 魔数校验会直接拒收
    const sampleBytes = Array.from(
      await sharp({ create: { width: 32, height: 32, channels: 3, background: { r: 90, g: 160, b: 220 } } })
        .webp()
        .toBuffer()
    )
    const sampleLiteral = JSON.stringify(sampleBytes)
    const saved = await evaluate(
      `window.gm.saveVideoThumb(${thumbVideo.id}, new Uint8Array(${sampleLiteral}).buffer)`
    )
    check('渲染端编好的 webp 交给主进程 → 视频首帧落盘', saved === true, `saved=${saved}`)

    const videoThumbRes = await fetch(`${base}/thumb/${thumbVideo.id}`)
    check(
      '视频首帧现在能取到（image/webp）',
      videoThumbRes.status === 200 && videoThumbRes.headers.get('content-type') === 'image/webp',
      `HTTP ${videoThumbRes.status}`
    )

    const rejected = await evaluate(
      `window.gm.saveVideoThumb(${thumbVideo.id}, new Uint8Array([1,2,3,4,5,6,7,8,9,10]).buffer)`
    )
    check('非 webp 字节会被主进程拒收（不让垃圾进缩略图目录）', rejected === false)

    const wrongKind = await evaluate(
      `window.gm.saveVideoThumb(${thumbImage.id}, new Uint8Array(${sampleLiteral}).buffer)`
    )
    check('这个接口只接受视频（图片的缩略图不能被它覆盖）', wrongKind === false)

    // 界面：滚到视频那一格，它应当已经换成真正的首帧图，而不是播放占位
    await evaluate(`document.querySelectorAll('.nav-item')[0].click(); true`)
    await sleep(600)
    let videoHasImg = false
    for (let i = 0; i < 40 && !videoHasImg; i += 1) {
      videoHasImg = await evaluate(
        `(() => { const t = document.querySelector('.tile[data-id="${thumbVideo.id}"]'); return !!(t && t.querySelector('img')) })()`
      )
      if (videoHasImg) break
      await evaluate(`(() => {
        const grid = document.querySelector('.vgrid');
        if (grid) { grid.scrollTop += 520; grid.dispatchEvent(new Event('scroll')); }
        return true;
      })()`)
      await sleep(200)
    }
    check('界面上视频格子显示首帧缩略图（不再只有播放占位）', videoHasImg === true)
  } else {
    check('找到视频记录（首帧缩略图用例）', false, '测试库里没有视频')
  }

  // ---------- 十四、HEIC / BMP 缩略图（sharp 解不了的那两种，走兜底解码器）----------
  // 背景（2026-09-24）：sharp 预编译的 libvips **解不了 HEIC**（只带 AVIF/AV1、没有 HEVC 解码器，
  // 实测报 `bad seek to <文件尾+32>`），也**解不了 BMP**（没编 ImageMagick，没有 BMP 加载器，
  // 报 "Input file contains unsupported image format"）。用户库里那 3 张图因此一直显示"无法预览"。
  // 现在缩略图子进程里加了兜底：HEIC 走 libheif-js(WASM)、BMP 自己解（见 thumb-worker.ts）。
  // ⚠️ 样本用**公开的** libheif 官方 example.heic（不是用户数据），BMP 现场造。
  console.log('')
  console.log('十四、HEIC / BMP 缩略图（兜底解码器）')

  /** 造一张 BMP：bits=8（带调色板）或 24（BGR），数据倒序存（BMP 默认自下而上） */
  const makeBmp = (w, h, bits) => {
    const paletteSize = bits === 8 ? 256 * 4 : 0
    const stride = Math.ceil((w * bits) / 32) * 4
    const dataSize = stride * h
    const offset = 54 + paletteSize
    const buf = Buffer.alloc(offset + dataSize)
    buf.write('BM', 0, 'latin1')
    buf.writeUInt32LE(buf.length, 2)
    buf.writeUInt32LE(offset, 10)
    buf.writeUInt32LE(40, 14)
    buf.writeInt32LE(w, 18)
    buf.writeInt32LE(h, 22)
    buf.writeUInt16LE(1, 26)
    buf.writeUInt16LE(bits, 28)
    buf.writeUInt32LE(0, 30)
    buf.writeUInt32LE(dataSize, 34)
    buf.writeUInt32LE(bits === 8 ? 256 : 0, 46)
    if (bits === 8) {
      for (let i = 0; i < 256; i += 1) {
        const at = 54 + i * 4
        buf[at] = i // B
        buf[at + 1] = 255 - i // G
        buf[at + 2] = 120 // R
      }
    }
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const at = offset + (h - 1 - y) * stride
        if (bits === 24) {
          // 做成渐变，别让整张图同色（同色 webp 只有几十字节，断言"字节数"就没意义了）
          buf[at + x * 3] = (x * 8) & 0xff // B
          buf[at + x * 3 + 1] = (y * 8) & 0xff // G
          buf[at + x * 3 + 2] = 120 // R
        } else {
          buf[at + x] = (x * 8) & 0xff
        }
      }
    }
    return buf
  }

  writeFileSync(join(decoderDir, 'example.heic'), readFileSync(join(projectRoot, 'scripts', 'fixtures', 'example.heic')))
  writeFileSync(join(decoderDir, 'palette8.bmp'), makeBmp(32, 32, 8))
  writeFileSync(join(decoderDir, 'rgb24.bmp'), makeBmp(32, 32, 24))

  const decImport = JSON.parse(
    await evaluate(
      `window.gm.importFolder(${JSON.stringify(decoderDir)}).then((p) => JSON.stringify({ phase: p.phase, imported: p.imported, failed: p.failed }))`
    )
  )
  check(
    'HEIC / BMP 样本导入完成（1 HEIC + 2 BMP，导入器认这两个扩展名）',
    decImport.phase === 'done' && decImport.imported === 3 && decImport.failed === 0,
    JSON.stringify(decImport)
  )

  const decoderNames = ['example.heic', 'palette8.bmp', 'rgb24.bmp']
  const decoderMedia = (await (await fetch(`${base}/media`)).json()).media.filter((m) =>
    decoderNames.includes(m.displayName)
  )
  check('三个样本都进了库', decoderMedia.length === 3, decoderMedia.map((m) => m.displayName).join(','))
  check(
    'BMP 的宽高从文件头读出来了（sharp 读不了 BMP，信息栏也要有分辨率）',
    decoderMedia.some((m) => m.displayName === 'rgb24.bmp' && m.width === 32 && m.height === 32),
    decoderMedia.map((m) => `${m.displayName}:${m.width}x${m.height}`).join(' ')
  )

  const decodedReady = await waitFor(async () => {
    const list = (await (await fetch(`${base}/media`)).json()).media.filter((m) =>
      decoderNames.includes(m.displayName)
    )
    return list.length === 3 && list.every((m) => m.thumbState === 'ready') ? list : null
  }, 30000)
  check(
    'HEIC / BMP 缩略图全部生成成功（兜底解码器生效，不再是 failed）',
    !!decodedReady,
    decodedReady
      ? decodedReady.map((m) => `${m.displayName}:${m.thumbState}`).join(' ')
      : '超时（大概率停在 failed）'
  )

  if (decodedReady) {
    const webpBytes = {}
    for (const m of decodedReady) {
      const res = await fetch(`${base}/thumb/${m.id}`)
      const buf = Buffer.from(await res.arrayBuffer())
      webpBytes[m.displayName] = buf
      // 断言真正的 JPEG（FFD8FF...），而不是"字节数够大"——
      // 小图（比如 32x32）合法产物可能只有几百字节
      const isJpeg = buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
      check(
        `${m.displayName} 缩略图接口返回 JPEG`,
        res.headers.get('content-type') === 'image/jpeg' && isJpeg,
        `${buf.length} 字节`
      )
    }
    // 尺寸对不对（同时验证 HEIC 的 irot/imir 方向没被搞反）：
    // example.heic 是 1280x854 横图，按 inside 缩到 384 宽 → 384x256
    const heicMeta = await sharp(webpBytes['example.heic']).metadata()
    check(
      'HEIC 缩略图尺寸正确（1280x854 → 384x256，方向没转错）',
      heicMeta.width === 384 && heicMeta.height === 256,
      `${heicMeta.width}x${heicMeta.height}`
    )
    const bmpMeta = await sharp(webpBytes['rgb24.bmp']).metadata()
    check(
      'BMP 缩略图尺寸正确（32x32 不放大）',
      bmpMeta.width === 32 && bmpMeta.height === 32,
      `${bmpMeta.width}x${bmpMeta.height}`
    )
  } else {
    check('HEIC 缩略图尺寸正确（1280x854 → 384x256，方向没转错）', false, '上一步没生成成功')
    check('BMP 缩略图尺寸正确（32x32 不放大）', false, '上一步没生成成功')
  }

  // 一次性重置：老库里 thumb_state='failed' 的图片会被重置回 'none' 重试一次 ——
  // 用 meta 标记把门，否则"天生解不了"的图每次启动都会白试一遍。
  const smokeDb = new DatabaseSync(join(dataDir, 'manifest.db'), { readOnly: true })
  const retryFlag = smokeDb.prepare("SELECT value FROM meta WHERE key = 'thumb_retry_v1'").get()
  smokeDb.close()
  check('一次性重试标记已写入（不会每次启动反复重试）', retryFlag?.value === '1', `value=${retryFlag?.value}`)

  // ---------- 十五、导入视频的元数据（时长 / 宽高）----------
  // 背景（2026-09-24 发现）：importer.ts 原来只给图片读元数据，从文件夹导入的视频
  // 宽高/时长全是空 → 格子不显示时长、信息栏"平均码率 -"。现在按**纯字节解析 MP4 盒子**
  // 补上（src/main/hub/videoinfo.ts，**绝不解码视频**，闪退红线）。
  // 样本是这里现拼的**合成 MP4**：不需要能播放，只要盒子结构对，就够验证解析。
  console.log('')
  console.log('十五、导入视频的元数据（时长 / 宽高）')

  const box = (type, ...parts) => {
    const body = Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))))
    const head = Buffer.alloc(8)
    head.writeUInt32BE(8 + body.length, 0)
    head.write(type, 4, 'latin1')
    return Buffer.concat([head, body])
  }
  const u32 = (n) => {
    const b = Buffer.alloc(4)
    b.writeUInt32BE(n >>> 0, 0)
    return b
  }
  const u16 = (n) => {
    const b = Buffer.alloc(2)
    b.writeUInt16BE(n, 0)
    return b
  }
  const ident = [u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]

  /** 拼一个最小可解析的 MP4：mvhd(时长) + 一条 vide 轨的 tkhd(宽高) */
  const makeMp4 = ({ width, height, durationMs, moovFirst = true, fillerBytes = 0 }) => {
    const timescale = 1000
    const duration = Math.round((durationMs / 1000) * timescale)
    const ftyp = box('ftyp', Buffer.from('isom', 'latin1'), u32(0x200), Buffer.from('isomiso2avc1mp41', 'latin1'))
    const mvhd = box(
      'mvhd',
      Buffer.from([0, 0, 0, 0]), // version 0 + flags
      u32(0), u32(0), // creation / modification
      u32(timescale),
      u32(duration),
      u32(0x00010000), u16(0x0100), u16(0), // rate / volume / reserved
      u32(0), u32(0),
      ...ident,
      Buffer.alloc(24),
      u32(2) // next_track_ID
    )
    const tkhd = box(
      'tkhd',
      Buffer.from([0, 0, 0, 7]), // version 0 + flags(启用/使用中)
      u32(0), u32(0), u32(1), u32(0), // creation / modification / track_id / reserved
      u32(duration),
      u32(0), u32(0),
      u16(0), u16(0), u16(0), u16(0), // layer / alternate_group / volume / reserved
      ...ident,
      u32(width * 65536), u32(height * 65536) // 16.16 定点
    )
    const mdhd = box('mdhd', Buffer.from([0, 0, 0, 0]), u32(0), u32(0), u32(timescale), u32(duration), u16(0), u16(0))
    const hdlr = box(
      'hdlr',
      Buffer.from([0, 0, 0, 0]),
      u32(0),
      Buffer.from('vide', 'latin1'),
      Buffer.alloc(12),
      Buffer.from('VideoHandler\0', 'latin1')
    )
    const stsd = box('stsd', Buffer.from([0, 0, 0, 0]), u32(0)) // 采样条目数 0：解析器不需要它
    const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', box('stbl', stsd))))
    const moov = box('moov', mvhd, trak)
    // moov 在末尾时，塞一段 filler 当 mdat，把 moov 顶到头部窗口（256KB）之外
    const mdat = box('mdat', Buffer.alloc(fillerBytes))
    return moovFirst ? Buffer.concat([ftyp, moov, mdat]) : Buffer.concat([ftyp, mdat, moov])
  }

  writeFileSync(join(videoMetaDir, 'META_FAST_1920x1080_12s.mp4'), makeMp4({ width: 1920, height: 1080, durationMs: 12500 }))
  writeFileSync(
    join(videoMetaDir, 'META_SLOW_1080x1920_7s.mp4'),
    makeMp4({ width: 1080, height: 1920, durationMs: 7250, moovFirst: false, fillerBytes: 320 * 1024 })
  )
  writeFileSync(join(videoMetaDir, 'META_BROKEN.mp4'), Buffer.from('这不是 MP4，只是一段文字，解析器不许瞎编元数据'))

  const vmImport = JSON.parse(
    await evaluate(
      `window.gm.importFolder(${JSON.stringify(videoMetaDir)}).then((p) => JSON.stringify({ phase: p.phase, imported: p.imported, failed: p.failed }))`
    )
  )
  check('合成 MP4 样本导入完成', vmImport.phase === 'done' && vmImport.imported === 3 && vmImport.failed === 0, JSON.stringify(vmImport))

  const vmNames = ['META_FAST_1920x1080_12s.mp4', 'META_SLOW_1080x1920_7s.mp4', 'META_BROKEN.mp4']
  const vmMedia = (await (await fetch(`${base}/media?kind=video`)).json()).media.filter((m) => vmNames.includes(m.displayName))
  const byName = Object.fromEntries(vmMedia.map((m) => [m.displayName, m]))
  const fast = byName['META_FAST_1920x1080_12s.mp4']
  const slow = byName['META_SLOW_1080x1920_7s.mp4']
  const broken = byName['META_BROKEN.mp4']

  check(
    'moov 在头部的 MP4：宽高读对了',
    fast?.width === 1920 && fast?.height === 1080,
    fast ? `${fast.width}x${fast.height}` : '没进库'
  )
  check('moov 在头部的 MP4：时长读对了', fast?.durationMs === 12500, `durationMs=${fast?.durationMs}`)
  check(
    'moov 在**尾部**的 MP4（手机录的视频常见）：宽高读对了',
    slow?.width === 1080 && slow?.height === 1920,
    slow ? `${slow.width}x${slow.height}` : '没进库'
  )
  check('moov 在尾部的 MP4：时长读对了', slow?.durationMs === 7250, `durationMs=${slow?.durationMs}`)
  check(
    '不是 MP4 的文件不许瞎编元数据（宁可没有）',
    broken && !broken.durationMs && !broken.width,
    broken ? `durationMs=${broken.durationMs} width=${broken.width}` : '没进库'
  )
  // 信息栏的"平均码率"= 大小 ÷ 时长，时长有了它才有值
  const fastBytes = fast ? fast.size : 0
  check(
    '有了时长，平均码率才算得出来',
    Boolean(fast?.durationMs && fastBytes > 0),
    `${(fastBytes / 1024).toFixed(1)}KB / ${fast?.durationMs}ms`
  )

  // ---------- 十六、查看器预览图（Chromium 解不了的格式）----------
  // 背景（2026-09-24 用户实测）：打开 DNG 时"什么都没有，和没加载一样"。
  // 根因：**Chromium 解不了 DNG / HEIC / HEIF / TIFF**，查看器把原始字节交给 `<img>` 会静默失败
  // （网格里的缩略图是好的，所以只有"点开"才有问题）。
  // 修法：Hub 新增 `/preview/:id`，按需生成一张最长边 2560 的 webp 缓存下来；
  // ⚠️ `/file/:id` 必须**一个字节都不变**（手机恢复要走它，协议承诺不转码）—— 这里专门盯着这条。
  console.log('')
  console.log('十六、查看器预览图（Chromium 解不了的格式）')

  const heicRow = (await (await fetch(`${base}/media`)).json()).media.find((m) => m.displayName === 'example.heic')
  const jpegRow = (await (await fetch(`${base}/media`)).json()).media.find((m) => m.mime === 'image/jpeg')

  if (heicRow) {
    const previewRes = await waitFor(async () => {
      const res = await fetch(`${base}/preview/${heicRow.id}`)
      return res.ok ? res : null
    }, 20000)
    const previewBuf = previewRes ? Buffer.from(await previewRes.arrayBuffer()) : Buffer.alloc(0)
    check(
      'HEIC 的 /preview/:id 能出图（image/webp）',
      Boolean(previewRes) &&
        previewRes.headers.get('content-type') === 'image/webp' &&
        previewBuf.subarray(0, 4).toString('latin1') === 'RIFF',
      previewRes ? `HTTP ${previewRes.status} ${previewBuf.length} 字节` : '超时'
    )

    // 缓存落盘：同一 sha 第二次直接复用（内容寻址，不需要失效逻辑）
    // ⚠️ `/media` 列表接口**不返回** blobSha256（列表不需要它），所以 sha 要直接查库
    const shaDb = new DatabaseSync(join(dataDir, 'manifest.db'), { readOnly: true })
    const heicSha = shaDb.prepare('SELECT blob_sha256 FROM media WHERE id = ?').get(heicRow.id).blob_sha256
    shaDb.close()
    const previewFile = join(dataDir, 'thumbs', heicSha.slice(0, 2), `${heicSha}.full.webp`)
    check('预览图缓存到了磁盘（下次直接复用）', existsSync(previewFile), previewFile.replace(dataDir, '<data>'))
    const again = await fetch(`${base}/preview/${heicRow.id}`)
    check('第二次请求同一张：仍然正常返回', again.ok && Number(again.headers.get('content-length')) === previewBuf.length)

    // ⚠️ 保真守卫：/file/:id 必须还是**原始字节**（手机恢复靠它，不能变成转码后的图）
    const rawRes = await fetch(`${base}/file/${heicRow.id}`)
    const rawBuf = Buffer.from(await rawRes.arrayBuffer())
    const fixtureSha = sha256FileSync(join(projectRoot, 'scripts', 'fixtures', 'example.heic'))
    const servedSha = createHash('sha256').update(rawBuf).digest('hex')
    check(
      '/file/:id 仍然返回原始字节（预览图不能污染手机恢复）',
      rawRes.headers.get('content-type') === 'image/heic' && servedSha === fixtureSha,
      `HTTP ${rawRes.status} ${rawBuf.length} 字节 sha=${servedSha.slice(0, 12)}`
    )

    // 视频不该走这条路（Chromium 自己能播，走 /file 的 Range）
    const videoRow = (await (await fetch(`${base}/media?kind=video`)).json()).media[0]
    if (videoRow) {
      const videoPreview = await fetch(`${base}/preview/${videoRow.id}`)
      check('视频的 /preview/:id 直接 404（视频走 /file）', videoPreview.status === 404, `HTTP ${videoPreview.status}`)
    } else {
      check('视频的 /preview/:id 直接 404（视频走 /file）', false, '测试库里没有视频')
    }

    // 界面：点开这张 HEIC，画面真的要显示出来（用户看到的就是这一步）
    //
    // ⚠️ 先确保没有查看器开着：前面某些段落会留着它，那层覆盖物会挡住侧栏点击，
    // 于是视图切不过去、格子里当然找不到目标（实测偶发过 3 条假失败）。
    await closeViewerIfOpen(evaluate)
    await evaluate(`document.querySelectorAll('.nav-item')[0].click(); true`)
    await sleep(600)
    let tileFound = false
    for (let i = 0; i < 40 && !tileFound; i += 1) {
      tileFound = await evaluate(`!!document.querySelector('.tile[data-id="${heicRow.id}"]')`)
      if (tileFound) break
      await evaluate(`(() => {
        const grid = document.querySelector('.vgrid');
        if (grid) { grid.scrollTop += 520; grid.dispatchEvent(new Event('scroll')); }
        return true;
      })()`)
      await sleep(200)
    }
    if (tileFound) {
      await evaluate(`document.querySelector('.tile[data-id="${heicRow.id}"]').click(); true`)
      const shown = await waitFor(async () => {
        const state = JSON.parse(
          await evaluate(`(() => {
            const img = document.querySelector('.viewer-stage img');
            return JSON.stringify({
              has: !!img,
              src: img ? img.getAttribute('src') : '',
              loaded: img ? (img.complete && img.naturalWidth > 0) : false,
              w: img ? img.naturalWidth : 0,
              h: img ? img.naturalHeight : 0
            });
          })()`)
        )
        return state.loaded ? state : null
      }, 30000)
      check(
        '界面上点开 HEIC 能看到画面（走的是 /preview，不再是空白）',
        Boolean(shown) && String(shown.src).includes('/preview/'),
        shown ? `naturalWidth=${shown.w} src=…${String(shown.src).slice(-14)}` : '超时（画面没出来）'
      )
      check('预览图尺寸正确（1280×854 不放大）', Boolean(shown) && shown.w === 1280 && shown.h === 854, shown ? `${shown.w}x${shown.h}` : '-')
      await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`)
      await waitFor(async () => ((await evaluate(`!document.querySelector('.viewer')`)) ? 'closed' : null), 8000)
    } else {
      check('界面上点开 HEIC 能看到画面（走的是 /preview，不再是空白）', false, '没滚动到那个格子')
      check('预览图尺寸正确（1280×854 不放大）', false, '上一步没点到')
    }

    // 反过来：能直接显示的格式（JPEG）**不该**走 /preview —— 渲染端只在必要时才用它
    if (jpegRow) {
      await closeViewerIfOpen(evaluate)
      let jpegTile = false
      for (let i = 0; i < 40 && !jpegTile; i += 1) {
        jpegTile = await evaluate(`!!document.querySelector('.tile[data-id="${jpegRow.id}"]')`)
        if (jpegTile) break
        await evaluate(`(() => {
          const grid = document.querySelector('.vgrid');
          if (grid) { grid.scrollTop += 520; grid.dispatchEvent(new Event('scroll')); }
          return true;
        })()`)
        await sleep(200)
      }
      if (jpegTile) {
        await evaluate(`document.querySelector('.tile[data-id="${jpegRow.id}"]').click(); true`)
        const jpegSrc = await waitFor(async () => {
          const src = await evaluate(
            `(() => { const img = document.querySelector('.viewer-stage img'); return img ? img.getAttribute('src') : '' })()`
          )
          return src && !String(src).includes('/preview/') ? src : null
        }, 15000)
        check(
          '能直接显示的图（JPEG）不走 /preview，照旧用原文件',
          Boolean(jpegSrc) && String(jpegSrc).includes('/file/'),
          jpegSrc ? `src=…${String(jpegSrc).slice(-12)}` : '仍是 /preview 或没打开'
        )
        await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`)
        await waitFor(async () => ((await evaluate(`!document.querySelector('.viewer')`)) ? 'closed' : null), 8000)
      } else {
        check('能直接显示的图（JPEG）不走 /preview，照旧用原文件', false, '没滚动到 JPEG 格子')
      }
    }
  } else {
    check('HEIC 的 /preview/:id 能出图（image/webp）', false, '测试库里没有 example.heic')
  }

  passed = results.every((r) => r.ok)
} catch (err) {
  console.log('')
  console.log(`  [FAIL] 测试中断：${err instanceof Error ? err.message : String(err)}`)
  passed = false
} finally {
  try {
    ws?.close()
  } catch {
    /* 忽略 */
  }
  killTree(child?.pid)
  await sleep(800)

  console.log('')
  const failed = results.filter((r) => !r.ok).length
  console.log(`结果：共 ${results.length} 项，通过 ${results.length - failed}，失败 ${failed}`)

  if (passed) {
    for (const dir of [dataDir, importDir, mockDir, exportDir, decoderDir, videoMetaDir]) {
      rmSync(dir, { recursive: true, force: true })
    }
    console.log('测试目录已清理')
  } else {
    console.log('测试目录保留用于排查：')
    console.log(`  数据: ${dataDir}`)
    console.log(`  导入: ${importDir}`)
    console.log(`  模拟: ${mockDir}`)
    console.log(`  导出: ${exportDir}`)
    console.log(`  解码样本: ${decoderDir}`)
    console.log(`  视频元数据样本: ${videoMetaDir}`)
  }
}

process.exit(passed ? 0 : 1)
