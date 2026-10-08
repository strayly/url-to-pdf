// 静态页面：落地页 + 隐私 / 退款 / 服务条款。
// 浅色简洁风格，对齐原首页（绿色 #0a6、system 字体、窄栏）。
// 政策页面向海外用户，采用英文、参照 pdf.hammbox.com/terms 的完整结构。

const STYLE = `
body{font:15px/1.7 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;margin:0;color:#1a1a1a;background:#fff}
.nav{max-width:900px;margin:0 auto;padding:14px 20px;display:flex;gap:20px;align-items:center;border-bottom:1px solid #eee;font-size:14px}
.brand{font-weight:600;color:#0a6;margin-right:auto}
.nav a{color:#555;text-decoration:none}
.nav a.cur{color:#0a6;font-weight:600}
.nav a:hover{color:#0a6}
main{max-width:760px;margin:36px auto;padding:0 20px}
footer{max-width:760px;margin:48px auto;padding:24px 20px 0;border-top:1px solid #eee;color:#999;font-size:13px}
h1{font-size:28px;line-height:1.25;margin:0 0 10px}
h2{font-size:20px;margin:34px 0 10px;color:#222}
h3{font-size:16px;margin:22px 0 6px;color:#222}
p{color:#333}
a.link{color:#0a6}
code{background:#f4f4f5;padding:2px 5px;border-radius:3px;font-size:13px;white-space:nowrap}
pre{background:#f4f4f5;padding:14px;border-radius:6px;overflow-x:auto;font-size:13px}
.cta{display:inline-block;background:#0a6;color:#fff;padding:11px 20px;border-radius:6px;text-decoration:none;font-weight:500;margin:6px 0}
.price{color:#0a6;font-weight:600}
.card{border:1px solid #e5e5e5;border-radius:10px;padding:16px 18px;margin:12px 0}
.muted{color:#888;font-size:13px}
ul{color:#333;padding-left:20px}
li{margin:6px 0}
`

function nav(active: string): string {
  const item = (href: string, label: string, key: string) =>
    `<a href="${href}"${active === key ? ' class="cur"' : ''}>${label}</a>`
  return `<nav class="nav"><span class="brand">url-to-pdf</span>${item('/', 'Home', 'home')}${item('/#pricing', 'Pricing', 'pricing')}${item('/privacy', 'Privacy', 'privacy')}${item('/refund', 'Refund', 'refund')}${item('/terms', 'Terms', 'terms')}</nav>`
}

function layout(title: string, active: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>${STYLE}</style></head>
<body>
${nav(active)}
<main>${body}</main>
<footer>© 2026 Rock.Dong. Rendering powered by Cloudflare Workers.</footer>
</body></html>`
}

export function landingPage(origin: string): string {
  const curl = `curl -X POST ${origin}/tools/url-to-pdf \\
  -H "Content-Type: application/json" \\
  -H "x-api-key: YOUR_KEY" \\
  -d '{"url":"https://example.com","format":"A4"}'`
  const mcp = `{
  "mcpServers": {
    "url-to-pdf": {
      "type": "http",
      "url": "${origin}/mcp",
      "headers": { "x-api-key": "YOUR_KEY" }
    }
  }
}`
  return layout(
    'url-to-pdf — turn web pages into PDF, screenshot, Markdown',
    'home',
    `<h1>url-to-pdf</h1>
<p class="muted">Turn any public web page into a PDF, a screenshot, or clean Markdown. One API key unlocks all three.</p>

<div class="card"><h3>PDF</h3><p>Render a full web page to a print-ready PDF (A4 / Letter, portrait or landscape).</p></div>
<div class="card"><h3>Screenshot</h3><p>Capture a high-resolution PNG screenshot of any public page.</p></div>
<div class="card"><h3>Markdown</h3><p>Extract the main content of a page as clean Markdown, stripped of navigation and ads.</p></div>

<h2 id="pricing">Pricing</h2>
<p><span class="price">$5 / month</span> — one subscription, one API key, all three tools included. Billed and managed by Paddle; cancel anytime from your Paddle customer portal.</p>
<p><a class="cta" href="/buy">Buy an API key</a></p>

<h2>Get started</h2>
<p>Your API key appears on screen the moment checkout completes — no extra steps. If you ever lose it, recover it anytime at <code>/portal/claim?email=you@example.com</code>. Then call the API:</p>
<pre>${curl}</pre>
<p>Or connect it as an MCP server (works with Claude Desktop, Cursor, and any MCP client that supports Streamable HTTP):</p>
<pre>${mcp}</pre>
<p class="muted">Fair-use note: rendering runs on Cloudflare Browser Rendering. Under the free tier, short bursts of heavy concurrent load may be briefly rate-limited (HTTP 429) — just retry in a few seconds.</p>`,
  )
}

export function privacyPage(): string {
  return layout(
    'Privacy Policy — url-to-pdf',
    'privacy',
    `<h1>Privacy Policy</h1>
<p class="muted">Effective date: 2026-10-08 · Operator: Rock.Dong</p>

<h2>1. Who we are</h2>
<p>url-to-pdf is operated by <b>Rock.Dong</b> ("we", "us", "our"). This policy explains what data we handle, why, and your rights. For payment processing, our Merchant of Record <b>Paddle.com</b> (Paddle.com Market Ltd and its affiliates) acts as an independent controller of billing data.</p>

<h2>2. What we process</h2>
<ul>
<li><b>URLs you submit.</b> When you call an endpoint, the URL you provide is used only to fetch and render that page for your request. We do not store the source page content beyond the temporary artifact described below.</li>
<li><b>Generated artifacts (PDF / screenshot / Markdown).</b> Output is stored in Cloudflare KV for <b>1 hour</b>, then automatically deleted by an expiry TTL. It is never used for training, analytics, or any purpose other than delivering it back to you.</li>
<li><b>Email address.</b> When you claim a key after purchase, you provide an email so we can bind it to your API key and let you recover it. It is stored in KV and is <b>not used for marketing</b>.</li>
<li><b>Payment information.</b> All payments are handled by Paddle (our Merchant of Record). We never receive or store your card number or payment credentials.</li>
</ul>

<h2>3. What we do not collect</h2>
<p>We do not set advertising or tracking cookies, and we do not build browser fingerprints or persistent device identifiers. We do not run third-party analytics on this site beyond the minimal logs Cloudflare retains for security and delivery.</p>

<h2>4. Third parties</h2>
<ul>
<li><b>Cloudflare</b> — hosting, KV storage, and Browser Rendering (page capture).</li>
<li><b>Paddle</b> — payment processing, tax calculation, and subscription management (Merchant of Record). Paddle's own privacy notice applies to the billing data it processes.</li>
</ul>

<h2>5. Data retention &amp; deletion</h2>
<p>Artifacts expire automatically after 1 hour and are not recoverable afterward. Key/email records are kept for the life of your subscription plus a short grace period for recovery. You may request deletion of your email and key records at any time by emailing <a class="link" href="mailto:feedback@hammbox.com">feedback@hammbox.com</a>.</p>

<h2>6. Your rights</h2>
<p>Depending on your jurisdiction (for example the EU GDPR or UK GDPR), you may have the right to access, correct, export, or delete your personal data, and to object to or restrict certain processing. To exercise these rights, contact us at the email above. We will respond within the timeframes required by applicable law.</p>

<h2>7. International transfers</h2>
<p>Our infrastructure is hosted by Cloudflare on a global network, so your data may be processed outside your country of residence. Where required (for example transfers from the EEA or UK), we rely on Cloudflare's and Paddle's approved transfer mechanisms, including Standard Contractual Clauses.</p>

<h2>8. Contact</h2>
<p>Rock.Dong · <a class="link" href="mailto:feedback@hammbox.com">feedback@hammbox.com</a></p>`,
  )
}

export function refundPage(): string {
  return layout(
    'Refund Policy — url-to-pdf',
    'refund',
    `<h1>Refund Policy</h1>
<p class="muted">Effective date: 2026-10-08 · Operator: Rock.Dong</p>

<h2>1. Nature of the product</h2>
<p>url-to-pdf is a digital subscription API service. Access is delivered immediately upon purchase as an activated API key, and the service is consumed as you use it — there is no physical shipment and no waiting period before the service becomes usable.</p>

<h2>2. Right of withdrawal (EU / UK consumers)</h2>
<p>For consumers in the European Union and United Kingdom, digital content supplied other than on a tangible medium is subject to a 14-day right of withdrawal under Directive (EU) 2011/83 and the UK Consumer Contracts Regulations 2013.</p>
<p><b>However, that right of withdrawal is lost once performance of the contract has begun</b> — i.e. once your API key is delivered and you start using the service — provided you have given your prior express consent and acknowledged that you thereby lose the right of withdrawal. <b>We obtain this consent and acknowledgement at the Paddle checkout before payment is completed.</b> Accordingly, after your key is activated you may not cancel for a change of mind under the 14-day withdrawal right. Nothing here affects your statutory rights where the product is faulty, not as described, or not provided as agreed (see Section 4).</p>

<h2>3. Refunds we may grant</h2>
<p>Outside the withdrawal right above, we may, at our discretion, refund a charge where: (a) the service was materially unavailable or not as described during the period charged; or (b) you request it within <b>14 days</b> of purchase and the key has not been substantially used (that is, you have not generated a large volume of artifacts). In such cases we will refund the affected monthly fee.</p>

<h2>4. How refunds are processed</h2>
<p>Because <b>Paddle is the Merchant of Record, we do not refund you directly.</b> Refunds are issued through your Paddle customer portal or by contacting Paddle or us; Paddle returns the funds to your original payment method. Our refund rules are applied in accordance with Paddle's Checkout Buyer Terms and applicable consumer law.</p>

<h2>5. Cancellation vs. refund</h2>
<p>Your subscription renews monthly and can be cancelled anytime from your <a class="link" href="https://paddle.com" target="_blank" rel="noopener">Paddle customer portal</a> — this stops future charges. A cancellation is not a retroactive refund for the current period unless you qualify under Section 3.</p>

<h2>6. Abuse</h2>
<p>Refunds may be declined where we detect abuse, such as using the service heavily and then requesting a refund, or where a refund would violate Paddle's policies. We reserve the right to refuse refunds that are abusive or fraudulent.</p>

<h2>7. Contact</h2>
<p>Questions: <a class="link" href="mailto:feedback@hammbox.com">feedback@hammbox.com</a></p>`,
  )
}

export function termsPage(): string {
  return layout(
    'Terms of Service — url-to-pdf',
    'terms',
    `<h1>Terms of Service</h1>
<p class="muted">Effective date: 2026-10-08 · Operator: Rock.Dong</p>

<h2>1. Acceptance</h2>
<p>By using <b>url-to-pdf</b> ("the Service", "we", "us", "our") — including its API, MCP server, and website — you agree to these Terms. If you do not agree, do not use the Service.</p>

<h2>2. Merchant of Record</h2>
<p>Our order process is conducted by our online reseller <b>Paddle.com</b> (Paddle.com Market Ltd and its affiliates). <b>Paddle.com is the Merchant of Record for all our orders.</b> Paddle provides all customer-service inquiries related to billing and handles returns and refunds. Your purchase contract for the paid plan is formed with Paddle as the merchant of record; we are the supplier of the Service. Prices shown include applicable VAT/GST, which Paddle calculates and collects on your behalf.</p>

<h2>3. The Service</h2>
<p>The Service converts public web pages that you submit into PDF, PNG screenshots, or clean Markdown, and exposes that functionality through a paid API key and an MCP server. The Service is provided "as is" and on a fair-use basis; see the Acceptable Use and Pricing sections.</p>

<h2>4. License &amp; use limits</h2>
<ul>
<li>We grant you a personal, non-exclusive, non-transferable license to use the Service for the subscription period you purchased.</li>
<li>One API key corresponds to one subscription. Sharing, reselling, or redistributing your key, or allowing others to use it under your subscription, is not permitted.</li>
<li>The Service is licensed, not sold; all intellectual property in the Service and its backend remains ours or our licensors'.</li>
</ul>

<h2>5. Digital content &amp; right of withdrawal</h2>
<p>For consumers in the European Union and United Kingdom, digital content supplied other than on a tangible medium (such as an API key and access to the Service) is subject to a 14-day right of withdrawal under Directive (EU) 2011/83 and the UK Consumer Contracts Regulations 2013.</p>
<p><b>However, that right of withdrawal is lost once performance of the contract has begun</b> — i.e. once your API key is delivered and/or you start using the Service — provided you have given your prior express consent and acknowledged that you thereby lose the right of withdrawal. <b>We obtain this consent and acknowledgement at the Paddle checkout before payment is completed.</b> Accordingly, after your key is activated you may not cancel for a change of mind under the 14-day withdrawal right. Nothing in this section affects your statutory rights where the product is faulty, not as described, or not provided as agreed (see Section 10 and our Refund Policy).</p>

<h2>6. Your content &amp; copyright</h2>
<h3>6.1 Content you submit</h3>
<p>You retain all copyright and ownership in the web pages and text you choose to process. By using the Service, you grant us a limited, temporary license to fetch and process that content <i>solely</i> to generate your requested output. We do not claim ownership of your source content, and we do not permanently store it (see Privacy Policy).</p>
<h3>6.2 Generated output</h3>
<p>Outputs are generated on demand and provided "as is". They may be incomplete or inaccurate; you are responsible for verifying output before relying on or redistributing it. You must respect the copyright and terms of the original web pages — do not use the Service to copy or redistribute content in breach of the source site's terms or applicable copyright law.</p>
<h3>6.3 Our software</h3>
<p>The Service, its backend, and all related materials are © 2026 Rock.Dong. All rights reserved. No trademark, patent, or other intellectual-property right is granted except the limited license in Section 4.</p>

<h2>7. Acceptable use</h2>
<ul>
<li>Do not use the Service to generate, store, or distribute unlawful, infringing, or abusive content.</li>
<li>Respect the target site's terms and copyright. Do not use the Service to scrape content you are not permitted to access or redistribute.</li>
<li>Do not resell, share, or redistribute your API key.</li>
<li>Do not use the Service to scan internal networks, attack systems, or otherwise abuse infrastructure (such activity is blocked at the edge).</li>
<li>Do not abuse the free tier or fair-use limits (for example automated bulk use beyond reasonable personal or business need).</li>
</ul>

<h2>8. Subscription &amp; billing</h2>
<ul>
<li>The Service is billed at <span class="price">$5 / month</span>, recurring, via Paddle. It renews automatically each month until cancelled from your Paddle customer portal. Plan price and currency are shown at checkout.</li>
<li>Prices and features are shown on the purchase page; future renewals are at the then-current price, which Paddle notifies you about where required by law.</li>
</ul>

<h2>9. Refunds</h2>
<p>Refunds are handled by Paddle in accordance with Paddle's Checkout Buyer Terms and applicable consumer law. Our refund rules (including the EU/UK withdrawal position and when a refund is available) are set out in the <a class="link" href="/refund">Refund Policy</a>.</p>

<h2>10. Disclaimer &amp; limitation of liability</h2>
<p>The Service is provided "as is" without warranties of any kind. To the maximum extent permitted by law, we are not liable for indirect or consequential loss. Our total liability is limited to the amount you paid in the 12 months before the claim.</p>

<h2>11. Termination</h2>
<p>We may suspend or terminate access for breach of these Terms or abuse of the Service, without refund where abuse occurred. You may stop using the Service at any time; cancelling the subscription stops future charges.</p>

<h2>12. Changes</h2>
<p>We may update these Terms; material changes are reflected by the "Last updated" date. Continued use after changes means acceptance.</p>

<h2>13. Governing law &amp; contact</h2>
<p>These Terms are governed by the laws of the jurisdiction in which the operator is established, without prejudice to mandatory consumer protections of your country of residence. Questions: <a class="link" href="mailto:feedback@hammbox.com">feedback@hammbox.com</a></p>`,
  )
}
