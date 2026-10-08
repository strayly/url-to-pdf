// URL 安全校验。这个服务是对公网开放的，任何 agent 都能调用并传任意 URL，
// 所以必须拦住 SSRF —— 否则别人能用你的 Worker 去扫你的内网和云厂商 metadata。

const BLOCKED_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
  'metadata.google.internal',
  'metadata',
])

const PRIVATE_V4 = /^(10|127|169\.254|192\.168|172\.(1[6-9]|2\d|3[01]))\./
const CGNAT_V4 = /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./

export class GuardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GuardError'
  }
}

export function assertPublicUrl(raw: unknown): URL {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new GuardError('url is required and must be a string')
  }
  if (raw.length > 2048) throw new GuardError('url too long')

  let u: URL
  try {
    u = new URL(raw)
  } catch {
    throw new GuardError('malformed url')
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new GuardError('only http and https are allowed')
  }
  if (u.username || u.password) {
    throw new GuardError('credentials in url are not allowed')
  }

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')

  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOSTS.has(u.hostname.toLowerCase())) {
    throw new GuardError(`blocked host: ${u.hostname}`)
  }
  if (host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new GuardError(`blocked host: ${u.hostname}`)
  }
  if (PRIVATE_V4.test(host) || CGNAT_V4.test(host)) {
    throw new GuardError(`private/link-local address blocked: ${u.hostname}`)
  }
  if (host === '::1' || host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd')) {
    throw new GuardError(`ipv6 local address blocked: ${u.hostname}`)
  }

  return u
}

// 已知短板：这里只做字符串层面的拦截，没有做 DNS 解析，
// 所以理论上仍有 DNS rebinding 的窗口。要想堵死，需要在解析后校验 A 记录，
// 代价是每请求多一次 DNS。当前先接受这个风险，README 里标注了。
