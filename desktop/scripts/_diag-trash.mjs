/**
 * 临时诊断工具：回收站/查看器新交互的探针。
 * 用测试保留的数据目录启动应用，逐步打印界面状态，定位"滚轮缩放"卡在哪一步。
 * 用法：node scripts/_diag-trash.mjs <数据目录>
 */
import { spawn, spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const dataDir = process.argv[2]
if (!dataDir) throw new Error('用法：node scripts/_diag-trash.mjs <数据目录>')

const HUB_PORT = 8799
const CDP_PORT = 9224
const electronExe = join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const child = spawn(electronExe, ['.', `--remote-debugging-port=${CDP_PORT}`], {
  cwd: projectRoot,
  env: { ...process.env, GALLERY_MIRROR_DATA: dataDir, GALLERY_MIRROR_PORT: String(HUB_PORT) },
  stdio: ['ignore', 'pipe', 'pipe']
})
child.stdout.on('data', () => {})
child.stderr.on('data', () => {})

let ws = null
let msgId = 0
const pending = new Map()

const cdp = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++msgId
    pending.set(id, (msg) => (msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result)))
    ws.send(JSON.stringify({ id, method, params }))
  })

async function evaluate(expression) {
  const r = await cdp('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text)
  return r.result.value
}

try {
  let target = null
  for (let i = 0; i < 60 && !target; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      target = list.find((t) => t.type === 'page')
    } catch {
      /* 还没起来 */
    }
    if (!target) await sleep(500)
  }
  if (!target) throw new Error('连不上 CDP')

  ws = new WebSocket(target.webSocketDebuggerUrl)
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    const handler = pending.get(msg.id)
    if (handler) {
      pending.delete(msg.id)
      handler(msg)
    }
  }
  await new Promise((r) => (ws.onopen = r))

  for (let i = 0; i < 60; i += 1) {
    const text = await evaluate(`document.body ? document.body.innerText : ''`)
    if (text && text.includes('运行中')) break
    await sleep(500)
  }
  console.log('窗口标题:', await evaluate(`document.title`))
  console.log('导航项数:', await evaluate(`document.querySelectorAll('.nav-item').length`))

  await evaluate(`document.querySelectorAll('.nav-item')[0].click(); true`)
  await sleep(600)
  console.log('格子数:', await evaluate(`document.querySelectorAll('.tile:not(.tile-empty)').length`))
  console.log('第一个格子:', await evaluate(`(document.querySelector('.tile[data-id]') || {}).innerText`))

  await evaluate(`document.querySelector('.tile[data-id]').click(); true`)
  await sleep(600)
  console.log('① 点格子后查看器存在:', await evaluate(`!!document.querySelector('.viewer')`))

  // 滚轮上滚
  await evaluate(`(() => {
    const stage = document.querySelector('.viewer-stage');
    if (!stage) return false;
    stage.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true, clientX: 400, clientY: 300 }));
    return true;
  })()`)
  await sleep(400)
  console.log('② 滚轮后 transform:', await evaluate(`(document.querySelector('img.viewer-media') || {}).style?.transform || '(无)'`))

  // 滚轮下滚 5 次
  for (let i = 0; i < 5; i += 1) {
    await evaluate(`(() => {
      const stage = document.querySelector('.viewer-stage');
      if (stage) stage.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true, clientX: 400, clientY: 300 }));
      return true;
    })()`)
    await sleep(120)
  }
  console.log('③ 下滚 5 次后:', await evaluate(`(document.querySelector('.viewer-title span') || {}).innerText || '(无)'`))

  // 关掉查看器（点空白）
  const blank = await evaluate(`(() => {
    const stage = document.querySelector('.viewer-stage');
    const img = document.querySelector('img.viewer-media');
    if (!stage || !img) return '缺少元素';
    const r = stage.getBoundingClientRect();
    const fit = Math.min(r.width / img.naturalWidth, r.height / img.naturalHeight);
    const top = (r.height - img.naturalHeight * fit) / 2;
    if (top > 16) return JSON.stringify({ x: r.left + r.width / 2, y: r.top + top / 2 });
    const left = (r.width - img.naturalWidth * fit) / 2;
    return JSON.stringify({ x: r.left + left / 2, y: r.top + r.height / 2 });
  })()`)
  console.log('④ 空白点:', blank)
  const point = JSON.parse(blank)
  await evaluate(`(() => {
    const stage = document.querySelector('.viewer-stage');
    const opts = { clientX: ${point.x}, clientY: ${point.y}, bubbles: true, cancelable: true, button: 0, pointerId: 1, isPrimary: true };
    stage.dispatchEvent(new PointerEvent('pointerdown', opts));
    stage.dispatchEvent(new PointerEvent('pointerup', opts));
    return true;
  })()`)
  await sleep(500)
  console.log('⑤ 点空白后查看器存在:', await evaluate(`!!document.querySelector('.viewer')`))

  // 再点一次格子，看能不能重新打开
  console.log('⑥ 再次点格子前的状态:', await evaluate(`JSON.stringify({
    tiles: document.querySelectorAll('.tile[data-id]').length,
    selected: document.querySelectorAll('.tile.is-selected').length,
    viewer: !!document.querySelector('.viewer'),
    grid: !!document.querySelector('.vgrid')
  })`))
  await evaluate(`document.querySelector('.tile[data-id]').click(); true`)
  await sleep(800)
  console.log('⑦ 再次点格子后查看器存在:', await evaluate(`!!document.querySelector('.viewer')`))
  console.log('⑧ 若存在，img 是:', await evaluate(`(() => {
    const img = document.querySelector('img.viewer-media');
    return img ? 'IMG ' + img.naturalWidth + 'x' + img.naturalHeight : '(没有图片元素)';
  })()`))
} catch (err) {
  console.log('探针出错:', err instanceof Error ? err.message : String(err))
} finally {
  try {
    ws?.close()
  } catch {
    /* 忽略 */
  }
  if (child.pid) {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  }
}
