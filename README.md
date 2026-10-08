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



## 许可证

MIT
