// 线上全链路自测：鉴权门 + SSRF + webhook 验签发卡 + key 调用 + 错误签名→401
// 用法：BASE=https://... PADDLE_WEBHOOK_SECRET=... node scripts/live-test.mjs

import crypto from 'node:crypto'

const BASE = (process.env.BASE || '').replace(/\/$/, '')
const WHSEC = process.env.PADDLE_WEBHOOK_SECRET || ''

if (!BASE) {
  console.error('缺少 BASE')
  process.exit(1)
}
if (!WHSEC) {
  console.error('缺少 PADDLE_WEBHOOK_SECRET（用于模拟 Paddle 验签）')
  process.exit(1)
}

let fails = 0
const G = (s) => `\x1b[32m${s}\x1b[0m`
const R = (s) => `\x1b[31m${s}\x1b[0m`
const D = (s) => `\x1b[2m${s}\x1b[0m`

async function check(label, fn) {
  try {
    const r = await fn()
    if (r.ok) console.log(`  ${G('PASS')}  ${label} ${D(r.note || '')}`)
    else {
      fails++
      console.log(`  ${R('FAIL')}  ${label}\n        ${r.note}`)
    }
  } catch (e) {
    fails++
    console.log(`  ${R('ERR ')}  ${label}\n        ${e.message}`)
  }
}

async function j(url, init) {
  const r = await fetch(BASE + url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
  })
  let body = null
  try {
    body = await r.json()
  } catch {
    /* ignore */
  }
  return { r, body }
}

console.log(`\n线上自测目标: ${BASE}\n`)

await check('GET / 首页', async () => {
  const { r } = await j('/', { method: 'GET' })
  return r.status === 200 ? { ok: true } : { ok: false, note: `status ${r.status}` }
})

await check('GET /openapi.json', async () => {
  const { r, body } = await j('/openapi.json', { method: 'GET' })
  if (r.status !== 200) return { ok: false, note: `status ${r.status}` }
  const n = Object.keys(body?.paths || {}).length
  return n >= 3 ? { ok: true, note: `${n} endpoints` } : { ok: false, note: `only ${n}` }
})

await check('POST /mcp tools/list（发现层不鉴权）', async () => {
  const { r, body } = await j('/mcp', {
    method: 'POST',
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  })
  if (r.status !== 200) return { ok: false, note: `status ${r.status}` }
  const names = (body?.result?.tools || []).map((t) => t.name)
  const want = ['list_capabilities', 'url_to_pdf', 'url_to_screenshot', 'url_to_markdown']
  const missing = want.filter((w) => !names.includes(w))
  return missing.length === 0 ? { ok: true, note: names.join(', ') } : { ok: false, note: `missing ${missing}` }
})

await check('/tools/* 无 key → 401', async () => {
  const { r } = await j('/tools/url-to-markdown', {
    method: 'POST',
    body: JSON.stringify({ url: 'https://example.com' }),
  })
  return r.status === 401 ? { ok: true, note: '401 (correct)' } : { ok: false, note: `status ${r.status}` }
})

await check('SSRF 127.0.0.1 无 key 也要先拦截', async () => {
  const { r } = await j('/tools/url-to-pdf', {
    method: 'POST',
    body: JSON.stringify({ url: 'http://127.0.0.1/' }),
  })
  return r.status === 400 ? { ok: true, note: '400 blocked' } : { ok: false, note: `status ${r.status}` }
})

// ---- 真实 webhook 验签自测（用设定的 WHSEC 自己算 HMAC，同时自动发卡） ----
let testKey = null
await check('POST /webhook/paddle 验签 + 发卡', async () => {
  const ts = Math.floor(Date.now() / 1000)
  const payload = JSON.stringify({
    event_type: 'transaction.completed',
    data: { customer: { email: 'paid@buyer.com' }, id: 'txn_selftest_1', subscription_id: '' },
  })
  const sig = crypto.createHmac('sha256', WHSEC).update(`${ts}:${payload}`).digest('hex')
  const r = await fetch(BASE + '/webhook/paddle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Paddle-Signature': `ts=${ts};h1=${sig}` },
    body: payload,
  })
  if (r.status !== 200) return { ok: false, note: `status ${r.status}` }
  // 领取
  const claim = await fetch(BASE + '/portal/claim?email=paid@buyer.com')
  let cb = null
  try {
    cb = await claim.json()
  } catch {
    /* ignore */
  }
  if (claim.status !== 200 || !cb?.apiKey)
    return { ok: false, note: `webhook 200 但领取失败: ${JSON.stringify(cb)}` }
  testKey = cb.apiKey
  return { ok: true, note: `验签通过并自动发卡, key=${cb.apiKey.slice(0, 12)}…` }
})

// ---- 用 webhook 发的 key 调用（验证鉴权放行） ----
await check('带 key 调 /tools/url-to-markdown', async () => {
  if (!testKey) return { ok: false, note: '上一步未发卡，跳过' }
  const { r, body } = await j('/tools/url-to-markdown', {
    method: 'POST',
    headers: { 'x-api-key': testKey },
    body: JSON.stringify({ url: 'https://example.com' }),
  })
  if (r.status === 200) return { ok: true, note: '200 rendered (Browser Rendering OK)' }
  if (r.status === 502) return { ok: true, note: '502 — 渲染失败（多半是 Workers 未升 Paid/Browser Rendering 不可用），鉴权已放行' }
  return { ok: false, note: `status ${r.status} body=${JSON.stringify(body)}` }
})

await check('POST /webhook/paddle 错误签名 → 401', async () => {
  const r = await fetch(BASE + '/webhook/paddle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Paddle-Signature': 'ts=1;h1=deadbeef' },
    body: '{}',
  })
  return r.status === 401 ? { ok: true, note: '401 rejected (correct)' } : { ok: false, note: `status ${r.status}` }
})

console.log('')
if (fails === 0) console.log(G('全部通过'))
else console.log(R(`${fails} 项未通过`))
process.exit(fails === 0 ? 0 : 1)
