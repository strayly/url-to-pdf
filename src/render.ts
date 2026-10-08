import puppeteer from '@cloudflare/puppeteer'
import { assertPublicUrl, GuardError } from './guard'
import { htmlToMarkdown } from './html2md'
import type { Env } from './env'

export const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export type GotoMode = 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2'

export interface NavigateOptions {
  waitUntil?: GotoMode
  waitForSelector?: string
  waitMs?: number
  blockMedia?: boolean
  /** 拦截主流广告/追踪域名，页面更干净、渲染更快 */
  blockAds?: boolean
  /** 移除页面上疑似 cookie 同意横幅的元素 */
  hideCookieBanners?: boolean
  /** 让页面以 prefers-color-scheme: dark 渲染 */
  darkMode?: boolean
  /** 渲染前先点击这个选择器（展开折叠、关弹窗、切 tab） */
  clickSelector?: string
  /** 导航超时，5-100s，默认 45s */
  timeoutMs?: number
}

export interface RenderResult {
  body: Uint8Array
  contentType: string
  ext: string
  title: string
  meta: Record<string, unknown>
  /** 重定向之后的最终 URL —— receipt 需要 */
  finalUrl: string
  /** 主文档 HTTP 状态码，取不到时为 null */
  httpStatus: number | null
}

export interface BrowserEnv {
  BROWSER: Fetcher
}

export type Kind = 'pdf' | 'screenshot' | 'markdown' | 'extract'

const MAX_ASSET_BYTES = 25 * 1024 * 1024 // KV 单值上限，超出直接拒
const FILE_TTL_SECONDS = 3600

const MAX_HTML_BYTES = 5 * 1024 * 1024

/**
 * 启动浏览器，对「并发被限流」做有限重试。
 * Browser Rendering 在高并发/免费额度下会抛
 * `Unable to create new browser: code: 429: message: Rate limit exceeded`，
 * 这是瞬时的，等一两秒再试通常就能拿到实例 —— 付费调用不该因这个直接失败。
 */
const LAUNCH_ATTEMPTS = 3
const LAUNCH_BACKOFF_MS = 1500
const RETRYABLE_RE = /rate limit|429|too many|busy|try again/i

/** 渲染容量暂时耗尽（并发/新建实例被限流）。调用方应回 429 让客户稍后重试。 */
export class BusyError extends Error {
  readonly retryAfterSeconds: number
  constructor(message: string, retryAfterSeconds = 20) {
    super(message)
    this.name = 'BusyError'
    this.retryAfterSeconds = retryAfterSeconds
  }
}

async function launchBrowser(env: BrowserEnv) {
  for (let attempt = 1; attempt <= LAUNCH_ATTEMPTS; attempt++) {
    try {
      return await puppeteer.launch(env.BROWSER)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!RETRYABLE_RE.test(msg)) throw err
      if (attempt === LAUNCH_ATTEMPTS) throw new BusyError(msg)
      await new Promise<void>((r) => setTimeout(r, LAUNCH_BACKOFF_MS * attempt))
    }
  }
  // 循环要么 return 要么 throw，这里只是让类型收敛
  throw new BusyError('browser unavailable')
}

/** 广告/追踪域名黑名单。只拦明显是广告的第三方，不拦站自己的资源。 */
const AD_HOST_PARTS = [
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'googletagmanager.com',
  'google-analytics.com',
  'adservice.google.com',
  'amazon-adsystem.com',
  'criteo.com',
  'outbrain.com',
  'taboola.com',
  'adsrvr.org',
  'adnxs.com',
  'pubmatic.com',
  'rubiconproject.com',
  'facebook.net',
  'scorecardresearch.com',
  'quantserve.com',
]

/** 移除疑似 cookie 同意横幅的元素。跑在页面上下文里，故意写得宽一点。 */
const COOKIE_BANNER_SELECTOR =
  '[id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i], ' +
  '[id*="gdpr" i], [class*="gdpr" i], [aria-label*="cookie" i], [aria-label*="consent" i]'

interface PageInfo {
  finalUrl: string
  httpStatus: number | null
}

async function withPage<T>(
  env: BrowserEnv,
  rawUrl: string,
  opts: NavigateOptions,
  fn: (page: import('@cloudflare/puppeteer').Page, info: PageInfo) => Promise<T>,
): Promise<T> {
  const target = assertPublicUrl(rawUrl)

  const browser = await launchBrowser(env)
  try {
    const page = await browser.newPage()
    await page.setViewport({
      width: clampInt((opts as any).width, 320, 3840, 1280),
      height: clampInt((opts as any).height, 240, 2160, 900),
      deviceScaleFactor: clampNumber((opts as any).deviceScaleFactor, 0.5, 3, 1),
    })
    await page.setUserAgent(USER_AGENT)
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' })

    // dark_mode：让站点自己的深色 CSS 生效，而不是我们后期调色
    if (opts.darkMode) {
      await page
        .emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'dark' }])
        .catch(() => {})
    }

    // 拦截只开一次，把 media / font / 广告 三种过滤合在同一个 handler 里，
    // 否则后开的 setRequestInterception 会覆盖先开的。
    if (opts.blockMedia || opts.blockAds) {
      await page.setRequestInterception(true)
      page.on('request', (req) => {
        try {
          const type = req.resourceType()
          if (opts.blockMedia && (type === 'media' || type === 'font')) {
            req.abort().catch(() => {})
            return
          }
          if (opts.blockAds) {
            const host = new URL(req.url()).hostname.toLowerCase()
            if (AD_HOST_PARTS.some((p) => host === p || host.endsWith('.' + p))) {
              req.abort().catch(() => {})
              return
            }
          }
          req.continue().catch(() => {})
        } catch {
          req.continue().catch(() => {})
        }
      })
    }

    const response = await page.goto(target.toString(), {
      waitUntil: opts.waitUntil ?? 'networkidle2',
      timeout: clampInt(opts.timeoutMs, 5_000, 100_000, 45_000),
    })

    if (opts.waitForSelector) {
      await page.waitForSelector(opts.waitForSelector, { timeout: 15_000 }).catch(() => {
        // 选择器没出现不该让整个调用失败 —— 页面可能本来就没有那个元素
      })
    }

    // 点击后再渲染：展开折叠内容、关掉弹窗、切到某个 tab
    if (opts.clickSelector) {
      await page.click(opts.clickSelector, { delay: 30 }).catch(() => {})
      await page.waitForNetworkIdle?.({ timeout: 5_000 }).catch(() => {})
    }

    if (opts.hideCookieBanners) {
      await page
        .evaluate((s: string) => {
          const doc = (globalThis as any).document
          if (doc) doc.querySelectorAll(s).forEach((el: any) => el.remove())
        }, COOKIE_BANNER_SELECTOR)
        .catch(() => {})
    }

    // 新版 @cloudflare/puppeteer 已经移除了 page.waitForTimeout，这里直接用 timer
    if (opts.waitMs && opts.waitMs > 0 && opts.waitMs <= 10_000) {
      await new Promise<void>((resolve) => setTimeout(resolve, opts.waitMs))
    }

    return await fn(page, {
      finalUrl: page.url(),
      httpStatus: response?.status() ?? null,
    })
  } finally {
    await browser.close()
  }
}

export async function renderPdf(
  env: BrowserEnv,
  args: Record<string, any>,
): Promise<RenderResult> {
  return withPage(env, args.url, args, async (page, info) => {
    const title = await page.title()
    const buf = await page.pdf({
      format: args.format ?? 'A4',
      landscape: Boolean(args.landscape),
      printBackground: args.printBackground !== false,
      scale: clampNumber(args.scale, 0.1, 2, 1),
      preferCSSPageSize: Boolean(args.preferCssPageSize),
      margin: normalizeMargin(args.margin),
    })
    return {
      body: new Uint8Array(buf),
      contentType: 'application/pdf',
      ext: 'pdf',
      title,
      meta: { format: args.format ?? 'A4', landscape: Boolean(args.landscape) },
      finalUrl: info.finalUrl,
      httpStatus: info.httpStatus,
    }
  })
}

export async function renderScreenshot(
  env: BrowserEnv,
  args: Record<string, any>,
): Promise<RenderResult> {
  return withPage(env, args.url, args, async (page, info) => {
    const title = await page.title()
    const isJpeg = args.format === 'jpeg'
    // selector 优先：截单个元素时 fullPage 没有意义
    const selector = typeof args.selector === 'string' ? args.selector.trim() : ''
    const clip = normalizeClip(args.clip)
    const full = args.fullPage !== false && !selector && !clip
    const shotOpts: Record<string, unknown> = {
      type: isJpeg ? 'jpeg' : 'png',
      fullPage: full,
      ...(isJpeg ? { quality: clampNumber(Math.round((args.quality ?? 0.8) * 100), 1, 100, 80) } : {}),
      ...(clip ? { clip } : {}),
    }

    // @cloudflare/puppeteer 的 screenshot 声明成 Uint8Array | string（base64），
    // 这里统一归一成字节，避免把 base64 字符串当二进制存进 KV。
    const shot = selector
      ? await (await page.$(selector))?.screenshot(shotOpts as any)
      : await page.screenshot(shotOpts as any)
    if (!shot) throw new GuardError(selector ? `selector not found: ${selector}` : 'capture failed')
    const buf = typeof shot === 'string' ? decodeBase64ToBytes(shot) : new Uint8Array(shot)

    const dims = page.viewport()
    return {
      body: new Uint8Array(buf),
      contentType: isJpeg ? 'image/jpeg' : 'image/png',
      ext: isJpeg ? 'jpg' : 'png',
      title,
      meta: {
        fullPage: full,
        viewportWidth: dims?.width ?? 1280,
        viewportHeight: dims?.height ?? 900,
        ...(selector ? { selector } : {}),
        ...(clip ? { clip } : {}),
      },
      finalUrl: info.finalUrl,
      httpStatus: info.httpStatus,
    }
  })
}

export async function renderMarkdown(
  env: BrowserEnv,
  args: Record<string, any>,
): Promise<RenderResult> {
  return withPage(env, args.url, { ...args, blockMedia: true }, async (page, info) => {
    const title = await page.title()

    if (Array.isArray(args.removeSelectors) && args.removeSelectors.length > 0) {
      const sel = args.removeSelectors.join(', ')
      // evaluate 的回调跑在页面上下文里，编译期拿不到 DOM 类型，这里显式走 any
      await page
        .evaluate((s: string) => {
          const doc = (globalThis as any).document
          if (doc) doc.querySelectorAll(s).forEach((el: any) => el.remove())
        }, sel)
        .catch(() => {})
    }

    const html = await page.content()
    if (html.length > MAX_HTML_BYTES) {
      throw new GuardError('page too large to convert')
    }
    const markdown = htmlToMarkdown(html, { keepImages: Boolean(args.keepImages) })

    return {
      body: new TextEncoder().encode(markdown),
      contentType: 'text/markdown; charset=utf-8',
      ext: 'md',
      title,
      meta: { wordCount: markdown.split(/\s+/).filter(Boolean).length },
      finalUrl: info.finalUrl,
      httpStatus: info.httpStatus,
    }
  })
}

/**
 * 结构化抽取：标题、描述、canonical、语言、正文、链接。
 * 纯 DOM 解析、不调 LLM。浏览器已经开起来了，这一步几乎不增加成本。
 * 浏览器已经开起来了，这一步几乎不增加成本。
 */
export async function renderExtract(
  env: BrowserEnv,
  args: Record<string, any>,
): Promise<RenderResult> {
  return withPage(env, args.url, { ...args, blockMedia: true }, async (page, info) => {
    const data = await page.evaluate((maxChars: number, maxLinks: number) => {
      const doc = (globalThis as any).document
      const q = (s: string) => doc?.querySelector(s) ?? null
      // 编译期拿不到 DOM 全局，用 baseURI 而不是 location.href 做相对地址基准
      const base = (doc?.baseURI as string) ?? ''
      const abs = (href: string) => {
        try {
          return new URL(href, base).toString()
        } catch {
          return href
        }
      }
      const metaByName = (n: string) => q(`meta[name="${n}"]`)?.getAttribute('content') ?? null
      const metaByProp = (n: string) => q(`meta[property="${n}"]`)?.getAttribute('content') ?? null

      const links: { href: string; text: string | null }[] = []
      for (const a of Array.from(doc?.querySelectorAll('a[href]') ?? []).slice(0, maxLinks)) {
        const el = a as any
        const href = abs(el.getAttribute('href'))
        if (!/^https?:/i.test(href)) continue
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200)
        links.push({ href, text: text || null })
      }

      const main =
        q('article') || q('main') || q('[role="main"]') || q('#content') || doc?.body || null

      return {
        title: doc?.title ?? null,
        metaDescription: metaByName('description') ?? metaByProp('og:description') ?? null,
        canonical: q('link[rel="canonical"]')?.getAttribute('href') ?? null,
        language: doc?.documentElement?.getAttribute('lang') ?? null,
        text: ((main as any)?.innerText ?? '').replace(/\n{3,}/g, '\n\n').slice(0, maxChars),
        links,
      }
    }, clampInt(args.maxTextChars, 500, 200_000, 20_000), clampInt(args.maxLinks, 0, 500, 100))

    const payload = {
      ok: true,
      ...data,
      finalUrl: info.finalUrl,
      textLength: data.text.length,
      linkCount: data.links.length,
    }

    return {
      body: new TextEncoder().encode(JSON.stringify(payload, null, 2)),
      contentType: 'application/json; charset=utf-8',
      ext: 'json',
      title: data.title ?? '',
      meta: { linkCount: data.links.length, textLength: data.text.length },
      finalUrl: info.finalUrl,
      httpStatus: info.httpStatus,
    }
  })
}

function clampNumber(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  return Math.round(clampNumber(v, min, max, fallback))
}

/** clip 接受 "x,y,width,height" 字符串或 {x,y,width,height} 对象 */
function normalizeClip(
  c: any,
): { x: number; y: number; width: number; height: number } | undefined {
  if (!c) return undefined
  let o = c
  if (typeof c === 'string') {
    const parts = c.split(',').map((s: string) => Number(s.trim()))
    if (parts.length !== 4 || parts.some((n: number) => !Number.isFinite(n))) return undefined
    o = { x: parts[0], y: parts[1], width: parts[2], height: parts[3] }
  }
  const x = Number(o.x)
  const y = Number(o.y)
  const width = Number(o.width)
  const height = Number(o.height)
  if (![x, y, width, height].every(Number.isFinite)) return undefined
  if (width <= 0 || height <= 0) return undefined
  return { x, y, width, height }
}

/** 超过这个体积就不内联了 —— MCP 消息太大会拖垮客户端，仍然给 downloadUrl */
const INLINE_MAX_BYTES = 1024 * 1024

/**
 * Uint8Array → base64。必须分块：一次性 String.fromCharCode(…1e6 个参数)
 * 会直接把调用栈打爆（btoa 也一样吃不下整块字符串）。
 */
function toBase64(body: Uint8Array): string {
  const CHUNK = 0x8000
  let bin = ''
  for (let i = 0; i < body.length; i += CHUNK) {
    const slice = body.subarray(i, Math.min(i + CHUNK, body.length))
    let part = ''
    for (let j = 0; j < slice.length; j++) part += String.fromCharCode(slice[j])
    bin += part
  }
  return btoa(bin)
}

/** 把 puppeteer 可能返回的 base64 字符串还原成字节 */
function decodeBase64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function sha256Hex(body: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', body as BufferSource)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export interface StoredArtifact {
  downloadUrl: string
  contentType: string
  sizeBytes: number
  title: string
  ttlSeconds: number
  meta: Record<string, unknown>
  /**
   * 渲染回执。每次调用都带上：这份产物是从哪个 URL、什么时候、多大、什么哈希抓下来的。
   * 让 agent 能引用（"这是 10:23 抓的版本"），也让争议时可核对。
   */
  receipt: {
    renderId: string
    url: string
    finalUrl: string
    capturedAt: string
    durationMs: number
    bytes: number
    sha256: string
    format: string
    httpStatus: number | null
  }
  /**
   * 小产物直接内联。只给 downloadUrl 的话模型等于瞎子：它拿不到内容，只能把链接再念一遍。
   * 1MB 以内的产物直接塞进 MCP content，客户端当场就能显示/引用。
   */
  inline?: {
    base64: string
    mimeType: string
  }
}

/**
 * 渲染 + 落 KV + 返回下载信息。HTTP 路由 (/tools/*) 和 MCP 执行层 (tools/call)
 * 共用这一份，保证两条入口行为一致。SSRF 已在 withPage 内部 assertPublicUrl 拦截。
 */
export async function renderAndStore(
  env: Env,
  kind: Kind,
  args: Record<string, any>,
  origin: string,
): Promise<StoredArtifact> {
  const startedAt = Date.now()
  const result = await RENDERERS[kind](env, args)

  if (result.body.byteLength > MAX_ASSET_BYTES) {
    throw new GuardError(
      'Result exceeds the 25MB KV limit. Try a smaller page or switch ASSETS to R2.',
    )
  }

  const renderId = crypto.randomUUID()
  const key = `${kind}/${renderId}.${result.ext}`
  const inline =
    result.body.byteLength <= INLINE_MAX_BYTES
      ? { base64: toBase64(result.body), mimeType: result.contentType }
      : undefined

  const [sha256] = await Promise.all([
    sha256Hex(result.body),
    env.ASSETS.put(key, result.body, {
      metadata: {
        contentType: result.contentType,
        createdAt: String(Date.now()),
        sourceUrl: String(args.url ?? ''),
        kind,
      },
      expirationTtl: FILE_TTL_SECONDS,
    }),
  ])

  return {
    downloadUrl: `${origin}/f/${key}`,
    contentType: result.contentType,
    sizeBytes: result.body.byteLength,
    title: result.title,
    ttlSeconds: FILE_TTL_SECONDS,
    meta: result.meta,
    receipt: {
      renderId,
      url: String(args.url ?? ''),
      finalUrl: result.finalUrl,
      capturedAt: new Date(startedAt).toISOString(),
      durationMs: Date.now() - startedAt,
      bytes: result.body.byteLength,
      sha256,
      format: result.ext,
      httpStatus: result.httpStatus,
    },
    ...(inline ? { inline } : {}),
  }
}

// RENDERERS 必须在文件底部引用（renderPdf/Screenshot/Markdown 在上面定义），这里聚合。
const RENDERERS: Record<Kind, (env: Env, args: Record<string, any>) => Promise<RenderResult>> = {
  pdf: renderPdf,
  screenshot: renderScreenshot,
  markdown: renderMarkdown,
  extract: renderExtract,
}

function normalizeMargin(
  m: any,
): { top: string; right: string; bottom: string; left: string } | undefined {
  if (!m) return undefined
  if (typeof m === 'string') return { top: m, right: m, bottom: m, left: m }
  return {
    top: m.top ?? '12mm',
    right: m.right ?? '12mm',
    bottom: m.bottom ?? '12mm',
    left: m.left ?? '12mm',
  }
}
