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
import { landingPage, privacyPage, refundPage, termsPage } from './pages'

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

// ---------------------------------------------------------------- 首页 + 法律页

app.get('/', (c) => c.html(landingPage(originOf(c))))
app.get('/privacy', (c) => c.html(privacyPage()))
app.get('/refund', (c) => c.html(refundPage()))
app.get('/terms', (c) => c.html(termsPage()))

function originOf(c: any): string {
  const configured = c.env?.WORKER_ORIGIN?.replace(/\/$/, '')
  if (configured && configured.startsWith('http')) return configured
  return new URL(c.req.url).origin
}

export default {
  fetch: app.fetch,
}
