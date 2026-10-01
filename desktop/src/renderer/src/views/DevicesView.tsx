import { useState, type JSX } from 'react'
import type { AppStatus, DeviceRecord, SyncProgress, TaskProgress } from '@shared/types'
import { formatCount, formatDateTime, formatSize } from '../utils/format'
import mascotHappy from '../assets/stickers/mascot-happy.svg'
import PairingCard from '../components/PairingCard'

const MILESTONES = [
  { id: 'M1', label: '项目骨架 / 本地服务 / 数据库 / 存储目录', state: 'done' },
  { id: 'M2', label: '导入管线：扫描文件夹 → 哈希 → 去重入库 → 缩略图', state: 'done' },
  { id: 'M3', label: 'Hub 协议 v1：清单比对 / 分块上传 / 断点续传', state: 'done' },
  { id: 'M4', label: '相册界面：时间线 / 相册 / 查看器', state: 'done' },
  { id: 'M5', label: '设置页 + 打包 exe（默认装 D 盘、数据放程序旁）', state: 'done' },
  { id: 'M6', label: '导出文件夹树（逐字节一致 + 保留时间）', state: 'done' },
  { id: 'M7', label: '多设备区分浏览 / 可逆合并（主副设备）', state: 'done' },
  { id: 'M8', label: '安卓端基础版：扫描 + 协议 v1 备份 + 蓝白 UI', state: 'done' },
  { id: 'M9', label: '手机已删除标记 / 设备身份认领 / 导入到指定设备', state: 'done' },
  { id: 'M10', label: '安卓端完善：后台自动备份、相册恢复', state: 'next' }
]

const STATE_TEXT: Record<string, string> = {
  done: '已完成',
  next: '进行中',
  todo: '计划中'
}

function ProgressPanel({ progress }: { progress: TaskProgress }): JSX.Element {
  const percent = progress.total > 0 ? Math.round((progress.processed / progress.total) * 100) : 0
  const title = progress.type === 'import' ? '正在导入' : '正在导出'
  const phaseText =
    progress.phase === 'scanning'
      ? '扫描文件...'
      : progress.phase === 'done'
        ? '已完成'
        : progress.phase === 'error'
          ? `出错：${progress.error ?? '未知错误'}`
          : progress.current || '处理中...'

  return (
    <section className="card span-2">
      <div className="card-head">
        <h2>{progress.phase === 'done' ? '任务完成' : title}</h2>
        <span className="muted">{progress.rootPath}</span>
      </div>
      <div className="progress-track">
        <div className="progress-fill" style={{ width: `${Math.min(100, percent)}%` }} />
      </div>
      <div className="progress-meta">
        <span>{percent}%</span>
        <span className="progress-current">{phaseText}</span>
        <span>
          导入 {formatCount(progress.imported)} · 跳过 {formatCount(progress.skipped)} · 失败{' '}
          {formatCount(progress.failed)}
        </span>
      </div>
    </section>
  )
}

interface DevicesViewProps {
  status: AppStatus | null
  devices: DeviceRecord[]
  progress: TaskProgress | null
  syncProgress?: SyncProgress | null
  sticker?: string
  sourceDeletedCount?: number
  onImport: (deviceId?: string) => void
  onExportAll: () => void
  onExportDevice: (deviceId: string) => void
  onMerge: (sourceDeviceId: string, targetDeviceId: string) => void
  onSplit: (deviceId: string) => void
  onRename: (deviceId: string, name: string) => void
  onOpenDataDir: () => void
}

type PanelType = 'merge' | 'rename' | 'import'

export default function DevicesView({
  status,
  devices,
  progress,
  syncProgress,
  sticker,
  sourceDeletedCount = 0,
  onImport,
  onExportAll,
  onExportDevice,
  onMerge,
  onSplit,
  onRename,
  onOpenDataDir
}: DevicesViewProps): JSX.Element {
  const counts = status?.counts
  const running = progress && progress.phase !== 'done' && progress.phase !== 'error'

  const [panelType, setPanelType] = useState<PanelType>('merge')
  const [panelDevice, setPanelDevice] = useState('')
  const [mergeTarget, setMergeTarget] = useState('')
  const [renameValue, setRenameValue] = useState('')
  const [importTarget, setImportTarget] = useState('')

  const closePanel = (): void => {
    setPanelDevice('')
    setMergeTarget('')
  }

  const primaries = devices.filter((device) => !device.mergedInto)
  const childrenOf = (id: string): DeviceRecord[] => devices.filter((device) => device.mergedInto === id)

  const renderPanel = (device: DeviceRecord): JSX.Element | null => {
    if (panelDevice !== device.id) return null
    if (panelType === 'rename') {
      return (
        <div className="merge-panel">
          <p>修改这台手机在电脑上的显示名（手机端也可以自己改）：</p>
          <input
            className="merge-select"
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
          />
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!renameValue.trim()}
              onClick={() => {
                onRename(device.id, renameValue.trim())
                closePanel()
              }}
            >
              保存
            </button>
            <button type="button" className="btn" onClick={closePanel}>
              取消
            </button>
          </div>
        </div>
      )
    }
    if (panelType === 'merge') {
      const options = devices.filter((item) => item.id !== device.id)
      return (
        <div className="merge-panel">
          <p>
            把「{device.name}」作为<strong>副设备</strong>，合并到主设备：
          </p>
          <select
            className="merge-select"
            value={mergeTarget}
            onChange={(event) => setMergeTarget(event.target.value)}
          >
            <option value="">选择主设备…</option>
            {options.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}（{formatCount(item.mediaCount)} 项{item.mergedInto ? '，当前为副设备' : ''}）
              </option>
            ))}
          </select>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!mergeTarget}
              onClick={() => {
                onMerge(device.id, mergeTarget)
                closePanel()
              }}
            >
              合并
            </button>
            <button type="button" className="btn" onClick={closePanel}>
              取消
            </button>
          </div>
          <p className="hint">
            合并<strong>不会移动或删除任何文件</strong>：照片仍然带着原来那台手机的标签，
            浏览主设备时会一起显示。随时可以点「分离」拆开，互不影响。
          </p>
        </div>
      )
    }
    return null
  }

  return (
    <div className="grid devices-grid">
      <PairingCard status={status} />
      <section className="card span-2">
        <div className="card-head">
          <h2>媒体库</h2>
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!!running}
              onClick={() => {
                setPanelType('import')
                setPanelDevice('__import__')
                setImportTarget('')
              }}
            >
              导入文件夹
            </button>
            <button type="button" className="btn" onClick={onExportAll} disabled={!!running}>
              导出全部
            </button>
            <button type="button" className="btn" onClick={onOpenDataDir}>
              打开仓库
            </button>
          </div>
        </div>

        {panelDevice === '__import__' ? (
          <div className="merge-panel">
            <p>选择导入目标（导入到主设备或副设备都可以，照片会带上该设备的标签）：</p>
            <select
              className="merge-select"
              value={importTarget}
              onChange={(event) => setImportTarget(event.target.value)}
            >
              <option value="">＋ 新建设备（用文件夹名）</option>
              {devices.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}（{formatCount(item.mediaCount)} 项{item.mergedInto ? '，副设备' : ''}）
                </option>
              ))}
            </select>
            <div className="btn-row">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  onImport(importTarget || undefined)
                  closePanel()
                }}
              >
                选择文件夹并导入
              </button>
              <button type="button" className="btn" onClick={closePanel}>
                取消
              </button>
            </div>
          </div>
        ) : null}

        <div className="stats">
          <div className="stat">
            <span className="stat-num">{formatCount(counts?.media ?? 0)}</span>
            <span className="stat-label">媒体文件</span>
          </div>
          <div className="stat">
            <span className="stat-num">{formatCount(counts?.blobs ?? 0)}</span>
            <span className="stat-label">去重后文件</span>
          </div>
          <div className="stat">
            <span className="stat-num">{formatCount(counts?.albums ?? 0)}</span>
            <span className="stat-label">相册</span>
          </div>
          <div className="stat">
            <span className="stat-num">{formatCount(counts?.devices ?? 0)}</span>
            <span className="stat-label">设备</span>
          </div>
          <div className="stat">
            <span className="stat-num">{formatCount(sourceDeletedCount)}</span>
            <span className="stat-label">手机已删除（电脑保留）</span>
          </div>
        </div>
        <p className="hint" style={{ marginTop: 12 }}>
          每台手机的备份单独记录为设备；可以把一台挂到另一台下面作为<strong>副设备</strong>（主副可随时互换归属、随时分离）。
          浏览、导出时会按来源设备区分，照片标签不会被改掉。
        </p>
      </section>

      {progress ? <ProgressPanel progress={progress} /> : null}

      {syncProgress ? (
        <section className="card span-2">
          <div className="card-head">
            <h2>
              {syncProgress.done
                ? '手机同步完成'
                : syncProgress.phase === 'preparing'
                  ? '手机正在准备'
                  : '手机正在上传'}
            </h2>
            <span className="muted">{syncProgress.deviceName}</span>
          </div>
          <div className="progress-track">
            <div
              className="progress-fill"
              style={{
                width: `${(() => {
                  if (syncProgress.done) return 100
                  if (syncProgress.phase === 'preparing') {
                    const total = syncProgress.prepareTotalBytes ?? 0
                    return total > 0
                      ? Math.min(100, Math.round(((syncProgress.hashedBytes ?? 0) / total) * 100))
                      : 100
                  }
                  const doneBytes = syncProgress.bytes + (syncProgress.currentBytes ?? 0)
                  if (syncProgress.neededBytes > 0) {
                    return Math.min(100, Math.round((doneBytes / syncProgress.neededBytes) * 100))
                  }
                  if (syncProgress.needed > 0) {
                    return Math.min(100, Math.round((syncProgress.received / syncProgress.needed) * 100))
                  }
                  return 0
                })()}%`
              }}
            />
          </div>
          <div className="progress-meta">
            <span>
              {syncProgress.phase === 'preparing'
                ? syncProgress.prepareTotal
                  ? `已算指纹 ${syncProgress.hashed ?? 0} / ${syncProgress.prepareTotal} 个文件`
                  : '正在扫描相册…'
                : syncProgress.needed > 0
                  ? `${syncProgress.received} / ${syncProgress.needed} 个文件`
                  : '没有新文件需要上传（全部已备份）'}
            </span>
            <span className="progress-current">
              {syncProgress.done
                ? '已提交入库'
                : syncProgress.phase === 'preparing'
                  ? '手机在扫描相册、计算文件指纹，此阶段还没开始传输'
                  : '传输中，请保持手机与电脑连接'}
            </span>
            <span>
              {syncProgress.phase === 'preparing'
                ? syncProgress.prepareTotalBytes
                  ? `已读取 ${formatSize(syncProgress.hashedBytes ?? 0)} / ${formatSize(syncProgress.prepareTotalBytes)}`
                  : '请保持手机与电脑连接'
                : `已接收 ${formatSize(syncProgress.bytes + (syncProgress.currentBytes ?? 0))}${
                    syncProgress.neededBytes > 0 ? ` / ${formatSize(syncProgress.neededBytes)}` : ''
                  }`}
            </span>
          </div>
        </section>
      ) : null}

      <section className="card span-2">
        <div className="card-head">
          <h2>设备</h2>
          <span className="muted">合并可逆：媒体保留原始设备标签，分离后各归各位</span>
        </div>

        {devices.length === 0 ? (
          <div className="empty-inline">
            <img src={sticker || mascotHappy} alt="" aria-hidden="true" draggable={false} />
            <p className="muted">还没有设备记录。点击"导入文件夹"或从手机同步后会出现。</p>
          </div>
        ) : (
          <ul className="device-list">
            {primaries.map((device) => {
              const children = childrenOf(device.id)
              return (
                <li key={device.id} className="device-item">
                  <div className="device-row">
                    <div className="device-main">
                      <strong>
                        <span className="device-role is-primary">主设备</span>
                        {device.name}
                      </strong>
                      <span className="muted">
                        {formatCount(device.mediaCount)} 项 · 最近同步 {formatDateTime(device.lastSyncAt)}
                        {device.model ? ` · ${device.model}` : ''}
                        {children.length > 0 ? ` · 含 ${children.length} 台副设备` : ''}
                      </span>
                    </div>
                    <div className="btn-row">
                      <button type="button" className="btn" onClick={() => onExportDevice(device.id)} disabled={!!running}>
                        导出此设备
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={!!running}
                        onClick={() => {
                          setPanelType('rename')
                          setPanelDevice(device.id)
                          setRenameValue(device.name)
                        }}
                      >
                        重命名
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={!!running || devices.length < 2}
                        onClick={() => {
                          setPanelType('merge')
                          setPanelDevice(device.id)
                          setMergeTarget('')
                        }}
                      >
                        合并为副设备…
                      </button>
                      {children.length > 0 ? (
                        <button type="button" className="btn" disabled={!!running} onClick={() => onSplit(device.id)}>
                          全部分离
                        </button>
                      ) : null}
                    </div>
                  </div>
                  {renderPanel(device)}

                  {children.map((child) => (
                    <div key={child.id} className="device-sub">
                      <div className="device-row">
                        <div className="device-main">
                          <strong>
                            <span className="device-role is-secondary">副设备</span>
                            {child.name}
                          </strong>
                          <span className="muted">
                            {formatCount(child.mediaCount)} 项 · 最近同步 {formatDateTime(child.lastSyncAt)}
                            {child.model ? ` · ${child.model}` : ''}
                          </span>
                        </div>
                        <div className="btn-row">
                          <button
                            type="button"
                            className="btn"
                            onClick={() => onExportDevice(child.id)}
                            disabled={!!running}
                          >
                            导出此设备
                          </button>
                          <button
                            type="button"
                            className="btn"
                            disabled={!!running}
                            onClick={() => {
                              setPanelType('rename')
                              setPanelDevice(child.id)
                              setRenameValue(child.name)
                            }}
                          >
                            重命名
                          </button>
                          <button type="button" className="btn" disabled={!!running} onClick={() => onSplit(child.id)}>
                            分离
                          </button>
                        </div>
                      </div>
                      {renderPanel(child)}
                    </div>
                  ))}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <section className="card">
        <h2>本地服务</h2>
        <div className="rows">
          <div className="row">
            <span className="row-label">端口</span>
            <span className="row-value">{status?.hub.port || '-'}</span>
          </div>
          <div className="row column">
            <span className="row-label">局域网地址</span>
            <span className="row-value">
              {status?.hub.addresses.length ? (
                status.hub.addresses.map((address) => (
                  <code key={address} className="code-inline">
                    {address}
                  </code>
                ))
              ) : (
                <span className="muted">未检测到（检查是否连接 WiFi）</span>
              )}
            </span>
          </div>
          <div className="row column">
            <span className="row-label">USB 方式</span>
            <code className="code-inline">
              adb forward tcp:{status?.hub.port || 8787} tcp:{status?.hub.port || 8787}
            </code>
          </div>
        </div>
      </section>

      <section className="card">
        <h2>开发进度</h2>
        <ul className="milestones">
          {MILESTONES.map((milestone) => (
            <li key={milestone.id} className={`milestone is-${milestone.state}`}>
              <span className="milestone-id">{milestone.id}</span>
              <span className="milestone-label">{milestone.label}</span>
              <span className="milestone-state">{STATE_TEXT[milestone.state]}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
