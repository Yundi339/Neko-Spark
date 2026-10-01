import { useEffect, useState, type JSX } from 'react'
import QRCode from 'qrcode'
import type { AppStatus } from '@shared/types'

interface PairingPopupProps {
  status: AppStatus
  onClose: () => void
}

/** 手机完成配对后在桌面端短暂显示的本地配对信息。 */
export default function PairingPopup({ status, onClose }: PairingPopupProps): JSX.Element {
  const [qr, setQr] = useState('')
  const address = status.hub.addresses[0] ?? ''
  const code = status.hub.pairingCode ?? ''
  const link = address && code
    ? (() => {
        const value = new URL('neko-spark://pair')
        value.searchParams.set('url', address)
        value.searchParams.set('fingerprint', status.hubCertFingerprint)
        value.searchParams.set('code', code)
        return value.toString()
      })()
    : ''

  useEffect(() => {
    let alive = true
    setQr('')
    if (!link) return () => { alive = false }
    void QRCode.toDataURL(link, { width: 260, margin: 2, errorCorrectionLevel: 'M' })
      .then((dataUrl) => {
        if (alive) setQr(dataUrl)
      })
      .catch(() => {
        if (alive) setQr('')
      })
    return () => {
      alive = false
    }
  }, [link])

  return (
    <div className="pairing-modal" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section className="pairing-popup" role="dialog" aria-modal="true" aria-labelledby="pairing-popup-title">
        <div className="pairing-popup-head">
          <div>
            <h2 id="pairing-popup-title">手机已完成配对</h2>
            <p>下面的信息只显示在这台电脑上，可用于连接另一台手机。</p>
          </div>
          <button type="button" className="btn btn-ghost" onClick={onClose} aria-label="关闭">
            关闭
          </button>
        </div>

        <div className="pairing-popup-body">
          {qr ? <img className="pairing-popup-qr" src={qr} alt="手机扫描配对二维码" /> : <div className="pairing-popup-qr-empty">二维码生成中...</div>}
          <strong className="pairing-popup-code">{code || '配对码已刷新'}</strong>
          <div className="pairing-popup-field">
            <span>互联网访问密钥</span>
            <code>{status.hubToken || '初始化中...'}</code>
          </div>
          {status.hub.pairingExpiresAt ? (
            <span className="hint">新的配对码有效至 {new Date(status.hub.pairingExpiresAt).toLocaleTimeString()}</span>
          ) : null}
        </div>
      </section>
    </div>
  )
}
