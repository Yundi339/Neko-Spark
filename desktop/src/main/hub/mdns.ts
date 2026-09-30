import { Bonjour } from 'bonjour-service'

const SERVICE_TYPE = 'neko-spark'

export interface MdnsOptions {
  port: number
  version: string
  fingerprint: string
}

/**
 * 在局域网发布 Hub 的 mDNS 服务。
 * 只公布连接所需的地址元数据和证书指纹，绝不把局域网访问密钥放进 TXT 记录。
 */
export function startMdns(options: MdnsOptions): () => void {
  const bonjour = new Bonjour({}, (error: Error) => {
    // mDNS 受网卡、防火墙和系统服务影响；失败时保留现有 UDP 发现能力。
    console.warn(`[mdns] 广播不可用：${error.message}`)
  })
  const service = bonjour.publish({
    // 不把 Windows 计算机名广播到局域网；同网多实例由 mDNS 服务库自动处理重名。
    name: 'Neko_Spark',
    type: SERVICE_TYPE,
    protocol: 'tcp',
    port: options.port,
    txt: {
      name: 'Neko_Spark',
      version: options.version,
      fingerprint: options.fingerprint
    }
  })

  service.on('error', (error: Error) => {
    console.warn(`[mdns] 广播服务异常：${error.message}`)
  })

  return () => {
    service.stop(() => bonjour.destroy())
  }
}
