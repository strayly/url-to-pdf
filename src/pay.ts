/**
 * 支付与鉴权层 —— 全部隔离在这一文件。
 *
 * 模型：Paddle 卖 API key（订阅或一次性）。用户付款后 Paddle 发 webhook，
 * 本 Worker 验签后生成 API key 存进 KV，用户凭邮箱在 /portal/claim 取回。
 * 之后调用 /tools/* 时带 `Authorization: Bearer <key>`（或 `x-api-key`）即可。
 *
 * 想换回 x402 或别的方式，只改这一个文件，其余文件不动。
 */

import type { Env } from './env'

export interface EndpointPrice {
  route: string
  price: string
  description: string
  url: string
}

export function listPaidEndpoints(env: Env): EndpointPrice[] {
  const origin = (env.WORKER_ORIGIN || '').replace(/\/$/, '')
  return [
    {
      route: 'POST /tools/url-to-pdf',
      price: env.PRICE_PDF,
      description: 'Render a web page to PDF. Returns a download URL valid for 1 hour.',
      url: `${origin}/tools/url-to-pdf`,
    },
    {
      route: 'POST /tools/url-to-screenshot',
      price: env.PRICE_SCREENSHOT,
      description: 'Capture a full-page screenshot as PNG or JPEG.',
      url: `${origin}/tools/url-to-screenshot`,
    },
    {
      route: 'POST /tools/url-to-markdown',
      price: env.PRICE_MARKDOWN,
      description: 'Extract the main content of a page as clean Markdown.',
      url: `${origin}/tools/url-to-markdown`,
    },
  ]
}

/** 本地调试想绕过鉴权，把 DISABLE_PAYWALL 设成 true（生产千万别开） */
export function paywallDisabled(env: Env): boolean {
  return String(env.DISABLE_PAYWALL ?? '').toLowerCase() === 'true'
}

export function paddleApiBase(env: Env): string {
  return (env.PADDLE_ENV || 'production') === 'sandbox'
    ? 'https://sandbox-api.paddle.com'
    : 'https://api.paddle.com'
}

// ---------------------------------------------------------------- API key 提取与校验

export function extractApiKey(req: Request): string | null {
  const auth = req.headers.get('authorization')
  if (auth && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, '').trim()
  const x = req.headers.get('x-api-key')
  if (x) return x.trim()
  try {
    const u = new URL(req.url)
    const q = u.searchParams.get('api_key')
    if (q) return q.trim()
  } catch {
    /* ignore */
  }
  return null
}

export async function validateApiKey(env: Env, key: string | null): Promise<boolean> {
  if (!key) return false
  const rec = await env.KEYS.get(`key:${key}`)
  if (!rec) return false
  try {
    const data = JSON.parse(rec) as { active?: boolean; expiresAt?: number | null }
    if (data.active === false) return false
    if (data.expiresAt && Date.now() > data.expiresAt) return false
    return true
  } catch {
    return false
  }
}

/** Hono 中间件：要求有效 API key，否则 401 */
export function requireApiKey() {
  return async (c: any, next: any) => {
    if (paywallDisabled(c.env)) return next()
    const key = extractApiKey(c.req.raw)
    const ok = await validateApiKey(c.env, key)
    if (!ok) {
      const origin = c.env.WORKER_ORIGIN || new URL(c.req.url).origin
      return c.json(
        {
          error: 'unauthorized',
          message: 'A valid API key is required to call this endpoint.',
          buyUrl: `${origin}/buy`,
          hint: 'Send it as "Authorization: Bearer <key>" or "x-api-key: <key>".',
        },
        401,
      )
    }
    return next()
  }
}

// ---------------------------------------------------------------- key 签发

function generateToken(nBytes: number): string {
  const arr = new Uint8Array(nBytes)
  crypto.getRandomValues(arr)
  return Array.from(arr, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** 按邮箱签发 key；同一邮箱重复购买不会重复发卡（幂等） */
export async function issueKey(
  env: Env,
  email: string,
  paddleId: string,
  source: string,
): Promise<string> {
  const norm = email.toLowerCase().trim()
  const existing = await env.KEYS.get(`cust:${norm}`)
  if (existing) return existing
  const key = `utp_${generateToken(24)}`
  const rec = JSON.stringify({
    email: norm,
    paddleId,
    source,
    createdAt: Date.now(),
    expiresAt: null,
    active: true,
  })
  await env.KEYS.put(`key:${key}`, rec)
  await env.KEYS.put(`cust:${norm}`, key)
  return key
}

async function deactivateKey(env: Env, key: string): Promise<void> {
  const rec = await env.KEYS.get(`key:${key}`)
  if (!rec) return
  try {
    const data = JSON.parse(rec) as { active?: boolean }
    data.active = false
    await env.KEYS.put(`key:${key}`, JSON.stringify(data))
  } catch {
    /* ignore */
  }
}

// ---------------------------------------------------------------- Paddle webhook 验签

export async function verifyPaddleSignature(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
): Promise<boolean> {
  if (!signatureHeader) return false
  const m = /ts=(\d+);h1=([0-9a-f]+)/i.exec(signatureHeader)
  if (!m) return false
  const ts = m[1]
  const expected = m[2].toLowerCase()
  const payload = `${ts}:${rawBody}`
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(payload))
  const actual = Array.from(new Uint8Array(sigBuf), (b) =>
    b.toString(16).padStart(2, '0'),
  ).join('')
  return actual === expected
}

const PAID_EVENTS = new Set([
  'transaction.completed',
  'subscription.activated',
  'subscription.created',
  'subscription.updated',
])

/**
 * 取买家邮箱。Paddle 的交易/订阅 webhook payload 里 data 只有 customer_id，
 * 没有嵌套的 customer.email（官方字段表可查）。所以先看 payload 里有没有，
 * 没有再拿 customer_id 回调 Paddle API 反查。反查失败就返回 null，不发卡。
 */
async function resolveCustomerEmail(env: Env, data: any): Promise<string | null> {
  const direct =
    data?.customer?.email || data?.customer_email || (data?.custom_data?.email as string | undefined)
  if (direct) return String(direct)

  const customerId = data?.customer_id
  const apiKey = env.PADDLE_API_KEY
  if (!customerId || !apiKey) return null
  try {
    const r = await fetch(`${paddleApiBase(env)}/customers/${encodeURIComponent(customerId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!r.ok) return null
    const j = (await r.json()) as any
    const email = j?.data?.email
    return email ? String(email) : null
  } catch {
    return null
  }
}

export async function handlePaddleWebhook(request: Request, env: Env): Promise<Response> {
  const raw = await request.text()
  const secret = env.PADDLE_WEBHOOK_SECRET
  if (!secret) {
    return new Response('webhook secret not configured', { status: 500 })
  }
  const valid = await verifyPaddleSignature(raw, request.headers.get('paddle-signature'), secret)
  if (!valid) {
    return new Response('invalid signature', { status: 401 })
  }
  let event: any
  try {
    event = JSON.parse(raw)
  } catch {
    return new Response('bad json', { status: 400 })
  }
  const type = String(event?.event_type || '')
  if (PAID_EVENTS.has(type)) {
    const data = event?.data || {}
    const email = await resolveCustomerEmail(env, data)
    const paddleId = String(data?.subscription_id || data?.id || '')
    if (email) {
      const key = await issueKey(env, email, paddleId, type)
      // 订阅状态变化：非 active 就停用 key
      if (type === 'subscription.updated' && data?.status && data.status !== 'active') {
        await deactivateKey(env, key)
      }
    }
  }
  // 永远返回 200，避免 Paddle 重试风暴
  return new Response('ok', { status: 200 })
}

/** 支付完成后，用户凭邮箱自助领取 key */
export async function handleClaim(request: Request, env: Env): Promise<Response> {
  const u = new URL(request.url)
  const email = (u.searchParams.get('email') || '').trim()
  if (!email) {
    return json({ error: 'email_required', message: 'Pass ?email=you@example.com used at checkout.' }, 400)
  }
  const key = await env.KEYS.get(`cust:${email.toLowerCase()}`)
  if (!key) {
    return json(
      { error: 'no_key', message: 'No active key for this email. Complete a purchase first.' },
      404,
    )
  }
  return json({
    apiKey: key,
    note: 'Use it as "Authorization: Bearer <key>" or "x-api-key: <key>" on /tools/* and /mcp.',
  })
}

/** 本站自有收银台的路径 */
export const CHECKOUT_PATH = '/checkout'

/**
 * 收银台：调 Paddle API 建交易，然后跳到**本站自己的 /checkout**。
 *
 * 为什么不直接用 Paddle 返回的 checkout.url？
 * 因为账号的 Default payment link 是全局的，本账号被设成了别的产品的付款页
 * （pdf.hammbox.com/pricing）。那个页面写死了它自己的商品、不认 _ptxn，会把
 * 本产品带成错的商品和价格。所以本产品自己出一张收银台页，按 _ptxn 拉起交易。
 */
export async function handleBuy(request: Request, env: Env): Promise<Response> {
  const priceId = env.PADDLE_PRICE_ID
  if (!priceId || priceId.startsWith('REPLACE')) {
    return new Response('PADDLE_PRICE_ID not configured', { status: 503 })
  }
  const apiKey = env.PADDLE_API_KEY
  if (!apiKey) {
    return new Response('PADDLE_API_KEY not configured', { status: 503 })
  }
  const origin = (env.WORKER_ORIGIN || new URL(request.url).origin).replace(/\/$/, '')
  const apiBase = paddleApiBase(env)
  let parsed: any = {}
  try {
    const r = await fetch(`${apiBase}/transactions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{ price_id: priceId, quantity: 1 }],
        custom_data: { source: 'url-to-pdf-web' },
      }),
    })
    if (!r.ok) {
      const txt = await r.text()
      return new Response(`Paddle error ${r.status}: ${txt}`, { status: 502 })
    }
    parsed = await r.json()
  } catch (err) {
    return new Response(`Upstream error: ${err instanceof Error ? err.message : String(err)}`, {
      status: 502,
    })
  }
  const txnId = parsed?.data?.id
  if (!txnId) {
    return new Response('No transaction id returned by Paddle', { status: 502 })
  }
  // 尽力把这笔交易的 checkout.url 也指到本站收银台 —— Paddle 发出的续费/改卡邮件用它。
  // 域名未审批等会报错，忽略即可，不影响下面 302 的主流程。
  await pointCheckoutUrlAtUs(apiKey, apiBase, txnId, origin).catch(() => {})
  return new Response(null, {
    status: 302,
    headers: { Location: `${origin}${CHECKOUT_PATH}?_ptxn=${encodeURIComponent(txnId)}` },
  })
}

/** 把某笔交易的 checkout.url 改成本站收银台（best-effort，失败不阻断付款） */
async function pointCheckoutUrlAtUs(
  apiKey: string,
  apiBase: string,
  txnId: string,
  origin: string,
): Promise<void> {
  await fetch(`${apiBase}/transactions/${encodeURIComponent(txnId)}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ checkout: { url: `${origin}${CHECKOUT_PATH}` } }),
  })
}

/**
 * 本站自有收银台页。用 Paddle.js 按 URL 上的 _ptxn 拉起对应交易的结账浮层。
 * 结账里显示的商品/价格永远来自我们建的那笔交易，与账号默认 payment link 解耦。
 */
export function handleCheckoutPage(env: Env): Response {
  const token = env.PADDLE_CLIENT_TOKEN || ''
  if (!token || token.startsWith('REPLACE')) {
    return new Response('PADDLE_CLIENT_TOKEN not configured', { status: 503 })
  }
  const isSandbox = (env.PADDLE_ENV || 'production') === 'sandbox'
  const jsToken = JSON.stringify(token)
  const envSet = isSandbox ? "Paddle.Environment.set('sandbox');" : ''

  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Checkout — url-to-pdf</title>
<style>
 body{margin:0;font:15px/1.6 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;color:#1a1a1a;background:#fafafa;display:flex;min-height:100vh;align-items:center;justify-content:center}
 .card{background:#fff;border:1px solid #ebebeb;border-radius:12px;padding:32px 28px;max-width:380px;width:calc(100% - 40px);text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.04)}
 h1{font-size:18px;margin:0 0 6px;font-weight:600}
 p{color:#666;margin:0 0 18px;font-size:14px}
 button{background:#0a6;color:#fff;border:0;border-radius:6px;padding:10px 18px;font-size:14px;font-weight:500;cursor:pointer}
 .err{color:#c0392b;font-size:13px;margin:14px 0 0}
 a.back{display:block;margin-top:16px;color:#888;font-size:13px;text-decoration:none}
</style></head>
<body>
<div class="card">
  <h1>url-to-pdf</h1>
  <p id="msg">Opening secure Paddle checkout…</p>
  <button id="open" hidden>Open checkout</button>
  <p class="err" id="err" hidden></p>
  <a class="back" href="/">← Back</a>
</div>
<script src="https://cdn.paddle.com/paddle/v2/paddle.js"></script>
<script>
(function(){
  var q = new URLSearchParams(location.search);
  var txn = q.get('_ptxn') || q.get('txn');
  var msg = document.getElementById('msg');
  var btn = document.getElementById('open');
  var err = document.getElementById('err');
  function fail(t){ msg.hidden = true; err.hidden = false; err.textContent = t; btn.hidden = false; }
  if (!txn) { fail('Missing transaction id. Start again from /buy.'); return; }
  var ready = false;
  function open(){
    if (!ready) { setTimeout(open, 200); return; }
    try { Paddle.Checkout.open({ transactionId: txn }); msg.hidden = false; err.hidden = true; }
    catch (e) { fail(String((e && e.message) || e)); }
  }
  btn.addEventListener('click', open);
  try {
    ${envSet}
    var initP = Paddle.Initialize({ token: ${jsToken} });
    if (initP && typeof initP.then === 'function') {
      initP.then(function(){ ready = true; open(); }).catch(function(e){ fail(String((e && e.message) || e)); });
    } else { ready = true; open(); }
  } catch (e) { fail('Paddle.js failed to load. Please retry.'); return; }
})();
</script>
</body></html>`

  return new Response(html, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}
