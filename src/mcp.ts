import type { Env } from './env'
import { listPaidEndpoints, extractApiKey, validateApiKey, paywallDisabled } from './pay'
import { checkRateLimit } from './limit'
import { renderAndStore, BusyError, type Kind } from './render'

/**
 * MCP 层只做「发现」，HTTP 层负责「成交」。
 *
 * 分工原因：付费是 API key 模型——用户先去 /buy 通过 Paddle 买 key，
 * 之后调用 /tools/* 时带 x-api-key。MCP 这边把工具的 HTTP 端点暴露出来，
 * 付费工具在 tools/call 时返回引导（去哪买、怎么带 key），由 agent 自己去打 HTTP 端点。
 *
 * 传输层：2025-06-18 Streamable HTTP（POST 收发 JSON-RPC、GET 开 SSE 流、DELETE 结束会话）。
 * initialize 后回 Mcp-Session-Id；支持 SSE 响应；CORS 头由 corsHeaders() 统一附加。
 * 本 Worker 无状态，session id 仅用于满足协议握手，不依赖服务端存储。
 */

const PROTOCOL_VERSION = '2025-06-18'
const SERVER_VERSION = '0.2.0'
const SESSION_HEADER = 'mcp-session-id'

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

// ---------------------------------------------------------------- 协议响应辅助

export function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type, Authorization, x-api-key, Mcp-Session-Id, mcp-protocol-version',
  }
}

function withSession(sid: string, extra: Record<string, string> = {}): Record<string, string> {
  const h: Record<string, string> = { ...extra }
  if (sid) h[SESSION_HEADER] = sid
  return h
}

interface RpcReturn {
  id: unknown
  result?: Json
  error?: { code: number; message: string }
  sessionId?: string
}

function makeResponse(id: unknown, result: Json, sessionId?: string): RpcReturn {
  return { id, result, sessionId }
}

function makeError(id: unknown, code: number, message: string): RpcReturn {
  return { id, error: { code, message } }
}

/** 把 RPC 结果序列化；若客户端 Accept 含 text/event-stream 则用 SSE 回，否则 JSON。 */
function serialize(ret: RpcReturn, accept: string, sid: string): Response {
  const body = ret.error
    ? { jsonrpc: '2.0', id: ret.id, error: ret.error }
    : { jsonrpc: '2.0', id: ret.id, result: ret.result }
  const headers = withSession(sid, corsHeaders())

  if (accept.toLowerCase().includes('text/event-stream')) {
    const data = JSON.stringify(body)
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${data}\n\n`))
        controller.close()
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', ...headers },
    })
  }
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  })
}

// ---------------------------------------------------------------- 会话生命周期（GET SSE / DELETE）

function sseStream(sid: string): Response {
  const encoder = new TextEncoder()
  let timer: ReturnType<typeof setInterval> | undefined
  const stream = new ReadableStream({
    start(controller) {
      const c = controller as ReadableStreamDefaultController
      c.enqueue(encoder.encode(': connected\n\n'))
      timer = setInterval(() => {
        try {
          c.enqueue(encoder.encode(': heartbeat\n\n'))
        } catch {
          if (timer) clearInterval(timer)
        }
      }, 15000)
    },
    cancel() {
      if (timer) clearInterval(timer)
    },
  })
  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      ...withSession(sid, corsHeaders()),
    },
  })
}

// ---------------------------------------------------------------- 入口：按 HTTP 方法分发

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  const method = request.method
  const accept = request.headers.get('accept') || ''
  const sessionId = request.headers.get(SESSION_HEADER) || ''

  if (method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() })
  }
  if (method === 'DELETE') {
    return new Response(null, { status: 204, headers: withSession(sessionId, corsHeaders()) })
  }
  if (method === 'GET') {
    return sseStream(sessionId)
  }
  if (method !== 'POST') {
    return new Response('Method not allowed', {
      status: 405,
      headers: withSession(sessionId, corsHeaders()),
    })
  }

  let raw: string
  try {
    raw = await request.text()
  } catch {
    return serialize(makeError(null, -32700, 'Failed to read body'), accept, sessionId)
  }

  let parsed: any
  try {
    parsed = JSON.parse(raw)
  } catch {
    return serialize(makeError(null, -32700, 'Parse error'), accept, sessionId)
  }

  // 批量请求
  if (Array.isArray(parsed)) {
    const out: Json[] = []
    for (const msg of parsed) {
      const r = await dispatch(msg, request, env)
      if (r !== null) out.push(rpcWire(r))
    }
    const payload = out.length
      ? out
      : ({ jsonrpc: '2.0', id: null, result: {} } as unknown as Json)
    return serializeEnvelope(payload, accept, sessionId)
  }

  const r = await dispatch(parsed, request, env)
  if (r === null) {
    // 通知（无 id）→ 202 Accepted
    return new Response(null, {
      status: 202,
      headers: withSession(sessionId, corsHeaders()),
    })
  }
  return serialize(r, accept, r.sessionId ?? sessionId)
}

/** 把 RpcReturn 转成线上 JSON-RPC wire 对象 */
function rpcWire(r: RpcReturn): Json {
  return r.error
    ? ({ jsonrpc: '2.0', id: r.id, error: r.error } as unknown as Json)
    : ({ jsonrpc: '2.0', id: r.id, result: r.result } as unknown as Json)
}

/** 批量/枚举时直接包一层统一响应 */
function serializeEnvelope(payload: Json | Json[], accept: string, sid: string): Response {
  const headers = withSession(sid, corsHeaders())
  if (accept.toLowerCase().includes('text/event-stream')) {
    const data = JSON.stringify(payload)
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${data}\n\n`))
        controller.close()
      },
    })
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', ...headers },
    })
  }
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  })
}

// ---------------------------------------------------------------- 单条消息分发

async function dispatch(msg: any, request: Request, env: Env): Promise<RpcReturn | null> {
  const id = msg?.id ?? null
  const m = String(msg?.method ?? '')
  const params = (msg?.params ?? {}) as Json

  switch (m) {
    case 'initialize': {
      const sid = crypto.randomUUID()
      return makeResponse(
        id,
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'url-to-pdf', version: SERVER_VERSION },
        },
        sid,
      )
    }
    case 'notifications/initialized':
      return null
    case 'ping':
      return makeResponse(id, {} as Json)
    case 'tools/list':
      return makeResponse(id, {
        tools: buildTools(env).map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      })
    case 'tools/call': {
      const apiKey = extractApiKey(request)
      const authed = paywallDisabled(env) || (await validateApiKey(env, apiKey))
      // 按 key 限流：付费工具通过鉴权后再检查每日/每分钟额度
      const rl = await checkRateLimit(env, authed ? apiKey : null)
      if (authed && !rl.ok) {
        return makeResponse(id, {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  error: rl.code,
                  message: rl.message,
                  retryAfterSeconds: rl.retryAfterSeconds,
                },
                null,
                2,
              ),
            },
          ],
        })
      }
      return await callTool(id, String(params.name ?? ''), (params.arguments ?? {}) as Json, env, authed)
    }
    default:
      return makeError(id, -32601, `Method not found: ${m}`)
  }
}

// ---------------------------------------------------------------- 工具执行

async function callTool(
  id: unknown,
  name: string,
  args: Json,
  env: Env,
  authed: boolean,
): Promise<RpcReturn> {
  const tool = buildTools(env).find((t) => t.name === name)
  if (!tool) return makeError(id, -32602, `Unknown tool: ${name}`)

  if (tool.kind === 'free') {
    if (name !== 'list_capabilities') return makeError(id, -32602, `Unknown tool: ${name}`)

    const origin = srvOrigin(env)
    return makeResponse(id, {
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

  const origin = srvOrigin(env)
  if (!authed || !tool.renderKind) {
    return makeResponse(id, {
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
    return makeResponse(id, {
      content: [
        {
          type: 'text',
          text: JSON.stringify(out, null, 2),
        },
      ],
    })
  } catch (err) {
    if (err instanceof BusyError) {
      return makeResponse(id, {
        isError: true,
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                error: 'busy',
                detail: 'Rendering capacity is momentarily saturated.',
                retryAfterSeconds: err.retryAfterSeconds,
                hint: 'Wait a few seconds and call this tool again.',
              },
              null,
              2,
            ),
          },
        ],
      })
    }
    const detail = err instanceof Error ? err.message : String(err)
    return makeResponse(id, {
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
