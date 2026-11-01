// Dev only: send fake settlement notices so you can test settlement-agent and
// the dashboard without Hedera accounts. The agent must run with SKIP_CHAIN_VERIFY=true.
//   npm run simulate -- [count] [--short] [--merchant news.sangam.eth] [--inr 20]
import { parseArgs } from "node:util";
import { env, envOr, inrPerUsd, paiseToUsdcAtomic, resolveMerchant } from "@sangam/shared";

const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    short: { type: "boolean", default: false }, // underpay by 10% to exercise the "hold" path
    merchant: { type: "string" }, // default: MERCHANT_ENS_NAME
    inr: { type: "string" }, // pay this many rupees instead of the listed price
  },
});

const count = Number(positionals[0] ?? 1);
const merchantName = a.merchant ?? env("MERCHANT_ENS_NAME");
const merchant = await resolveMerchant(merchantName);
const paise = a.inr ? Math.round(Number(a.inr) * 100) : merchant.priceInrPaise;
let atomic = paiseToUsdcAtomic(paise, await inrPerUsd());
if (a.short) atomic = (atomic * 9n) / 10n;

for (let i = 0; i < count; i++) {
  const res = await fetch(`${envOr("SETTLEMENT_AGENT_URL", "http://localhost:3001")}/settlements`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sangam-key": env("SETTLEMENT_SHARED_SECRET") },
    body: JSON.stringify({
      merchant: merchantName,
      hederaTxId: `sim-0.0.1001@${Date.now()}.${i}`,
      payer: "0.0.1001",
      usdcAmount: atomic.toString(),
    }),
  });
  console.log(res.status, JSON.stringify(await res.json()).slice(0, 120));
}
