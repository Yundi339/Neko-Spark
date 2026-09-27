import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TOKEN_FILE = 'hub-token'
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

/**
 * 生成/读取局域网 Hub 访问密钥。密钥只放在数据目录，不通过 HTTP 接口返回；
 * 用户需要从桌面端设置页复制到自己的手机上。
 */
export function loadOrCreateHubToken(dataDir: string): string {
  const file = join(dataDir, TOKEN_FILE)
  try {
    const existing = readFileSync(file, 'utf8').trim()
    if (TOKEN_PATTERN.test(existing)) return existing
  } catch {
    // 首次启动或旧版本没有密钥，继续创建。
  }

  const token = randomBytes(32).toString('base64url')
  try {
    // wx 防止两个进程同时首次启动时互相覆盖密钥。
    writeFileSync(file, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    return token
  } catch {
    try {
      const raced = readFileSync(file, 'utf8').trim()
      if (TOKEN_PATTERN.test(raced)) return raced
    } catch {
      // 下面抛出更明确的错误。
    }
    throw new Error(`无法创建 Hub 访问密钥：${file}`)
  }
}

/** Windows 的 mode 位不总是能映射成 ACL，但在支持它的系统上仍尽力收紧权限。 */
export function tightenHubTokenPermissions(dataDir: string): void {
  const file = join(dataDir, TOKEN_FILE)
  if (!existsSync(file)) return
  try {
    chmodSync(file, 0o600)
  } catch {
    // 不让权限提示阻断启动；Windows 仍由用户数据目录的 ACL 保护。
  }
}

export function tokenMatches(expected: string, supplied: string | undefined): boolean {
  if (!supplied) return false
  const left = Buffer.from(expected, 'utf8')
  const right = Buffer.from(supplied.trim(), 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
}

export const HUB_TOKEN_HEADER = 'x-gallery-mirror-token'
