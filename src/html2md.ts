const DROP_TAGS = /<(script|style|noscript|iframe|svg|canvas|template|form)\b[\s\S]*?<\/\1>/gi
const COMMENTS = /<!--[\s\S]*?-->/g
const SPLIT = /<\/?(p|div|br|tr|h[1-6]|li|blockquote|table|pre|section|article)\b[^>]*>/gi
const TAGS = /<[^>]+>/g

const ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&mdash;': '—',
  '&ndash;': '–',
  '&hellip;': '…',
}

function decode(s: string): string {
  return s.replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m.toLowerCase()] ?? m)
}

function stripTagsPreservingStructure(html: string): string {
  return html
    .replace(DROP_TAGS, '')
    .replace(COMMENTS, '')
    .replace(SPLIT, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(h[1-6])>/gi, '\n')
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, n) => '\n' + '#'.repeat(Number(n)) + ' ')
    .replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, t) => `**${t}**`)
    .replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, t) => `*${t}*`)
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, text) => `[${text}](${href})`)
    .replace(/<img\b[^>]*src=["']([^"']+)["'][^>]*alt=["']([^"']*)["'][^>]*>/gi, (_m, src, alt) => `![${alt}](${src})`)
    .replace(/<img\b[^>]*alt=["']([^"']*)["'][^>]*src=["']([^"']+)["'][^>]*>/gi, (_m, alt, src) => `![${alt}](${src})`)
    .replace(/<img\b[^>]*src=["']([^"']+)["'][^>]*>/gi, (_m, src) => `![](${src})`)
    .replace(/<pre\b[^>]*>/gi, '\n```\n')
    .replace(/<\/pre>/gi, '\n```\n')
    .replace(TAGS, '')
}

/**
 * 轻量 HTML → Markdown。故意不引入 Readability / turndown —— 那些包要么依赖 DOM，
 * 要么体积太大，在 Workers 环境里不划算。够用就行。
 */
export function htmlToMarkdown(html: string, opts: { keepImages?: boolean } = {}): string {
  let out = stripTagsPreservingStructure(html)
  out = decode(out)
  if (!opts.keepImages) {
    out = out.replace(/!\[[^\]]*\]\([^)]+\)/g, '')
  }

  const lines = out.split('\n')
  const result: string[] = []
  let blank = false

  for (const raw of lines) {
    const line = raw.replace(/[ \t]+/g, ' ').trim()
    if (line.length === 0) {
      if (!blank) result.push('')
      blank = true
      continue
    }
    blank = false
    result.push(line)
  }

  const text = result.join('\n').replace(/\n{3,}/g, '\n\n').trim()
  return text.replace(/([ \t]+$)/gm, '')
}
