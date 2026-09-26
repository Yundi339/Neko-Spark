/**
 * 性能体检：一次跑出"该不该换语言"和"手感差在哪"两组数据。
 *
 * 用法：
 *   node scripts/_perf.mjs gen   <照片目录> [张数]     # 生成测试图片
 *   node scripts/_perf.mjs run   <hubPort> <cdpPort> <照片目录>   # 跑体检
 *
 * 关键指标：
 *   avgCores = 进程总 CPU 秒 / 墙钟秒
 *     ≈1   → 只有一个核在干活，是**串行**问题（改并发即可，不用换语言）
 *     ≈N   → N 个核都跑满了，才谈得上语言层面优化
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { cpus } from 'node:os'
import { join, resolve } from 'node:path'
import sharp from 'sharp'

const mode = process.argv[2] ?? 'run'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const CORES = cpus().length

// ---------------- 生成测试图片 ----------------
async function generate(dir, count) {
  mkdirSync(dir, { recursive: true })
  const existing = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.jpg')).length : 0
  if (existing >= count) {
    console.log(`已存在 ${existing} 张，跳过生成`)
    return
  }
  console.log(`生成 ${count} 张测试图（约 2400x1800，内容高熵以便接近真实照片体积）...`)
  const t0 = Date.now()
  let bytes = 0
  for (let i = existing; i < count; i += 1) {
    const buf = await sharp({
      create: {
        width: 2400,
        height: 1800,
        channels: 3,
        noise: { type: 'gaussian', mean: 128, sigma: 70 }
      }
    })
      .jpeg({ quality: 88 })
      .toBuffer()
    writeFileSync(join(dir, `P_${String(i).padStart(5, '0')}.jpg`), buf)
    bytes += buf.length
    if (i % 100 === 0 && i > existing) {
      console.log(`  ${i}/${count}  ${(bytes / 1024 / 1024).toFixed(0)} MB  ${((Date.now() - t0) / 1000).toFixed(0)}s`)
    }
  }
  console.log(`完成：${count} 张，共 ${(bytes / 1024 / 1024).toFixed(0)} MB，用时 ${((Date.now() - t0) / 1000).toFixed(0)}s`)
}

// ---------------- CDP ----------------
let ws = null
let msgId = 0
const pending = new Map()

function cpuSeconds() {
  const out = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "(Get-Process electron -ErrorAction SilentlyContinue | Measure-Object CPU -Sum).Sum"
    ],
    { encoding: 'utf8' }
  )
  return Number(String(out.stdout).trim()) || 0
}

async function connect(hubPort, cdpPort) {
  const deadline = Date.now() + 30000
  let target = null
  while (Date.now() < deadline && !target) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()
      const page = list.find((t) => t.type === 'page')
      if (page) {
        if (!String(page.title).includes('相册镜像')) {
          throw new Error(`端口 ${cdpPort} 上是「${page.title}」不是相册镜像`)
        }
        target = page
      }
    } catch (err) {
      if (String(err.message).includes('不是相册镜像')) throw err
    }
    if (!target) await sleep(500)
  }
  if (!target) throw new Error('找不到 CDP page target')
  ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('CDP 超时')), 10000)
    ws.onopen = () => {
      clearTimeout(t)
      res()
    }
    ws.onerror = () => rej(new Error('CDP 连接失败'))
  })
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data)
    const h = pending.get(m.id)
    if (h) {
      pending.delete(m.id)
      h(m)
    }
  }
}

function ev(expr, timeoutMs = 600000) {
  const id = ++msgId
  return new Promise((res, rej) => {
    const t = setTimeout(() => {
      pending.delete(id)
      rej(new Error('evaluate 超时'))
    }, timeoutMs)
    pending.set(id, (m) => {
      clearTimeout(t)
      if (m.error) rej(new Error(JSON.stringify(m.error)))
      else res(m.result?.result?.value)
    })
    ws.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression: expr, returnByValue: true, awaitPromise: true }
      })
    )
  })
}

// ---------------- 体检 ----------------
async function run(hubPort, cdpPort, photoDir) {
  const HUB = `http://127.0.0.1:${hubPort}/api/v1`
  await connect(hubPort, cdpPort)
  console.log(`已连接（窗口标题校验通过）  机器 ${CORES} 核\n`)

  const before = await (await fetch(`${HUB}/info`)).json()
  console.log(`导入前媒体数 = ${before.counts.media}`)

  // ---- 阶段一：吞吐体检 ----
  console.log('\n========== 阶段一：导入吞吐 ==========')
  const cpu0 = cpuSeconds()
  const t0 = Date.now()
  let cpuSamples = []
  const sampler = setInterval(() => {
    cpuSamples.push({ t: Date.now() - t0, cpu: cpuSeconds() - cpu0 })
  }, 2000)

  // 先挂上进度订阅，记录"文件阶段 / 缩略图阶段"各自花了多久
  await ev(`(() => {
    window.__phases = []
    window.__phT0 = performance.now()
    window.__lastCur = ''
    window.__lastThumb = false
    if (!window.__phHooked) {
      window.__phHooked = true
      window.gm.onProgress((p) => {
        const cur = String(p.current || '')
        const isThumb = cur.startsWith('生成缩略图')
        if (isThumb !== window.__lastThumb) {
          window.__lastThumb = isThumb
          window.__phases.push({ at: Math.round(performance.now() - window.__phT0), phase: isThumb ? 'thumb-start' : 'file-end' })
        }
      })
    }
    return true
  })()`)

  const result = JSON.parse(
    String(
      await ev(
        `window.gm.importFolder(${JSON.stringify(photoDir)}).then((p) => JSON.stringify({ phase: p.phase, total: p.total, imported: p.imported, failed: p.failed, bytes: p.bytes }))`
      )
    )
  )
  const phases = JSON.parse(String(await ev(`JSON.stringify(window.__phases || [])`)))
  const wall = (Date.now() - t0) / 1000
  clearInterval(sampler)
  const cpuTotal = cpuSeconds() - cpu0

  const after = await (await fetch(`${HUB}/info`)).json()
  const newMedia = after.counts.media - before.counts.media
  // 用实际落盘的 blob 体积算吞吐更准
  const blobsBytes = await ev(`(async () => 'skip')()`).catch(() => null)

  console.log(`导入结果：${JSON.stringify(result)}`)
  console.log(`墙钟耗时  : ${wall.toFixed(1)} 秒`)
  console.log(`新增媒体  : ${newMedia} 项`)
  console.log(`CPU 总耗时: ${cpuTotal.toFixed(1)} 核·秒`)
  const avgCores = cpuTotal / wall
  console.log(`平均占用  : ${avgCores.toFixed(2)} 核 / ${CORES} 核  （${((avgCores / CORES) * 100).toFixed(0)}%）`)
  console.log(`吞吐      : ${(newMedia / wall).toFixed(1)} 文件/秒`)
  if (result.bytes) {
    console.log(`字节吞吐  : ${(result.bytes / 1024 / 1024 / wall).toFixed(1)} MB/秒   （共 ${(result.bytes / 1024 / 1024).toFixed(0)} MB）`)
  }

  const verdict =
    avgCores < CORES * 0.35
      ? '⚠️ 只用了不到三分之一的核心 → 瓶颈是【串行结构】，改并发就能榨干，不需要换语言'
      : avgCores > CORES * 0.8
        ? '🔥 核心基本跑满 → 这才是真·CPU 瓶颈，值得讨论语言/算法'
        : '介于两者之间：部分并行，仍有提升空间'
  console.log(`判定      : ${verdict}`)

  if (phases.length) {
    console.log('\n  阶段耗时（从导入开始计时）:')
    for (const p of phases) {
      console.log(`    +${(p.at / 1000).toFixed(1)}s  ${p.phase === 'thumb-start' ? '文件阶段结束，开始生成缩略图' : '缩略图阶段结束'}`)
    }
    const thumbStart = phases.find((p) => p.phase === 'thumb-start')
    if (thumbStart) {
      console.log(`    → 文件阶段 ≈ ${(thumbStart.at / 1000).toFixed(1)}s，缩略图阶段 ≈ ${(wall - thumbStart.at / 1000).toFixed(1)}s`)
    }
  }

  console.log('\n  CPU 采样曲线（核·秒 累计 / 墙钟秒）:')
  for (const s of cpuSamples) {
    const c = s.cpu / (s.t / 1000 || 1)
    console.log(`    +${(s.t / 1000).toFixed(0)}s  ${s.cpu.toFixed(0)} 核·秒  瞬时≈${c.toFixed(1)} 核`)
  }

  // ---- 阶段二：流畅度体检 ----
  console.log('\n========== 阶段二：界面流畅度 ==========')
  await sleep(2500)

  // 长任务
  await ev(`(() => {
    window.__long = []
    if (!window.__ltHooked) {
      window.__ltHooked = true
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) window.__long.push(Math.round(e.duration))
        }).observe({ entryTypes: ['longtask'] })
      } catch (e) {}
    }
    return true
  })()`)

  // 滚动帧率
  await ev(`(() => {
    const grid = document.querySelector('.vgrid')
    if (!grid) return false
    grid.scrollTop = 0
    window.__fr = { deltas: [], on: true }
    let last = performance.now()
    const tick = (t) => { window.__fr.deltas.push(t - last); last = t; if (window.__fr.on) requestAnimationFrame(tick) }
    requestAnimationFrame(tick)
    let y = 0
    const step = () => {
      if (!window.__fr.on) return
      y += 34
      if (y > grid.scrollHeight - grid.clientHeight) y = 0
      grid.scrollTop = y
      grid.dispatchEvent(new Event('scroll'))
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
    return true
  })()`)
  await sleep(6000)
  await ev(`(() => { window.__fr.on = false; return true })()`)

  const fps = JSON.parse(String(await ev(`(() => {
    const d = window.__fr ? window.__fr.deltas.slice(2) : []
    if (!d.length) return JSON.stringify({ n: 0 })
    const sorted = [...d].sort((a, b) => a - b)
    const avg = d.reduce((s, x) => s + x, 0) / d.length
    return JSON.stringify({
      n: d.length,
      avgMs: +avg.toFixed(1),
      fps: +(1000 / avg).toFixed(1),
      p95Ms: +sorted[Math.floor(sorted.length * 0.95)].toFixed(1),
      worstMs: +sorted[sorted.length - 1].toFixed(1),
      over33: d.filter((x) => x > 33).length
    })
  })()`)))
  console.log(`滚动帧率  : ${fps.fps} FPS（平均帧 ${fps.avgMs}ms，共 ${fps.n} 帧）`)
  console.log(`卡顿帧    : 95分位 ${fps.p95Ms}ms，最差 ${fps.worstMs}ms，超过 33ms 的 ${fps.over33} 帧`)

  // 点击→出图延迟
  const clickLatency = JSON.parse(String(await ev(`(async () => {
    const tile = document.querySelector('.tile:not(.tile-empty)')
    if (!tile) return JSON.stringify({ err: '没有格子' })
    const t0 = performance.now()
    tile.click()
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      const img = document.querySelector('.viewer img')
      if (img && img.complete && img.naturalWidth > 0) {
        return JSON.stringify({ ms: +(performance.now() - t0).toFixed(0) })
      }
      await new Promise((r) => setTimeout(r, 16))
    }
    return JSON.stringify({ err: '超时' })
  })()`)))
  console.log(`点击→出图 : ${clickLatency.ms ? clickLatency.ms + ' ms' : '（' + clickLatency.err + '）'}`)
  await ev(`(() => { const b = document.querySelector('.viewer-close'); if (b) b.click(); return true })()`)

  const longTasks = await ev(`JSON.stringify(window.__long || [])`)
  console.log(`长任务    : ${longTasks}`)
}

const args = process.argv.slice(2)
if (mode === 'gen') {
  await generate(args[1] ?? join(resolve(import.meta.dirname, '..'), '.cache', 'testdata', 'perf-photos'), Number(args[2] ?? 800))
} else {
  await run(Number(args[1] ?? 8812), Number(args[2] ?? 9333), args[3] ?? join(resolve(import.meta.dirname, '..'), '.cache', 'testdata', 'perf-photos'))
}
