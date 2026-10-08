import { createRequire } from 'module'
const require = createRequire(import.meta.url)
// bundle limit.ts -> cjs
const esbuild = require('esbuild')
const out = await esbuild.build({
  entryPoints: ['src/limit.ts'],
  bundle: true, format: 'cjs', platform: 'node', write: false,
})
const code = out.outputFiles[0].text
const mod = { exports: {} }
new Function('module','exports','require', code)(mod, mod.exports, require)
const { checkRateLimit } = mod.exports

// in-memory KV mock
function memKV() {
  const m = new Map()
  return {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v, opt) => { m.set(k, v) },
  }
}
const env = { KEYS: memKV(), DAILY_LIMIT: '3', PER_MIN_LIMIT: '2' }

const key = 'utp_test'
const results = []
for (let i = 0; i < 5; i++) {
  const r = await checkRateLimit(env, key)
  results.push(r.ok ? 'ok' : `429:${r.code}`)
}
console.log('per-min cap=2, daily cap=3, 5 calls ->', results.join(' | '))
const expect = ['ok','ok','429:rate_limit','429:rate_limit','429:rate_limit']
const pass = JSON.stringify(results) === JSON.stringify(expect)
console.log(pass ? 'PASS: per-minute limit triggers 429' : 'FAIL: unexpected sequence')

// daily limit test (fresh key, call 4 with daily cap 3)
const env2 = { KEYS: memKV(), DAILY_LIMIT: '3', PER_MIN_LIMIT: '10' }
const r2 = []
for (let i = 0; i < 4; i++) r2.push((await checkRateLimit(env2, 'utp_daily')).ok ? 'ok' : '429')
console.log('daily cap=3, 4 calls ->', r2.join(' | '))
const dailyPass = r2.join('|') === 'ok|ok|ok|429'
console.log(dailyPass ? 'PASS: daily limit triggers 429 on 4th' : 'FAIL daily')

// DISABLE_PAYWALL bypass
const env3 = { KEYS: memKV(), DAILY_LIMIT: '0', PER_MIN_LIMIT: '0', DISABLE_PAYWALL: 'true' }
console.log('DISABLE_PAYWALL ->', (await checkRateLimit(env3, 'x')).ok ? 'PASS: fail-open' : 'FAIL')
// null key bypass
console.log('null key ->', (await checkRateLimit({ KEYS: memKV() }, null)).ok ? 'PASS: anon open' : 'FAIL')
