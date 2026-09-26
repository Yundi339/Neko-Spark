import { useState, type JSX } from 'react'
import type { AppStatus } from '@shared/types'
import mascotStar from '../assets/stickers/mascot-star.svg'

interface SettingsViewProps {
  status: AppStatus | null
  sticker?: string
  stickerCount?: number
  showDeleted?: boolean
  onToggleDeleted?: (value: boolean) => void
}

export default function SettingsView({
  status,
  sticker,
  stickerCount = 0,
  showDeleted = true,
  onToggleDeleted
}: SettingsViewProps): JSX.Element {
  const [pendingDir, setPendingDir] = useState('')

  const openDir = (): void => {
    void window.gm.openDataDir()
  }

  const openStickers = (): void => {
    void window.gm.openStickersDir()
  }

  const chooseDir = async (): Promise<void> => {
    const result = await window.gm.chooseDataDir()
    if (result.changed) setPendingDir(result.dataDir)
  }

  const restart = (): void => {
    void window.gm.restartApp()
  }

  return (
    <div className="grid">
      {pendingDir ? (
        <section className="card span-2 banner">
          <div>
            <strong>仓库位置已修改</strong>
            <p>
              新位置：<code className="code-inline">{pendingDir}</code>，重启应用后生效。
              旧目录中的数据仍保留在原处，可手动移动或删除。
            </p>
          </div>
          <button type="button" className="btn btn-primary" onClick={restart}>
            立即重启
          </button>
        </section>
      ) : null}

      <section className="card span-2">
        <div className="card-head">
          <h2>存储位置</h2>
          <div className="btn-row">
            <button type="button" className="btn" onClick={openDir}>
              打开目录
            </button>
            <button type="button" className="btn" onClick={() => void chooseDir()}>
              更改位置
            </button>
          </div>
        </div>
        <div className="rows">
          <div className="row column">
            <span className="row-label">仓库目录</span>
            <code className="code-block">{status?.dataDir || '初始化中...'}</code>
          </div>
          <div className="row column">
            <span className="row-label">目录内容</span>
            <span className="hint">
              <code className="code-inline">manifest.db</code> 元数据库 ·{' '}
              <code className="code-inline">blobs</code> 原始文件（按哈希去重） ·{' '}
              <code className="code-inline">thumbs</code> 缩略图缓存 ·{' '}
              <code className="code-inline">mirror</code> 与手机一致的文件夹树
            </span>
          </div>
          <div className="row column">
            <span className="row-label">默认策略</span>
            <span className="hint">
              默认放在程序目录的<strong>同级</strong>（例如装到 <code className="code-inline">D:\GalleryMirror</code>，
              数据在 <code className="code-inline">D:\GalleryMirrorData</code>）：既不占 C 盘，
              <strong>卸载或升级程序时也不会删除你的备份数据</strong>。修改后需重启生效。
            </span>
          </div>
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>贴图</h2>
          <button type="button" className="btn" onClick={openStickers}>
            打开贴图文件夹
          </button>
        </div>
        <div className="sticker-preview">
          {sticker ? <img src={sticker} alt="" aria-hidden="true" draggable={false} /> : null}
          <span>
            {stickerCount > 0 ? `正在使用 ${stickerCount} 张本地贴图` : '当前使用内置吉祥物'}
          </span>
        </div>
        <div className="rows">
          <div className="row column">
            <span className="row-label">贴图目录</span>
            <code className="code-block">{status?.stickersDir || '初始化中...'}</code>
          </div>
          <div className="row column">
            <span className="row-label">说明</span>
              <span className="hint">
                把图片（<code className="code-inline">png</code> / <code className="code-inline">jpg</code> /{' '}
                <code className="code-inline">webp</code> / <code className="code-inline">gif</code>）放进这个文件夹，
                界面会自动使用它们（<code className="code-inline">01</code> 固定给侧栏，其余每次启动轮换展示）。
                重启应用或重新进入本页生效。该目录在数据仓库里，不会被安装/卸载影响。
              </span>
          </div>
        </div>
      </section>

      <section className="card">
        <h2>显示</h2>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={showDeleted}
            onChange={(event) => onToggleDeleted?.(event.target.checked)}
          />
          <span>
            显示已删除的文件
            <small>
              手机上把照片删掉后，电脑<strong>不会删除</strong>备份，只在缩略图右上角标记"已删除"，
              避免误删丢数据。关掉这个开关就只在电脑上隐藏它们。
            </small>
          </span>
        </label>
      </section>

      <section className="card">
        <h2>运行时缓存</h2>
        <div className="rows">
          <div className="row column">
            <span className="row-label">缓存目录</span>
            <code className="code-block">{status?.runtimeDir || '初始化中...'}</code>
          </div>
          <div className="row column">
            <span className="row-label">说明</span>
            <span className="hint">
              界面渲染缓存、崩溃转储等都放在仓库目录内，不会写入 C 盘用户目录。
            </span>
          </div>
        </div>
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
                status.hub.addresses.map((addr) => (
                  <code key={addr} className="code-inline">
                    {addr}
                  </code>
                ))
              ) : (
                <span className="muted">未检测到</span>
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
        <h2>关于</h2>
        <div className="rows">
          <div className="row">
            <span className="row-label">应用</span>
            <span className="row-value">{status?.appName || 'Neko_Spark'}</span>
          </div>
          <div className="row">
            <span className="row-label">版本</span>
            <span className="row-value">{status?.appVersion || '-'}</span>
          </div>
          <div className="row">
            <span className="row-label">协议</span>
            <span className="row-value">v{status?.protocolVersion ?? 1}</span>
          </div>
        </div>
        <div className="about-mascot">
          <img src={sticker || mascotStar} alt="" aria-hidden="true" draggable={false} />
          <span>祝你备份顺利</span>
        </div>
      </section>
    </div>
  )
}
