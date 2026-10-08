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
}

export interface RenderResult {
  body: Uint8Array
  contentType: string
  ext: string
  title: string
  meta: Record<string, unknown>
}

export interface BrowserEnv {
  BROWSER: Fetcher
}

export type Kind = 'pdf' | 'screenshot' | 'markdown'

const MAX_ASSET_BYTES = 25 * 1024 * 1024 // KV 单值上限，超出直接拒
const FILE_TTL_SECONDS = 3600

const MAX_HTML_BYTES = 5 * 1024 * 1024

async function withPage<T>(
  env: BrowserEnv,
  rawUrl: string,
  opts: NavigateOptions,
  fn: (page: import('@cloudflare/puppeteer').Page) => Promise<T>,
): Promise<T> {
  const target = assertPublicUrl(rawUrl)

  const browser = await puppeteer.launch(env.BROWSER)
  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1280, height: 900 })
    await page.setUserAgent(USER_AGENT)
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' })

    if (opts.blockMedia) {
      await page.setRequestInterception(true)
      page.on('request', (req) => {
        const type = req.resourceType()
        if (type === 'media' || type === 'font') req.abort().catch(() => {})
        else req.continue().catch(() => {})
      })
    }

    await page.goto(target.toString(), {
      waitUntil: opts.waitUntil ?? 'networkidle2',
      timeout: 45_000,
    })

    if (opts.waitForSelector) {
      await page.waitForSelector(opts.waitForSelector, { timeout: 15_000 }).catch(() => {
        // 选择器没出现不该让整个调用失败 —— 页面可能本来就没有那个元素
      })
    }
    // 新版 @cloudflare/puppeteer 已经移除了 page.waitForTimeout，这里直接用 timer
    if (opts.waitMs && opts.waitMs > 0 && opts.waitMs <= 10_000) {
      await new Promise<void>((resolve) => setTimeout(resolve, opts.waitMs))
    }

    return await fn(page)
  } finally {
    await browser.close()
  }
}

export async function renderPdf(
  env: BrowserEnv,
  args: Record<string, any>,
): Promise<RenderResult> {
  return withPage(env, args.url, args, async (page) => {
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
    }
  })
}

export async function renderScreenshot(
  env: BrowserEnv,
  args: Record<string, any>,
): Promise<RenderResult> {
  return withPage(env, args.url, args, async (page) => {
    const title = await page.title()
    const full = args.fullPage !== false
    const isJpeg = args.format === 'jpeg'
    const buf = await page.screenshot({
      type: isJpeg ? 'jpeg' : 'png',
      fullPage: full,
      ...(isJpeg ? { quality: clampNumber(Math.round((args.quality ?? 0.8) * 100), 1, 100, 80) } : {}),
    })
    const dims = page.viewport()
    return {
      body: new Uint8Array(buf),
      contentType: isJpeg ? 'image/jpeg' : 'image/png',
      ext: isJpeg ? 'jpg' : 'png',
      title,
      meta: { fullPage: full, viewportWidth: dims?.width ?? 1280 },
    }
  })
}

export async function renderMarkdown(
  env: BrowserEnv,
  args: Record<string, any>,
): Promise<RenderResult> {
  return withPage(env, args.url, { ...args, blockMedia: true }, async (page) => {
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
    }
  })
}

function clampNumber(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

export interface StoredArtifact {
  downloadUrl: string
  contentType: string
  sizeBytes: number
  title: string
  ttlSeconds: number
  meta: Record<string, unknown>
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
  const result = await RENDERERS[kind](env, args)

  if (result.body.byteLength > MAX_ASSET_BYTES) {
    throw new GuardError(
      'Result exceeds the 25MB KV limit. Try a smaller page or switch ASSETS to R2.',
    )
  }

  const key = `${kind}/${crypto.randomUUID()}.${result.ext}`
  await env.ASSETS.put(key, result.body, {
    metadata: {
      contentType: result.contentType,
      createdAt: String(Date.now()),
      sourceUrl: String(args.url ?? ''),
      kind,
    },
    expirationTtl: FILE_TTL_SECONDS,
  })

  return {
    downloadUrl: `${origin}/f/${key}`,
    contentType: result.contentType,
    sizeBytes: result.body.byteLength,
    title: result.title,
    ttlSeconds: FILE_TTL_SECONDS,
    meta: result.meta,
  }
}

// RENDERERS 必须在文件底部引用（renderPdf/Screenshot/Markdown 在上面定义），这里聚合。
const RENDERERS: Record<Kind, (env: Env, args: Record<string, any>) => Promise<RenderResult>> = {
  pdf: renderPdf,
  screenshot: renderScreenshot,
  markdown: renderMarkdown,
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
