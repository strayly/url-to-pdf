#!/usr/bin/env node
/**
 * 部署后自检。重点是那条最容易踩的坑：
 * 付费端点如果被漏配鉴权 middleware，会直接返回 200 把数据免费送出去。
 * 这个脚本就是专门用来抓这种情况的。
 *
 *   node scripts/selfcheck.mjs https://url-to-pdf-mcp.xxx.workers.dev
 */

const input = process.argv[2] || process.env.WORKER_ORIGIN
if (!input) {
  console.error('用法: node scripts/selfcheck.mjs https://url-to-pdf-mcp.xxx.workers.dev')
  process.exit(1)
}

const BASE = input.replace(/\/$/, '')
let failures = 0

const G = (s) => `\x1b[32m${s}\x1b[0m`
const R = (s) => `\x1b[31m${s}\x1b[0m`
const D = (s) => `\x1b[2m${s}\x1b[0m`

async function check(label, fn) {
  try {
    const res = await fn()
    if (res.ok) {
      console.log(`  ${G('PASS')}  ${label} ${D(res.note ?? '')}`)
    } else {
      failures += 1
      console.log(`  ${R('FAIL')}  ${label}\n        ${res.note}`)
    }
  } catch (err) {
    failures += 1
    console.log(`  ${R('ERR ')}  ${label}\n        ${err.message}`)
  }
}

async function http(path, init) {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
}

console.log(`\n自检目标: ${BASE}\n`)

await check('GET / 首页可达', async () => {
  const r = await http('/', { method: 'GET' })
  return r.status === 200 ? { ok: true } : { ok: false, note: `expected 200, got ${r.status}` }
})

await check('GET /openapi.json 可发现', async () => {
  const r = await http('/openapi.json', { method: 'GET' })
  if (r.status !== 200) return { ok: false, note: `expected 200, got ${r.status}` }
  const j = await r.json()
  const n = Object.keys(j.paths || {}).length
  return n >= 3 ? { ok: true, note: `${n} endpoints advertised` } : { ok: false, note: `only ${n} paths` }
})

await check('POST /mcp 返回工具清单（发现层不鉴权）', async () => {
  const r = await http('/mcp', {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  if (r.status !== 200) return { ok: false, note: `expected 200, got ${r.status}` }
  const j = await r.json()
  const names = (j.result?.tools || []).map((t) => t.name)
  const want = ['list_capabilities', 'url_to_pdf', 'url_to_screenshot', 'url_to_markdown']
  const missing = want.filter((w) => !names.includes(w))
  return missing.length === 0
    ? { ok: true, note: names.join(', ') }
    : { ok: false, note: `missing tools: ${missing.join(', ')}` }
})

const paid = [
  ['/tools/url-to-pdf', { url: 'https://example.com', format: 'A4' }],
  ['/tools/url-to-screenshot', { url: 'https://example.com', fullPage: true }],
  ['/tools/url-to-markdown', { url: 'https://example.com' }],
]

console.log(D('  付费端点必须在无 key 时返回 401 —— 返回 200 说明漏配了鉴权\n'))
for (const [path, body] of paid) {
  await check(`${path} 无 key → 401`, async () => {
    const r = await http(path, { method: 'POST', body: JSON.stringify(body) })
    if (r.status === 401) {
      return { ok: true, note: '401 unauthorized (correct)' }
    }
    if (r.status === 200) {
      return { ok: false, note: '返回 200 —— 数据被免费送出去了，检查鉴权配置' }
    }
    return { ok: false, note: `expected 401, got ${r.status}` }
  })
}

console.log(D('  SSRF 前置校验要在鉴权之前拦截\n'))
for (const bad of ['http://127.0.0.1/', 'http://169.254.169.254/latest/meta-data/', 'ftp://example.com']) {
  await check(`SSRF 拦截 ${bad}`, async () => {
    const r = await http('/tools/url-to-pdf', { method: 'POST', body: JSON.stringify({ url: bad }) })
    return r.status === 400
      ? { ok: true, note: 'blocked before auth' }
      : { ok: false, note: `expected 400, got ${r.status}` }
  })
}

console.log('')
if (failures === 0) {
  console.log(G('全部通过') + D(' —— 接下来可以用一个真实 API key 跑一次渲染验证结算链路\n'))
} else {
  console.log(R(`${failures} 项未通过`) + D(' —— 修完再重跑\n'))
  process.exit(1)
}
