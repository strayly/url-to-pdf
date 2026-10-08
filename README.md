# url-to-pdf MCP

把任意公开网页转成 **PDF / 截图 / Markdown**，购买 **API key** 后调用，付款走 **Paddle**（支持 sandbox 测试，不接真实收款也能验全链路）。

没有后台、没有数据库依赖。用户付款 → Paddle 发 webhook → Worker 自动签发 API key 存进 KV → 用户凭邮箱领回 → 之后调用带 `x-api-key` 即可。

线上地址（已部署）：`https://url-to-pdf-mcp.1398088827.workers.dev`

---

## 设计思路（先看这个，别急着部署）

**为什么 MCP 层和 HTTP 层是分开的？**

Paddle 是「买 key 再调用」模型，不是按次微支付。所以这里分工是：

```
/mcp          负责「发现」  tools/list 免费，告诉 agent 有什么、多少钱、去哪买 key
/tools/*      负责「成交」  被 API-key 鉴权保护，无 key 返回 401
/buy          负责「收银」  调 Paddle API 建交易，302 跳转到 Paddle 结账页
/webhook/paddle  负责「发卡」  Paddle 付款完成后回调这里，验签后自动签发 key
/portal/claim     负责「领取」  用户凭结账邮箱取回自己的 key
```

**为什么返回一个下载 URL，而不是把 PDF 直接塞回去？**

大文件塞进 tool result 会直接撑爆模型上下文。产物存 KV（1 小时 TTL），返回下载链接。

**存储为什么用 KV 而不是 R2？**

KV 不需要在 Cloudflare 控制台单独开启，部署即通；R2 需要先去控制台点一下启用（本机当时没开）。KV 单值上限 25MB，覆盖绝大多数页面。上量后想更便宜可以只改 `src/env.ts` 里 `ASSETS` 的类型 + `src/index.ts` 两处 put/get + `wrangler.jsonc`（换回 R2 Bucket）。

---

## 定价

订阅制，写在 `wrangler.jsonc` 的 `PRICE_*` vars 里（纯展示文案）。真实价格由 Paddle 后台的 **Price ID** 决定，写进 `PADDLE_PRICE_ID`：

| 工具 | 计划 |
|---|---|
| `url_to_pdf` | Plan $5/mo（含全部工具） |
| `url_to_screenshot` | 同上 |
| `url_to_markdown` | 同上 |
| `list_capabilities` | 免费 |

---

## Paddle 后台配置清单（sandbox）

按顺序做，缺一步 `/buy` 就会报错。

### 1. 建 Product

Catalog → Products → New product：

| 字段 | 填什么 | 说明 |
|---|---|---|
| Product name | `URL to PDF MCP` | 结账页与收据上买家看到的名字 |
| Tax category | `Standard digital goods`（保持默认） | **不要选 SaaS**：该分类需 Paddle 审核你的网站，本项目没有落地页，会被拒 |
| Description | `MCP server: render a web page to PDF / full-page screenshot / clean Markdown. All tools included.` | 仅后台内部可见 |
| Product icon URL | 留空 | 需要公网 HTTPS 图片地址才有效 |
| Custom Data | `product` = `url-to-pdf-mcp` | 可选，会带进 webhook，多 server 时便于区分 |

保存后拿到 `pro_...` —— **代码里不用它**，别填错。

### 2. 建 Price（在该产品下 Add price）

| 字段 | 填什么 | 说明 |
|---|---|---|
| Price name | `Pro — monthly` | 结账页与发票上买家看到的名称 |
| Internal description | `Pro monthly, all 3 tools (url_to_pdf / url_to_screenshot / url_to_markdown)` | **Paddle 必填项**，仅后台可见，不影响买家 |
| Pricing model | **`Recurring`** | **必须选 Recurring，不要 One-time。** 定价是 $5/月；买断等于一次性收完就断收入，而每次调用都在消耗 Browser Rendering；且 `pay.ts` 里 `subscription.updated` → 非 active 停卡的逻辑永不触发 |
| Billing period | `Monthly`，frequency `1` | 切到 Recurring 后才会出现该字段 —— 看不到它，说明还停在 One-time |
| Base price | `5.00`，货币 `USD` | 与 `wrangler.jsonc` 的 `PRICE_*` 展示价 `$5/mo` 对齐 |
| Sales tax | `Account default` | 继承 Product 上设的 Standard digital goods，不用在这里再选 |
| Min / Max quantity | `1` / `999999`（保持默认） | 供按席位计价与阶梯折扣用，单人订阅无需改 |
| Custom Data | `product` = `url-to-pdf-mcp` | 可选，会带进 webhook，日后多个 server 时区分来源 |

保存后拿到 `pri_...` —— **把这个填进 `wrangler.jsonc` 的 `PADDLE_PRICE_ID`**，然后 `npx wrangler deploy`。

> **Price 的金额、币种、计费周期一经创建不可编辑**（Paddle 的设计，因为上面可能已挂订阅）。选错了只能删掉重建 —— 若那时已有人订阅，会牵连现有买家。所以 Pricing model 这一步务必当场选对。

### 3. 设 Default payment link（必做，最容易漏）

Paddle → Checkout → Checkout settings → Default payment link。

不设的话，调 `POST /transactions` 会直接返回：

```json
{"error":{"type":"request_error","code":"transaction_default_checkout_url_not_set",
 "detail":"A Default Payment Link has not yet been defined within the Paddle Dashboard"}}
```

sandbox 阶段填 `http://localhost` 或任意测试域名即可；**转生产前必须换成已通过 Paddle 网站审核的域名**。

> ⚠️ **本项目的 `/buy` 不依赖这个默认链接**。默认 payment link 是**账号级**的，本账号它指向别的产品的付款页（那个页面写死了自己的商品、不读 `_ptxn`），所以我们会把用户跳到**本站自有收银台** `/checkout`，用它拉起真正属于本产品的交易。Paddle 侧仍要求"存在一个默认 payment link"才能建交易，所以这一项照样得设，只是它不再决定本产品的结账页。

### 3.5 自有收银台：Client-side token + 域名审批

`/checkout` 是一张本站页面，用 Paddle.js 按 `_ptxn` 拉起对应交易的结账浮层。它需要：

| 放到哪 | 从哪拿 | 格式特征 |
|---|---|---|
| `PADDLE_CLIENT_TOKEN`（vars） | 直链 `.../authentication-v2` → **Client-side tokens** 标签 → `New client-side token` | `test_...`（sandbox）/ `live_...`（生产）。本就用于前端，放 vars 不敏感 |
| 域名审批 | Paddle → `Checkout` → `Website approval`，加入本站域名 | **sandbox 自动秒批**；生产需人工审核，未过审时 `PATCH /transactions/{id}` 设 `checkout.url` 会 400（不影响付款主流程） |

配好后 `/checkout` 才可用；未配 `PADDLE_CLIENT_TOKEN` 时它返回 503。

### 4. 取 sandbox 凭据

**先确认在哪个后台**：sandbox 与生产是**两个独立注册的站点**——
sandbox 是 `sandbox-vendors.paddle.com`，生产是 `vendors.paddle.com`。
sandbox 的 Product / Price / key 在生产后台**根本看不到**，反之亦然。

| 放到哪 | 从哪拿 | 格式特征 |
|---|---|---|
| `PADDLE_API_KEY`（secret） | 直链 `.../authentication-v2` → API keys 页 → `New API key`（侧栏已无此入口，见下方说明） | 69 字符，`pdl_sdbx_apikey_...`（sandbox）/ `pdl_live_apikey_...`（生产） |
| `PADDLE_WEBHOOK_SECRET`（secret） | 左侧栏 `Events` → `Notifications` → 打开目标 → 复制 `Signing secret` | `pdl_ntfset_...` |
| 通知目的地 URL | `https://<你的域名>/webhook/paddle`，至少勾 `transaction.completed`，订阅再勾 `subscription.*` | — |

> ⚠️ **侧栏里找不到 `Developer Tools` 是常态，不要在这上面浪费时间。** Paddle 2026 改版后
> 侧栏里已经没有这个一级菜单（`Connectors` 下面直接就是 `My account`），旧文档全部过时。
> **直接用直链**，它会绕过侧栏：
>
> - sandbox：`https://sandbox-vendors.paddle.com/authentication-v2`
> - 生产：`https://vendors.paddle.com/authentication-v2`
>
> 直链进去后就是 API keys 页。另外 `Notifications` 归在侧栏 **Events** 组下（不在 Developer Tools 里）。
> 直链也打不开（403/跳回首页）→ 检查当前登录账号的角色：只有 **Owner / Admin / Technical**
> 角色能看到 Authentication，`Finance` / `Support` 等角色看不到。

> ⚠️ **sandbox 与生产是两套完全隔离的系统**：API key、client token、Product、Price、webhook secret、通知目的地都要在两边各建一遍，不能混用。现在 `PADDLE_ENV=sandbox`，所以必须用 sandbox 的 key，否则会 401/找不到商品。

---

## 部署步骤（已替你跑通一遍）

### 1. 前置条件

- **Cloudflare Workers Paid 计划（$5/月）** —— Browser Rendering 免费计划用不了，这是硬门槛
- Node 20+
- **Paddle 账号**（免费注册即可；要测真实收款在 sandbox 建商品，见下）

### 2. 装依赖 + 建存储

```bash
cd url-to-pdf-mcp
npm install
# KV 命名空间已建好，id 已写进 wrangler.jsonc：
#   KEYS  112dbd7e8b994ce6afeab0431f96bb57
#   ASSETS dc39c0196daa4746b075d93797969b24
```

### 3. 配置变量 / 密钥

`wrangler.jsonc` 的 vars 里 `PADDLE_PRICE_ID` 与 `PADDLE_CLIENT_TOKEN` 现在是占位符，改成你自己的：

- `PADDLE_PRICE_ID`：在 Paddle 后台建的 Price ID（`pri_...`）
- `PADDLE_CLIENT_TOKEN`：Paddle 后台 Authentication → Client-side tokens 里的 `test_...`（sandbox）/ `live_...`（生产）
- `WORKER_ORIGIN`：你的 Worker 域名
- `PADDLE_ENV`：sandbox 测试填 `sandbox`，生产填 `live`

密钥用 `wrangler secret put`（**不要写进仓库**，已被 `.gitignore` 忽略）：

```bash
npx wrangler secret put PADDLE_API_KEY        # Paddle 服务端 API key（pdl_...）
npx wrangler secret put PADDLE_WEBHOOK_SECRET  # Paddle 通知验签密钥（pdl_ntfset_...）
```

### 4. 部署 + 自检

```bash
npx wrangler deploy
node scripts/selfcheck.mjs https://url-to-pdf-mcp.1398088827.workers.dev
```

**自检一定要跑**——它专门抓最容易踩的坑：付费端点漏配鉴权会直接返回 200 把数据免费送出去。

---

## 本地 / sandbox 自测（不接真实收款也能验全链路）

### A. 最快：webhook 自签验签（推荐，无需 Paddle 后台）

webhook 验签是 HMAC 计算，本地就能用 secret 自己签一个假事件打过去，验证「验签 + 自动发卡 + 领取 + 带 key 调用」整条链：

```bash
# .dev.vars 里放 PADDLE_WEBHOOK_SECRET 后：
npx wrangler dev --port 8787
# 另开终端：
NO_PROXY='localhost,127.0.0.1' BASE=http://127.0.0.1:8787 \
  PADDLE_WEBHOOK_SECRET=<你的 webhook secret> \
  node scripts/live-test.mjs
```

`scripts/live-test.mjs` 一次覆盖：首页、`openapi.json`、tools/list、无 key→401、SSRF→400、webhook 验签+发卡、带 key 渲染、错误签名→401。

### B. 真实 Paddle 结账 + webhook（接真实 sandbox 收款）

1. Paddle sandbox 后台（`sandbox-vendors.paddle.com`）→ 建 **Product + Price**（$5/月），复制 **Price ID**（`pri_...`）
2. 直链 `https://sandbox-vendors.paddle.com/authentication-v2` → API keys 页 → `New API key`（server-side，得到 `pdl_sdbx_apikey_...`）
3. 侧栏 `Events` → `Notifications` → 新建 destination，URL 填 `https://<你的域名>/webhook/paddle`，保存后复制 **Signing secret**（`pdl_ntfset_...`）
4. 把这三样写进 Worker（见上方「配置变量 / 密钥」），然后 `npx wrangler deploy`
5. 测结账：`https://<你的域名>/buy` → 302 跳 Paddle 结账页
6. 真实付款（sandbox 测试卡）后 Paddle 自动回调 `/webhook/paddle` → 自动发卡
7. 领 key：`https://<你的域名>/portal/claim?email=<结账邮箱>`

> ⚠️ Paddle 2026 改版后没有显眼的「Send example notification」按钮，验证 webhook 直接走**真实 sandbox 结账**即可，比测试事件更可信。

---

## 接入方式

### 作为 MCP server（agent 用）

```json
{
  "mcpServers": {
    "url-to-pdf": {
      "command": "npx",
      "args": ["mcp-remote", "https://url-to-pdf-mcp.1398088827.workers.dev/mcp", "--header", "x-api-key: YOUR_KEY"]
    }
  }
}
```

### 作为 HTTP API（脚本/服务用）

```bash
curl -X POST https://url-to-pdf-mcp.1398088827.workers.dev/tools/url-to-pdf \
  -H "Content-Type: application/json" -H "x-api-key: YOUR_KEY" \
  -d '{"url":"https://example.com","format":"A4"}'
# → 200 + downloadUrl（1 小时有效）
```

---

## 发布到 MCP 目录

按顺序，官方 Registry 是数据源，其他会自动同步（2026-10 实测）：

```
[ ] GitHub 上建 repo 并 push 代码（包名改成你自己的）
[ ] npx mcp-publisher publish                  → 官方 Registry（DR 90，数据源）
[ ] npx smithery mcp publish                   → Smithery（~44 万月访）
[ ] mcp.so 提交表单                             → mcp.so（~24 万月访；免费路径进搜索较慢，$39 premium 即时）
[ ] mcpservers.org 提交表单                     → mcpservers.org（~50 万月访）
[ ] GitHub repo 加 mcp-server topic             → Glama 自动抓取
```

README 里务必写清楚「它能干什么」，不是「它怎么实现的」——目录流量是需求驱动的，开发者在搜能力。

---

## 成本

| 项 | 说明 |
|---|---|
| Workers Paid | $5/月，Browser Rendering 的前置条件 |
| Browser Rendering | 有免费额度，超出按会话计费 —— **去控制台核对当前配额** |
| KV | 免费额度足够撑到有真实量为止（产物 1 小时 TTL，自动过期） |

---

## 已知短板（诚实交代）

1. **DNS rebinding**：`src/guard.ts` 只做字符串层面的内网 IP 拦截，没做 DNS 解析校验。堵死需每请求多一次 DNS。
2. **KV 25MB 上限**：超了返回 413，上量换 R2。
3. **Paddle 变更隔离**：所有收款/验签逻辑在 `src/pay.ts` 一个文件，换收款方式只动它。
4. **webhook 验签密钥**：`PADDLE_WEBHOOK_SECRET` 是 Paddle 通知目的地的 Signing secret，生产务必填你自己的（sandbox 与 live 各一套，不能混用）。

---

## 关于这条路的预期

单点不赚钱，矩阵才赚钱。一个估算模型：免费 server 月 500 次安装 → 2% 点到付费页 → 约 10 访问 → 5% 转化 → 月约 0.5 单。

**这个 server 的真正价值是跑通「目录流量 → Paddle 收款 → 自动发卡 → 用户调用」的完整闭环。** 链路一旦跑通，复制第二个 server 的代码成本几乎为零。
