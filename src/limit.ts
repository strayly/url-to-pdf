/**
 * 按 API key 的限流层 —— 防止单个付费用户把共享的 Cloudflare Browser Rendering
 * 免费额度（每天约 10 分钟浏览器时长、每分钟约 2 个实例）吃光，拖垮其他所有人。
 *
 * 两层：
 *  1) 每日额度（DAILY_LIMIT，默认 50）—— 控制一个 key 每天的渲染总次数。
 *  2) 每分钟突发上限（PER_MIN_LIMIT，默认 10）—— 控制一个 key 的并发/突发速率，
 *     避免一次起 10 个浏览器去撞免费档的「每分钟 ~2 实例」硬墙。
 *
 * 计数存在 KV，key 形如 `rl:<key>:<UTC日期>` / `rlm:<key>:<UTC分钟>`，带 TTL 自动清理，
 * 无需定时任务。KV 最终一致，软上限可能多放行几次，对限流场景无碍。
 * 写入失败按「放行」处理（fail open），不影响正常渲染。
 */

import type { Env } from './env'

export interface RateLimitResult {
  ok: boolean
  code?: 'daily_limit' | 'rate_limit'
  message?: string
  retryAfterSeconds?: number
}

function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10)
}

function utcMinute(d = new Date()): string {
  return d.toISOString().slice(0, 16).replace(/[-:T]/g, '')
}

export async function checkRateLimit(env: Env, apiKey: string | null): Promise<RateLimitResult> {
  if (!apiKey) return { ok: true }
  if (String(env.DISABLE_PAYWALL ?? '').toLowerCase() === 'true') return { ok: true }

  const dailyCap = Math.max(1, Number(env.DAILY_LIMIT ?? '50'))
  const perMinCap = Math.max(1, Number(env.PER_MIN_LIMIT ?? '10'))

  // ---- 每日额度 ----
  const dayKey = `rl:${apiKey}:${utcDay()}`
  const dayCur = Number((await env.KEYS.get(dayKey)) || '0')
  if (dayCur >= dailyCap) {
    const now = new Date()
    const midnight = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0),
    )
    const retryAfterSeconds = Math.ceil((midnight.getTime() - now.getTime()) / 1000)
    return {
      ok: false,
      code: 'daily_limit',
      message: `Daily conversion limit (${dailyCap}) reached for this API key. It resets at 00:00 UTC.`,
      retryAfterSeconds,
    }
  }

  // ---- 每分钟突发 ----
  const minKey = `rlm:${apiKey}:${utcMinute()}`
  const minCur = Number((await env.KEYS.get(minKey)) || '0')
  if (minCur >= perMinCap) {
    return {
      ok: false,
      code: 'rate_limit',
      message: `Too many requests per minute (limit ${perMinCap}). Slow down a moment and retry.`,
      retryAfterSeconds: 60,
    }
  }

  // ---- 计数（best-effort，fail open）----
  try {
    await env.KEYS.put(dayKey, String(dayCur + 1), { expirationTtl: 86400 + 3600 })
    await env.KEYS.put(minKey, String(minCur + 1), { expirationTtl: 120 })
  } catch {
    /* ignore — 写失败也放行，限流是软保护，不是硬闸门 */
  }
  return { ok: true }
}
