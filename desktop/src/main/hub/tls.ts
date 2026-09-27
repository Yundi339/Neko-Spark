import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { networkInterfaces } from 'node:os'
import selfsigned from 'selfsigned'

const CERT_FILE = 'hub-cert.pem'
const KEY_FILE = 'hub-key.pem'

export interface HubTlsCredentials {
  cert: string
  key: string
  fingerprint: string
}

type HubAltName = { type: 1 | 2 | 6 | 7; value?: string; ip?: string }

function fingerprintOf(cert: string): string {
  return new X509Certificate(cert).fingerprint256
}

function isUsablePair(cert: string, key: string): boolean {
  try {
    const parsed = new X509Certificate(cert)
    const expiresAt = Date.parse(parsed.validTo)
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return false
    const certificateKey = parsed.publicKey.export({ type: 'spki', format: 'der' })
    const privateKey = createPrivateKey(key)
    const privatePublicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
    return Buffer.compare(certificateKey, privatePublicKey) === 0
  } catch {
    return false
  }
}

function localAltNames(): HubAltName[] {
  const names: HubAltName[] = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' },
    { type: 7, ip: '::1' },
    { type: 7, ip: '10.0.2.2' }
  ]
  const seen = new Set(names.map((item) => item.ip ?? item.value ?? ''))
  for (const list of Object.values(networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family !== 'IPv4' || item.internal || seen.has(item.address)) continue
      seen.add(item.address)
      names.push({ type: 7, ip: item.address })
    }
  }
  return names
}

function writePrivate(file: string, value: string): void {
  const tmp = `${file}.tmp-${process.pid}`
  writeFileSync(tmp, value, { encoding: 'utf8', mode: 0o600 })
  renameSync(tmp, file)
  try {
    chmodSync(file, 0o600)
  } catch {
    // Windows ACL 由用户数据目录控制；支持 mode 的系统仍会收紧权限。
  }
}

/** 首次启动自动生成并持久化自签名证书；后续启动始终复用同一证书指纹。 */
export async function loadOrCreateHubTls(dataDir: string): Promise<HubTlsCredentials> {
  const certPath = join(dataDir, CERT_FILE)
  const keyPath = join(dataDir, KEY_FILE)
  if (existsSync(certPath) && existsSync(keyPath)) {
    try {
      const cert = readFileSync(certPath, 'utf8')
      const key = readFileSync(keyPath, 'utf8')
      if (isUsablePair(cert, key)) return { cert, key, fingerprint: fingerprintOf(cert) }
    } catch {
      // 文件损坏、过期或权限异常时，下面尝试用新材料恢复；写入失败会明确终止启动。
    }
  }

  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: 'Neko_Spark Hub' }],
    {
      keyType: 'ec',
      curve: 'P-256',
      algorithm: 'sha256',
      notAfterDate: new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000),
      extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true },
        { name: 'subjectAltName', altNames: localAltNames() }
      ]
    }
  )
  writePrivate(certPath, pems.cert)
  writePrivate(keyPath, pems.private)
  return { cert: pems.cert, key: pems.private, fingerprint: fingerprintOf(pems.cert) }
}
