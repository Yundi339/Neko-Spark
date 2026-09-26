import type { JSX } from 'react'
import type { DeviceRecord } from '@shared/types'
import { formatCount } from '../utils/format'
import logo from '../assets/stickers/logo.png'
import mascotSleep from '../assets/stickers/mascot-sleep.svg'

export type ViewKey = 'timeline' | 'albums' | 'favorites' | 'videos' | 'trash' | 'devices' | 'settings'

export const ALL_DEVICES = 'all'

const NAV_ITEMS: { key: ViewKey; label: string }[] = [
  { key: 'timeline', label: '全部' },
  { key: 'albums', label: '相册' },
  { key: 'favorites', label: '收藏' },
  { key: 'videos', label: '视频' },
  { key: 'trash', label: '回收站' },
  { key: 'devices', label: '设备' },
  { key: 'settings', label: '设置' }
]

function Icon({ name }: { name: ViewKey }): JSX.Element {
  switch (name) {
    case 'timeline':
      return (
        <>
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="8.5" cy="9.5" r="1.5" />
          <path d="m4 17 5-5 4 4 3-3 4 4" />
        </>
      )
    case 'albums':
      return (
        <>
          <path d="m12 3 9 5-9 5-9-5 9-5Z" />
          <path d="m5 12-2 1 9 5 9-5-2-1" />
          <path d="m5 16-2 1 9 5 9-5-2-1" />
        </>
      )
    case 'favorites':
      return <path d="m12 4 2.5 5.2 5.5.8-4 3.9.9 5.5L12 16.7 7.1 19.4l.9-5.5-4-3.9 5.5-.8L12 4Z" />
    case 'videos':
      return (
        <>
          <rect x="3" y="5" width="14" height="14" rx="2" />
          <path d="m17 10 4-2.5v9L17 14" />
        </>
      )
    case 'trash':
      return (
        <>
          <path d="M4 6h16" />
          <path d="M9 6V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V6" />
          <path d="M6.5 6l.9 12.1A2 2 0 0 0 9.4 20h5.2a2 2 0 0 0 2-1.9L17.5 6" />
          <path d="M10.5 10v6M13.5 10v6" />
        </>
      )
    case 'devices':
      return (
        <>
          <rect x="7" y="3" width="10" height="18" rx="2" />
          <path d="M11 18h2" />
        </>
      )
    case 'settings':
      return (
        <>
          <path d="M4 7h9M19 7h1M4 17h4M14 17h6" />
          <circle cx="15" cy="7" r="2" />
          <circle cx="10" cy="17" r="2" />
        </>
      )
    default:
      return <circle cx="12" cy="12" r="8" />
  }
}

interface SidebarProps {
  active: ViewKey
  onSelect: (key: ViewKey) => void
  devices: DeviceRecord[]
  activeDeviceId: string
  onSelectDevice: (deviceId: string) => void
  mascot?: string
  /** 回收站里的条目数（导航上的小角标） */
  trashCount?: number
}

export default function Sidebar({
  active,
  onSelect,
  devices,
  activeDeviceId,
  onSelectDevice,
  mascot,
  trashCount = 0
}: SidebarProps): JSX.Element {
  const total = devices.reduce((sum, device) => sum + device.mediaCount, 0)

  // 只列主设备；副设备的媒体算进主设备，选中主设备即可一起浏览
  const primaries = devices.filter((device) => !device.mergedInto)
  const childrenOf = (id: string): DeviceRecord[] => devices.filter((device) => device.mergedInto === id)
  const groupCount = (id: string): number =>
    devices
      .filter((device) => device.id === id || device.mergedInto === id)
      .reduce((sum, device) => sum + device.mediaCount, 0)

  return (
    <aside className="sidebar">
      <div className="brand">
        <img className="brand-logo" src={logo} alt="Neko_Spark" draggable={false} />
        <div className="brand-text">
          <strong>Neko_Spark</strong>
          <span>相册镜像</span>
        </div>
      </div>

      <nav className="nav">
        {NAV_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            className={`nav-item ${active === item.key ? 'is-active' : ''}`}
            onClick={() => onSelect(item.key)}
          >
            <span className="nav-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                <Icon name={item.key} />
              </svg>
            </span>
            {item.label}
            {item.key === 'trash' && trashCount > 0 ? (
              <span className="nav-badge">{formatCount(trashCount)}</span>
            ) : null}
          </button>
        ))}
      </nav>

      <div className="device-filter">
        <div className="device-filter-head">
          <span>设备备份</span>
          <span className="device-filter-tip">分开看 / 合并看</span>
        </div>
        <div className="device-filter-list">
          <button
            type="button"
            className={`device-filter-item ${activeDeviceId === ALL_DEVICES ? 'is-active' : ''}`}
            onClick={() => onSelectDevice(ALL_DEVICES)}
          >
            <span className="device-filter-name">全部设备（合并）</span>
            <span className="device-filter-count">{formatCount(total)}</span>
          </button>
          {primaries.map((device) => {
            const children = childrenOf(device.id)
            return (
              <button
                key={device.id}
                type="button"
                className={`device-filter-item ${activeDeviceId === device.id ? 'is-active' : ''}`}
                onClick={() => onSelectDevice(device.id)}
                title={device.model ? `${device.name} · ${device.model}` : device.name}
              >
                <span className="device-filter-name">
                  {device.name}
                  {children.length > 0 ? (
                    <span className="device-filter-sub">（含 {children.length} 台副设备）</span>
                  ) : null}
                </span>
                <span className="device-filter-count">{formatCount(groupCount(device.id))}</span>
              </button>
            )
          })}
        </div>
        {devices.length === 0 ? <p className="device-filter-empty">还没有设备备份</p> : null}
      </div>

      <div className="sidebar-mascot">
        <img src={mascot || mascotSleep} alt="" aria-hidden="true" draggable={false} />
      </div>

      <div className="sidebar-foot">
        <span>v0.1.0</span>
        <span>协议 v1</span>
      </div>
    </aside>
  )
}
