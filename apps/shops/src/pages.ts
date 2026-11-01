import type { Shop } from "./shops.ts";

/** A shop's live merchant record, or why it couldn't be loaded. */
export type PageQuote =
  | { ok: true; priceInr: number; priceUsdc: string; payTo: string; upiHandle: string; endpoint: string }
  | { ok: false; error: string };

export function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const CSS = `
:root { --bg:#f7f7f5; --card:#fff; --text:#1c1c1a; --muted:#5f5f5a; --line:#e3e2dd; --code:#f0efea; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --bg:#141413; --card:#1d1d1b; --text:#ecebe6; --muted:#a3a29b; --line:#33322e; --code:#2a2926; }
}
:root[data-theme="dark"] { --bg:#141413; --card:#1d1d1b; --text:#ecebe6; --muted:#a3a29b; --line:#33322e; --code:#2a2926; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 760px; margin: 0 auto; padding: 32px 16px 64px; }
a { color: var(--accent, #2563eb); }
h1 { font-size: 1.9rem; margin: 0 0 4px; line-height: 1.2; }
h2 { font-size: 1.05rem; margin: 28px 0 8px; }
.ens { color: var(--accent); font-weight: 600; }
.muted, small { color: var(--muted); }
.band { height: 6px; background: var(--accent, #2563eb); border-radius: 3px; margin-bottom: 20px; width: 64px; }
.card { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; }
.tests { border-left: 4px solid var(--accent); }
.grid { display: grid; gap: 14px; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); }
.grid .card { border-top: 4px solid var(--c); display: flex; flex-direction: column; gap: 6px; }
.grid .card a { color: var(--c); font-weight: 600; text-decoration: none; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
dt { color: var(--muted); }
dd { margin: 0; overflow-wrap: anywhere; }
code, pre { background: var(--code); border-radius: 5px; font: 0.88em/1.5 ui-monospace, Consolas, monospace; }
code { padding: 1px 5px; }
pre { padding: 10px 12px; overflow-x: auto; margin: 6px 0 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
table { border-collapse: collapse; }
td, th { text-align: left; padding: 4px 18px 4px 0; border-bottom: 1px solid var(--line); }
.stock strong { font-size: 1.6rem; color: var(--accent); }
.error { border-color: #dc2626; color: #dc2626; }
button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--accent); background: var(--card); color: var(--accent); cursor: pointer; }
`;

function layout(title: string, accent: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title><style>${CSS}</style></head><body style="--accent:${accent}"><main>${body}</main></body></html>`;
}

export function homePage(shops: Shop[]): string {
  const cards = shops
    .map(
      (s) => `<div class="card" style="--c:${s.accent}"><a href="/${s.slug}">${esc(s.title)}</a><small class="ens">${esc(s.ensName)}</small><span>${esc(s.sells)}</span><small>${esc(s.tests)}</small></div>`,
    )
    .join("");
  return layout(
    "Sangam Test Shops",
    "#1c1c1a",
    `<h1>Sangam test shops</h1><p class="muted">Five merchants on one server. Each one is paid over x402 into Sangam's treasury, and each stresses a different part of Sangam.</p><div class="grid">${cards}</div>`,
  );
}

export function shopPage(shop: Shop, quote: PageQuote, origin: string): string {
  const facts = quote.ok
    ? `<dl>
        <dt>Listed price</dt><dd>₹${esc(quote.priceInr)} <small>≈ ${esc(quote.priceUsdc)} USDC right now</small></dd>
        <dt>Agents pay</dt><dd><code>${esc(quote.payTo)}</code> <small>Sangam's treasury on Hedera</small></dd>
        <dt>Shop gets paid at</dt><dd><code>${esc(quote.upiHandle)}</code> <small>in rupees over UPI</small></dd>
        <dt>Paid link</dt><dd><code>${esc(quote.endpoint)}</code></dd>
      </dl>`
    : `<p class="card error">This shop can't load its merchant record: ${esc(quote.error)}</p>`;

  const query = shop.example ? `?${shop.example}` : "";
  const buyQuery = shop.example ? ` --query "${shop.example}"` : "";
  const sim = shop.simArgs
    ? `<p>3. No Hedera accounts yet? Fake the payment instead (start the agent with <code>npm run settlement:sim</code>):</p>
       <pre>npm run simulate -- ${esc(shop.simArgs)} --merchant ${esc(shop.ensName)}</pre>`
    : `<p>3. This test needs a real payment, so the simulator can't run it.</p>`;
  const actions = Object.keys(shop.actions ?? {})
    .map((name) => `<form method="post" action="/${shop.slug}/${name}"><button>${esc(name)}</button></form>`)
    .join("");

  return layout(
    shop.title,
    shop.accent,
    `<div class="band"></div>
     <p><a href="/">← All shops</a></p>
     <h1>${esc(shop.title)}</h1>
     <p class="ens">${esc(shop.ensName)}</p>
     <p>${esc(shop.sells)}</p>
     <div class="card tests"><strong>What this shop tests</strong><br>${esc(shop.tests)}</div>
     <h2>Merchant record</h2>
     <div class="card">${facts}</div>
     <h2>The shop</h2>
     ${shop.pageExtra?.() ?? ""}
     ${actions}
     <h2>Try it</h2>
     <p class="muted">Run these in the project folder. In Windows PowerShell, type <code>npm.cmd</code> instead of <code>npm</code>, or PowerShell drops the <code>--</code>.</p>
     <p>1. See the x402 invoice (a 402 reply with a <code>PAYMENT-REQUIRED</code> header). On Windows, type <code>curl.exe</code>:</p>
     <pre>curl -i "${esc(origin)}${esc(shop.buyPath)}${esc(query)}"</pre>
     <p>2. Let the AI agent buy, with real testnet USDC:</p>
     <pre>npm run buy -- --merchant ${esc(shop.ensName)}${esc(buyQuery)} --count ${shop.agentCount}</pre>
     ${sim}
     <p class="muted">Free price check for agents: <a href="/${shop.slug}/quote">/${shop.slug}/quote</a></p>`,
  );
}
