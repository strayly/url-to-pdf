/**
 * 所有环境变量集中在这里，改一处就够。
 * 敏感项（PADDLE_API_KEY / PADDLE_WEBHOOK_SECRET / ADMIN_TOKEN）走 wrangler secret，
 * 不要写进 wrangler.jsonc。
 *
 * 存储层用 KV（无需在控制台单独开启 R2）。KV 单值上限 25MB，覆盖绝大多数页面；
 * 上量后想更便宜可把 ASSETS 换回 R2 Bucket（改这一处类型 + 两个 put/get + wrangler.jsonc）。
 */
export interface Env {
  BROWSER: Fetcher
  ASSETS: KVNamespace
  KEYS: KVNamespace

  WORKER_ORIGIN: string

  /** Paddle 服务端 API key（Bearer），存在 secret 里 */
  PADDLE_API_KEY?: string
  /** Paddle webhook 验签密钥（Developer Tools → Notifications），存在 secret 里 */
  PADDLE_WEBHOOK_SECRET?: string
  /** 'sandbox' | 'production'。开发期用 sandbox，接真实收款再切 production */
  PADDLE_ENV?: string
  /** Paddle 后台建好的 Price ID（决定卖多少钱），写在 vars 里即可 */
  PADDLE_PRICE_ID?: string
  /**
   * Paddle 客户端令牌（Developer tools → Authentication → Client-side tokens）。
   * sandbox 以 test_ 开头，live 以 live_ 开头；本来就暴露在前端，放 vars 即可。
   * 我们的 /checkout 自有收银台页用它初始化 Paddle.js。
   */
  PADDLE_CLIENT_TOKEN?: string

  /** 展示用价格文案（订阅制，不代表按次计费） */
  PRICE_PDF: string
  PRICE_SCREENSHOT: string
  PRICE_MARKDOWN: string

  /** 管理员发卡令牌：设置后 /admin/issue 可直发卡，用于沙箱自测；生产删除 */
  ADMIN_TOKEN?: string

  /** 本地自测用，生产环境不要开 */
  DISABLE_PAYWALL?: string

  /** 单个 API key 每日渲染额度（默认 50），防一个用户吃光共享渲染额度 */
  DAILY_LIMIT?: string
  /** 单个 API key 每分钟突发上限（默认 10），防瞬间起一堆浏览器撞免费实例墙 */
  PER_MIN_LIMIT?: string
}
