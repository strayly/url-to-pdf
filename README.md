# url-to-pdf-mcp

把任意**公开网页**转换为 **PDF / 整页截图 / Markdown** 的 MCP server 与 HTTP API。
通过 Paddle 购买 API key 后调用，无需自建浏览器渲染环境。

- 标准 MCP server，兼容 Claude Desktop、Cursor 等支持 tool-calling 的客户端
- 原生 HTTP API，便于脚本、服务端、低代码平台直接调用
- SSRF 防护：仅允许公网 http(s) 地址，拦截内网/保留网段
- 基于 Paddle 的订阅制授权，付款后自动发卡

---

## 线上实例

已部署公开实例，可直接使用，无需自建：

```
https://url-to-pdf-mcp.1398088827.workers.dev
```

---

## 获取 API key

1. 打开 `https://url-to-pdf-mcp.1398088827.workers.dev/buy` 进入结账页。
2. 完成订阅付款（Paddle 结账，支持主流信用卡）。
3. 付款完成后，打开
   `https://url-to-pdf-mcp.1398088827.workers.dev/portal/claim?email=<你付款用的邮箱>`
   即可领取你的 API key（`utp_...`）。

---

## 使用方式

### 方式一：作为 MCP server（推荐给 AI 客户端）

在 Claude Desktop / Cursor 等客户端的 MCP 配置中加入：

```json
{
  "mcpServers": {
    "url-to-pdf": {
      "command": "npx",
      "args": [
        "mcp-remote",
        "https://url-to-pdf-mcp.1398088827.workers.dev/mcp",
        "--header", "x-api-key: YOUR_API_KEY"
      ]
    }
  }
}
```

连接后可直接用自然语言调用，例如「把 https://example.com 转成 PDF」。

### 方式二：作为 HTTP API（推荐给脚本 / 服务端）

所有渲染走 `POST /tools/*`，请求头带 `x-api-key`：

```bash
# 网页转 PDF
curl -X POST https://url-to-pdf-mcp.1398088827.workers.dev/tools/url-to-pdf \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{"url":"https://example.com","format":"A4"}'

# 整页截图
curl -X POST https://url-to-pdf-mcp.1398088827.workers.dev/tools/url-to-screenshot \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{"url":"https://example.com","fullPage":true,"format":"png"}'

# 提取 Markdown
curl -X POST https://url-to-pdf-mcp.1398088827.workers.dev/tools/url-to-markdown \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_API_KEY" \
  -d '{"url":"https://example.com"}'
```

返回 JSON 含 `downloadUrl`（有效期 1 小时），再下载即可：

```bash
curl -O "<downloadUrl>"
```

---

## API 参考

### 工具 / 端点对照

| MCP 工具名 | HTTP 端点 | 说明 |
|---|---|---|
| `list_capabilities` | `GET /openapi.json` | 免费。列出能力、价格与购买入口 |
| `url_to_pdf` | `POST /tools/url-to-pdf` | 网页转 PDF |
| `url_to_screenshot` | `POST /tools/url-to-screenshot` | 整页截图 |
| `url_to_markdown` | `POST /tools/url-to-markdown` | 提取 Markdown |

### `url_to_pdf` 参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `url` | string（必填） | 待转换页面的公网 http(s) URL |
| `format` | `A4` / `Letter` / `Legal` | 纸张大小，默认 `A4` |
| `landscape` | boolean | 横向，默认 `false` |
| `printBackground` | boolean | 打印背景图形，默认 `true` |
| `scale` | number | 缩放 0.1–2，默认 `1` |
| `margin` | string / object | 边距，如 `"10mm"` 或 `{top,right,bottom,left}` |
| `preferCssPageSize` | boolean | 遵循页面 CSS `@page` 尺寸 |

### `url_to_screenshot` 参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `url` | string（必填） | 目标 URL |
| `fullPage` | boolean | 截取整页，默认 `true` |
| `format` | `png` / `jpeg` | 默认 `png` |
| `quality` | number | JPEG 质量 0–1，默认 `0.8` |

### `url_to_markdown` 参数

| 参数 | 类型 | 说明 |
|---|---|---|
| `url` | string（必填） | 目标 URL |
| `removeSelectors` | string[] | 提取前剔除的 CSS 选择器，如 `["nav",".ads","footer"]` |
| `keepImages` | boolean | 保留图片链接，默认 `false` |

---

## 自行部署（开发者）

### 前置要求

- Cloudflare Workers 账号（Browser Rendering 需 Paid 计划）
- Node 20+
- Paddle 账号（用于收款与授权发放）

### 步骤

1. 克隆并安装依赖：

   ```bash
   git clone https://github.com/strayly/url-to-pdf.git
   cd url-to-pdf
   npm install
   ```

2. 创建两个 KV 命名空间（分别用于存放 API key 与渲染产物），把它们的 ID 填入 `wrangler.jsonc` 的 `kv_namespaces`。

3. 在 `wrangler.jsonc` 的 `vars` 中填入：

   | 变量 | 说明 |
   |---|---|
   | `WORKER_ORIGIN` | 你的 Worker 域名 |
   | `PADDLE_ENV` | `sandbox`（测试）或 `live`（生产） |
   | `PADDLE_PRICE_ID` | Paddle 后台的 Price ID（`pri_...`） |
   | `PADDLE_CLIENT_TOKEN` | Paddle Client-side token（`test_...` / `live_...`） |

4. 用 `wrangler secret put` 设置密钥（**不要写进仓库**，已被 `.gitignore` 忽略）：

   ```bash
   npx wrangler secret put PADDLE_API_KEY         # Paddle 服务端 API key
   npx wrangler secret put PADDLE_WEBHOOK_SECRET  # 通知目的地 Signing secret
   ```

5. 部署：

   ```bash
   npx wrangler deploy
   ```

### Paddle 后台配置

在 Paddle 后台完成以下配置：

- **Product**：新建产品，Tax category 选 `Standard digital goods`。
- **Price**：在产品下新建价格，Pricing model 选 `Recurring`（订阅制），记录 Price ID。
- **API key**：Authentication 页创建 server-side API key。
- **Notifications**：在 `Events → Notifications` 新建通知目的地，URL 填 `https://<你的域名>/webhook/paddle`，勾选 `transaction.completed` 及订阅相关事件，复制 Signing secret。
- **Client-side token**：Authentication 页创建，用于结账页初始化。
- **Default payment link**：在 `Checkout → Checkout settings` 设置一个默认链接（sandbox 可用 `http://localhost`，生产需换成已通过审核的域名）。

> sandbox 与 live 是两个完全隔离的环境，以上各项需分别在两边配置，密钥不可混用。

### 本地开发

```bash
cp .dev.vars.example .dev.vars   # 填入本地测试用的 secret
npx wrangler dev
node scripts/selfcheck.mjs http://127.0.0.1:8787   # 鉴权与 SSRF 自检
node scripts/live-test.mjs                        # 全链路自测（webhook 自签）
```

---

## 架构简述

- `/mcp`：MCP 发现层（免费）。列出工具与购买信息；携带有效 key 时也可直接渲染。
- `/tools/*`：受 `x-api-key` 保护的渲染端点。
- `/buy` + `/checkout`：Paddle 结账流程，建交易并展示本站收银台浮层。
- `/webhook/paddle`：接收 Paddle 付款事件，HMAC 验签后自动签发 API key。
- `/portal/claim`：用户凭结账邮箱领取 API key。
- 渲染产物暂存于 KV（1 小时 TTL），以下载链接返回。

---

## 安全说明

- 仅允许公网 http(s) 地址，静态拦截内网 / 保留网段（如 `127.0.0.0/8`、`10.0.0.0/8`、`169.254.0.0/16` 等）。
- 部署于高安全等级环境时，建议额外补充 DNS 解析校验以防御 DNS rebinding。
- 所有凭据通过 `wrangler secret put` 注入，不进入代码仓库。

---

## 成本

- Cloudflare Workers Paid 计划（Browser Rendering 的前置条件）
- Browser Rendering 按会话计费，含免费额度
- KV 含免费额度，产物自动过期

---

## 许可证

MIT
