import type { Env } from './env'
import { listPaidEndpoints, extractApiKey, validateApiKey, paywallDisabled } from './pay'
import { renderAndStore, type Kind } from './render'

/**
 * MCP 层只做「发现」，HTTP 层负责「成交」。
 *
 * 分工原因：付费是 API key 模型——用户先去 /buy 通过 Paddle 买 key，
 * 之后调用 /tools/* 时带 x-api-key。MCP 这边把工具的 HTTP 端点暴露出来，
 * 付费工具在 tools/call 时返回引导（去哪买、怎么带 key），由 agent 自己去打 HTTP 端点。
 */

const PROTOCOL_VERSION = '2025-06-18'

type Json = Record<string, unknown>

const str = (desc: string) => ({ type: 'string' as const, description: desc })
const bool = (desc: string) => ({ type: 'boolean' as const, description: desc })
const num = (desc: string) => ({ type: 'number' as const, description: desc })

const NAV_PROPS = {
  waitUntil: {
    type: 'string',
    enum: ['load', 'domcontentloaded', 'networkidle0', 'networkidle2'],
    description: 'Puppeteer navigation wait condition. Default networkidle2.',
  },
  waitForSelector: str('Optional CSS selector to wait for before rendering.'),
  waitMs: num('Extra settle time after load, 0-10000ms. Few dynamics pages need this.'),
}

function srvOrigin(env: Env): string {
  const o = env.WORKER_ORIGIN?.replace(/\/$/, '')
  return o && o.startsWith('http') ? o : ''
}

interface ToolDef {
  name: string
  kind: 'free' | 'paid'
  endpoint?: string
  renderKind?: Kind
  description: string
  inputSchema: Json
}

function buildTools(env: Env): ToolDef[] {
  const eps = Object.fromEntries(listPaidEndpoints(env).map((e) => [e.route, e]))
  const origin = srvOrigin(env)

  return [
    {
      name: 'list_capabilities',
      kind: 'free',
      description:
        'Free. Returns what this server can do, the price of each paid tool, and where to buy an API key.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'url_to_pdf',
      kind: 'paid',
      renderKind: 'pdf',
      endpoint: eps['POST /tools/url-to-pdf']?.url,
      description: `Render a web page to PDF. Requires an API key purchased at ${origin}/buy. If this MCP request carries a valid "x-api-key" or "Authorization: Bearer" header, it renders directly and returns a 1-hour download URL; otherwise it returns purchase guidance.`,
      inputSchema: {
        type: 'object',
        properties: {
          url: str('Absolute http(s) URL of the page to render. Required.'),
          format: { type: 'string', enum: ['A4', 'Letter', 'Legal'], description: 'Paper size. Default A4.' },
          landscape: bool('Landscape orientation. Default false.'),
          printBackground: bool('Print background graphics. Default true.'),
          scale: num('Scale, 0.1-2. Default 1.'),
          margin: str('Margin shorthand like "10mm" — or an object {top,right,bottom,left}. Optional.'),
          preferCssPageSize: bool('Honor the page CSS @page size instead of the format option.'),
          ...NAV_PROPS,
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
    {
      name: 'url_to_screenshot',
      kind: 'paid',
      renderKind: 'screenshot',
      endpoint: eps['POST /tools/url-to-screenshot']?.url,
      description: `Capture a page as an image. Requires an API key purchased at ${origin}/buy. If this MCP request carries a valid "x-api-key" or "Authorization: Bearer" header, it renders directly and returns a 1-hour download URL; otherwise it returns purchase guidance.`,
      inputSchema: {
        type: 'object',
        properties: {
          url: str('Absolute http(s) URL of the page to capture. Required.'),
          fullPage: bool('Capture the full scrollable page, not just the viewport. Default true.'),
          format: { type: 'string', enum: ['png', 'jpeg'], description: 'Image format. Default png.' },
          quality: num('JPEG quality 0-1. Ignored for png. Default 0.8.'),
          ...NAV_PROPS,
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
    {
      name: 'url_to_markdown',
      kind: 'paid',
      renderKind: 'markdown',
      endpoint: eps['POST /tools/url-to-markdown']?.url,
      description: `Extract page content as clean Markdown. Requires an API key purchased at ${origin}/buy. If this MCP request carries a valid "x-api-key" or "Authorization: Bearer" header, it renders directly and returns a 1-hour download URL; otherwise it returns purchase guidance.`,
      inputSchema: {
        type: 'object',
        properties: {
          url: str('Absolute http(s) URL of the page to extract. Required.'),
          removeSelectors: {
            type: 'array',
            items: { type: 'string' },
            description: 'CSS selectors to strip before extraction, e.g. ["nav", ".ads", "footer"].',
          },
          keepImages: bool('Keep image links in the Markdown output. Default false.'),
          ...NAV_PROPS,
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
  ]
}

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Only POST is supported on /mcp', { status: 405 })
  }

  // 取 key 并校验一次，付费工具执行层复用（DISABLE_PAYWALL 时视为已授权，便于本地自测）
  const authed =
    paywallDisabled(env) || (await validateApiKey(env, extractApiKey(request)))

  let body: Json
  try {
    body = (await request.json()) as Json
  } catch {
    return rpcErr(null, -32700, 'Parse error')
  }

  const id = body.id ?? null
  const method = String(body.method ?? '')
  const params = (body.params ?? {}) as Json

  switch (method) {
    case 'initialize':
      return rpcOk(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'url-to-pdf', version: '0.2.0' },
      })

    case 'notifications/initialized':
      return new Response(null, { status: 202 })

    case 'tools/list':
      return rpcOk(id, {
        tools: buildTools(env).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      })

    case 'tools/call':
      return await callTool(id, String(params.name ?? ''), (params.arguments ?? {}) as Json, env, authed)

    case 'ping':
      return rpcOk(id, {} as Json)

    default:
      return rpcErr(id, -32601, `Method not found: ${method}`)
  }
}

async function callTool(
  id: unknown,
  name: string,
  args: Json,
  env: Env,
  authed: boolean,
): Promise<Response> {
  const tool = buildTools(env).find((t) => t.name === name)
  if (!tool) return rpcErr(id, -32602, `Unknown tool: ${name}`)

  if (tool.kind === 'free') {
    if (name !== 'list_capabilities') return rpcErr(id, -32602, `Unknown tool: ${name}`)

    const origin = srvOrigin(env)
    return rpcOk(id, {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              service: 'url-to-pdf',
              payment: {
                protocol: 'api_key',
                buyUrl: `${origin}/buy`,
                note: 'Purchase an API key at /buy (Paddle checkout). Present it as "x-api-key: <key>" or "Authorization: Bearer <key>" when calling the HTTP endpoints.',
              },
              paidEndpoints: listPaidEndpoints(env).map((e) => ({
                tool: e.route.replace('POST /tools/', '').replace(/-/g, '_'),
                price: e.price,
                httpMethod: 'POST',
                httpUrl: e.url,
                description: e.description,
                body: 'Same arguments as the MCP tool, sent as JSON.',
              })),
            },
            null,
            2,
          ),
        },
      ],
    })
  }

  // 付费工具：未授权只返回购买引导；已授权则直接渲染并返回下载链接
  const origin = srvOrigin(env)
  if (!authed || !tool.renderKind) {
    return rpcOk(id, {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              error: 'api_key_required',
              tool: name,
              buyUrl: `${origin}/buy`,
              howToPay: `Buy an API key at ${origin}/buy, then call this tool with a valid "x-api-key" / "Authorization: Bearer" header (or POST ${tool.endpoint} with that header).`,
              argumentsEcho: args,
            },
            null,
            2,
          ),
        },
      ],
    })
  }

  try {
    const out = await renderAndStore(env, tool.renderKind, args as Record<string, any>, origin)
    return rpcOk(id, {
      content: [
        {
          type: 'text',
          text: JSON.stringify(out, null, 2),
        },
      ],
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return rpcOk(id, {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: 'render_failed', detail }, null, 2),
        },
      ],
    })
  }
}

function rpcOk(id: unknown, result: Json) {
  return Response.json({ jsonrpc: '2.0', id, result })
}

function rpcErr(id: unknown, code: number, message: string) {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message } })
}
