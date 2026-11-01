import { parseArgs } from "node:util";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { PrivateKey, createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import { env, envOr, flag, formatUsdc, hashscanTxUrl, resolveMerchant } from "@sangam/shared";

const { values: args } = parseArgs({
  options: {
    merchant: { type: "string" },
    count: { type: "string", default: "1" },
    from: { type: "string", default: "CSMT" },
    to: { type: "string", default: "PUNE" },
    date: { type: "string", default: new Date().toISOString().slice(0, 10) },
    query: { type: "string" }, // extra query params for the test shops, e.g. "items=chai,samosa"
  },
});
if (!args.merchant) {
  console.error('usage: npm run buy -- --merchant tickets.sangam.eth [--count 3] [--from CSMT --to PUNE] [--query "id=2"]');
  process.exit(1);
}

// Session budget the agent enforces itself, on top of the SDK's per-payment cap.
const budgetAtomic = BigInt(Math.round(Number(envOr("CUSTOMER_BUDGET_USDC", "2")) * 1e6));
let spentAtomic = 0n;

const merchant = await resolveMerchant(args.merchant);
const source = flag("ENS_OFFLINE") ? "local file, ENS offline" : "ENS";
console.log(`[agent] ${args.merchant} → ${merchant.endpoint} (₹${merchant.priceInrPaise / 100}, found via ${source})`);

const signer = createClientHederaSigner(
  env("CUSTOMER_ACCOUNT_ID"),
  PrivateKey.fromStringECDSA(env("CUSTOMER_PRIVATE_KEY")),
  { network: merchant.network },
);
const client = x402Client.fromConfig({
  schemes: [{ network: "hedera:*", client: new ExactHederaScheme(signer) }],
  spendControls: { maxAmountPerPayment: envOr("CUSTOMER_MAX_PER_PAYMENT", "$1") },
});
const payingFetch = wrapFetchWithPayment(fetch, client);
const http = new x402HTTPClient(client);

const url = new URL(merchant.endpoint);
url.searchParams.set("from", args.from);
url.searchParams.set("to", args.to);
url.searchParams.set("date", args.date);
for (const [key, value] of new URLSearchParams(args.query ?? "")) url.searchParams.set(key, value);

for (let i = 1; i <= Number(args.count); i++) {
  // Ask the price first (an unpaid request returns 402 with the requirements).
  const probe = await fetch(url);
  const requiredHeader = probe.headers.get("PAYMENT-REQUIRED");
  if (probe.status !== 402 || !requiredHeader) {
    console.error(`[agent] expected 402 from merchant, got ${probe.status}`);
    process.exit(1);
  }
  const quote = decodePaymentRequiredHeader(requiredHeader).accepts[0];
  if (!quote) throw new Error("merchant returned no payment options");
  const price = BigInt(quote.amount);
  if (spentAtomic + price > budgetAtomic) {
    console.log(`[agent] stopping: ${formatUsdc(price)} USDC would exceed the ${formatUsdc(budgetAtomic)} USDC budget`);
    break;
  }

  const res = await payingFetch(url);
  if (!res.ok) {
    // x402 settles only when the merchant delivers, so a failed purchase normally has no PAYMENT-RESPONSE.
    const charged = res.headers.get("PAYMENT-RESPONSE") ? "" : " (no payment settled, so not charged)";
    console.error(`[agent] purchase ${i} failed with ${res.status}${charged}: ${await res.text()}`);
    process.exit(1);
  }
  const goods = await res.json();
  const settle = http.getPaymentSettleResponse((name) => res.headers.get(name));
  spentAtomic += price;

  // The test shops send a one-line summary; merchant-api sends a rail ticket.
  const what = goods.summary ?? `PNR ${goods.pnr} · ${goods.train.name} · ${goods.coach}/${goods.seat}`;
  console.log(`[agent] #${i} paid ${formatUsdc(price)} USDC · ${what}`);
  console.log(`        ${hashscanTxUrl(settle.transaction)}`);
}

console.log(`[agent] done. spent ${formatUsdc(spentAtomic)} of ${formatUsdc(budgetAtomic)} USDC budget`);
