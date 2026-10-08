import { Hono } from 'hono'
import type { Env } from './env'
import { renderAndStore, BusyError, type Kind } from './render'
import {
  requireApiKey,
  listPaidEndpoints,
  handlePaddleWebhook,
  handleClaim,
  handleBuy,
  handleCheckoutPage,
} from './pay'
import { handleMcp } from './mcp'
import { GuardError, assertPublicUrl } from './guard'

const app = new Hono<{ Bindings: Env }>()

const FILE_TTL_MS = 60 * 60 * 1000

// ---------------------------------------------------------------- 免费前置校验
// 内网/非法 URL 在鉴权之前就挡掉，避免被人用你的 Worker 扫内网/云 metadata。
app.use('/tools/*', async (c, next) => {
  if (c.req.method !== 'POST') return next()
  const probe = c.req.raw.clone()
  try {
    const body = (await probe.json()) as Record<string, unknown>
    assertPublicUrl(body?.url)
  } catch (err) {
    if (err instanceof GuardError) {
      return c.json(
        { error: 'bad_request', detail: err.message, note: 'Rejected before auth — no charge' },
        400,
      )
    }
  }
  return next()
})

// ---------------------------------------------------------------- 鉴权门
// 要求有效 API key（Paddle 购买后签发）。本地用 DISABLE_PAYWALL 绕过。
app.use('/tools/*', requireApiKey())

// ---------------------------------------------------------------- 付费工具

app.post('/tools/url-to-pdf', (c) => handleRender(c, 'pdf'))
app.post('/tools/url-to-screenshot', (c) => handleRender(c, 'screenshot'))
app.post('/tools/url-to-markdown', (c) => handleRender(c, 'markdown'))

async function handleRender(c: any, kind: Kind) {
  let args: Record<string, unknown>
  try {
    args = (await c.req.json()) as Record<string, unknown>
  } catch {
    return c.json({ error: 'Request body must be valid JSON' }, 400)
  }

  try {
    const out = await renderAndStore(c.env, kind, args, originOf(c))
    return c.json(out)
  } catch (err) {
    if (err instanceof GuardError) {
      return c.json({ error: 'bad_request', detail: err.message }, 400)
    }
    if (err instanceof BusyError) {
      return c.json(
        {
          error: 'busy',
          detail: 'Rendering capacity is momentarily saturated. Retry in a few seconds.',
          retryAfterSeconds: err.retryAfterSeconds,
        },
        429,
        { 'Retry-After': String(err.retryAfterSeconds) },
      )
    }
    return c.json(
      { error: 'render_failed', detail: err instanceof Error ? err.message : String(err) },
      502,
    )
  }
}

// ---------------------------------------------------------------- 产物下载

// 注意：产物 key 形如 "pdf/<uuid>.pdf"，**含斜杠**，所以必须用通配路由 /f/*，
// 单段 :key 参数匹配不到两段路径（会导致所有下载链接 404）。
app.get('/f/*', async (c) => {
  const key = decodeURIComponent(new URL(c.req.url).pathname.slice('/f/'.length))
  if (!key || key.includes('..')) return c.json({ error: 'not_found' }, 404)

  const obj = await c.env.ASSETS.getWithMetadata(key, 'arrayBuffer')
  if (!obj || !obj.value) return c.json({ error: 'expired_or_not_found' }, 410)

  const meta = (obj.metadata ?? {}) as Record<string, unknown>
  const createdAt = Number(meta?.createdAt ?? 0)
  if (!createdAt || Date.now() - createdAt > FILE_TTL_MS) {
    await c.env.ASSETS.delete(key).catch(() => {})
    return c.json({ error: 'expired', detail: 'Download links are valid for 1 hour' }, 410)
  }

  const buf = obj.value
  return new Response(buf, {
    headers: {
      'Content-Type': String(meta?.contentType ?? 'application/octet-stream'),
      'Cache-Control': 'private, max-age=3600',
      'Content-Disposition': `attachment; filename="${key.split('/').pop()}"`,
    },
  })
})

// ---------------------------------------------------------------- 收银台 / 发卡 / 领取

app.get('/buy', (c) => handleBuy(c.req.raw, c.env))
app.get('/checkout', (c) => handleCheckoutPage(c.env))
app.post('/webhook/paddle', (c) => handlePaddleWebhook(c.req.raw, c.env))
app.get('/portal/claim', (c) => handleClaim(c.req.raw, c.env))

// ---------------------------------------------------------------- MCP
// 发现层不鉴权（任何人都能看工具清单和价格）；执行层（/tools/*）才要 key。
app.post('/mcp', (c) => handleMcp(c.req.raw, c.env))

app.get('/openapi.json', (c) => {
  const eps = listPaidEndpoints(c.env)
  const paths: Record<string, unknown> = {}
  for (const ep of eps) {
    const p = new URL(ep.url).pathname
    paths[p] = {
      post: {
        summary: ep.description,
        operationId: p.replace('/tools/', ''),
        'x-auth': 'api_key (Paddle purchase)',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { type: 'object' } } },
        },
        responses: {
          200: { description: 'Rendered artifact, returns a download URL' },
          401: { description: 'API key required' },
        },
      },
    }
  }
  return c.json({
    openapi: '3.1.0',
    info: {
      title: 'url-to-pdf',
      version: '0.2.0',
      description:
        'Render any public web page to PDF, screenshot or Markdown. Requires an API key purchased via Paddle.',
    },
    servers: [{ url: originOf(c) }],
    paths,
  })
})

// ---------------------------------------------------------------- 首页

app.get('/', (c) => {
  const eps = listPaidEndpoints(c.env)
  return c.html(`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>url-to-pdf — API key via Paddle</title>
<style>
 body{font:15px/1.6 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:680px;margin:8vh auto;padding:0 20px;color:#1a1a1a}
 h1{font-size:22px;font-weight:600;margin:0 0 4px}
 p.sub{color:#666;margin:0 0 28px}
 code{background:#f4f4f5;padding:2px 5px;border-radius:3px;font-size:13px}
 pre{background:#f4f4f5;padding:14px;border-radius:6px;overflow-x:auto;font-size:13px}
 table{border-collapse:collapse;width:100%;margin:20px 0}
 th,td{text-align:left;padding:9px 10px;border-bottom:1px solid #e5e5e5;font-size:14px}
 th{color:#666;font-weight:500}
 .price{color:#0a6;font-weight:500}
 .cta{display:inline-block;background:#0a6;color:#fff;padding:9px 16px;border-radius:6px;text-decoration:none;font-weight:500}
</style></head>
<body>
<h1>url-to-pdf</h1>
<p class="sub">Render any public web page to PDF, screenshot or Markdown. Pay once, get an API key via Paddle.</p>

<table>
<tr><th>Endpoint</th><th>Plan</th></tr>
${eps
  .map(
    (e) =>
      `<tr><td><code>POST ${new URL(e.url).pathname}</code></td><td class="price">${e.price}</td></tr>`,
  )
  .join('')}
</table>

<h3>Get an API key</h3>
<p><a class="cta" href="/buy">Buy an API key (Paddle checkout)</a></p>
<p>After checkout, retrieve your key at <code>/portal/claim?email=you@example.com</code>.</p>

<h3>Call it</h3>
<pre>curl -X POST ${originOf(c)}/tools/url-to-pdf \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_KEY" \\
  -d '{"url":"https://example.com","format":"A4"}'</pre>

<h3>Connect as MCP</h3>
<pre>{
  "mcpServers": {
    "url-to-pdf": {
      "command": "npx",
      "args": ["mcp-remote", "${originOf(c)}/mcp", "--header", "x-api-key: YOUR_KEY"]
    }
  }
}</pre>
<p>Paid tools return their own guidance on call — buy a key, then hit the HTTP endpoints with it.</p>
</body></html>`)
})

function originOf(c: any): string {
  const configured = c.env?.WORKER_ORIGIN?.replace(/\/$/, '')
  if (configured && configured.startsWith('http')) return configured
  return new URL(c.req.url).origin
}

export default {
  fetch: app.fetch,
}
