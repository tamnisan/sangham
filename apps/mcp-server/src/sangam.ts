import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { HEDERA_TESTNET_USDC, PrivateKey, createClientHederaSigner } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/client";
import type { Wallet } from "./wallet.ts";

const SHOPS_URL = process.env.SANGAM_SHOPS_URL || "https://sangam-shops.onrender.com";
const SETTLEMENT_URL = process.env.SANGAM_SETTLEMENT_URL || "https://sangam-settlement.onrender.com";
const MIRROR_URL = "https://testnet.mirrornode.hedera.com";
const NETWORK = "hedera:testnet";

// Shorter than the 60 seconds many AI apps give a tool call, so a sleeping
// server gives a useful message and not a generic timeout.
const TIMEOUT_MS = 55_000;

export type Order = Record<string, string>;
export type Shop = { slug: string; payTo: string; buyUrl: string; [detail: string]: unknown };
export type Quote = { shop: Shop; url: URL; atomic: bigint };

async function request(url: string | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    const { host } = new URL(url);
    throw new Error(`Couldn't reach ${host}. Sangam's free servers sleep when idle and take about a minute to wake. Try again shortly.`);
  }
}

export const formatUsdc = (atomic: bigint) => (Number(atomic) / 1e6).toFixed(6);

export async function listShops(): Promise<Shop[]> {
  const res = await request(`${SHOPS_URL}/shops`);
  if (!res.ok) throw new Error(`The shop list returned ${res.status}.`);
  return (await res.json()) as Shop[];
}

export async function signup(publicKey: string): Promise<{ accountId: string; starterUsdc: string }> {
  const res = await request(`${SETTLEMENT_URL}/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ publicKey }),
  });
  const body = (await res.json().catch(() => ({}))) as { accountId?: string; starterUsdc?: string; error?: string };
  if (!res.ok || !body.accountId) throw new Error(body.error ?? `Sign-up returned ${res.status}.`);
  return { accountId: body.accountId, starterUsdc: body.starterUsdc ?? "0" };
}

export async function usdcBalance(accountId: string): Promise<bigint> {
  const res = await request(`${MIRROR_URL}/api/v1/accounts/${accountId}/tokens?token.id=${HEDERA_TESTNET_USDC}`);
  if (!res.ok) throw new Error(`Hedera's mirror node returned ${res.status}.`);
  const { tokens } = (await res.json()) as { tokens: { balance: number }[] };
  return BigInt(tokens[0]?.balance ?? 0);
}

/** Ask the shop for its invoice without paying. */
export async function getQuote(slug: string, order: Order): Promise<Quote> {
  const shops = await listShops();
  const shop = shops.find((s) => s.slug === slug);
  if (!shop) throw new Error(`No shop called "${slug}". Shops: ${shops.map((s) => s.slug).join(", ")}.`);

  const url = new URL(shop.buyUrl);
  for (const [key, value] of Object.entries(order)) url.searchParams.set(key, value);

  const res = await request(url, { headers: { accept: "application/json" } });
  const header = res.headers.get("PAYMENT-REQUIRED");
  if (res.status !== 402 || !header) throw new Error(`${slug} refused this order (${res.status}): ${await res.text()}`);

  const invoice = decodePaymentRequiredHeader(header).accepts[0];
  if (!invoice || invoice.asset !== HEDERA_TESTNET_USDC || invoice.payTo !== shop.payTo) {
    throw new Error(`${slug} sent an invoice that doesn't match its shop listing, so it won't be paid.`);
  }
  return { shop, url, atomic: BigInt(invoice.amount) };
}

/** Pay the invoice over x402. `allowedAtomic` is the most this purchase may cost. */
export async function pay(wallet: Wallet, quote: Quote, allowedAtomic: bigint) {
  const signer = createClientHederaSigner(wallet.accountId!, PrivateKey.fromStringECDSA(wallet.privateKey), { network: NETWORK });
  const client = x402Client.fromConfig({
    schemes: [{ network: "hedera:*", client: new ExactHederaScheme(signer) }],
    spendControls: { maxAmountPerPayment: `$${formatUsdc(allowedAtomic)}` },
    // Checked again at signing time, since x402 fetches its own copy of the invoice.
    policies: [
      (_version, options) =>
        options.filter(
          (o) =>
            o.network === NETWORK &&
            o.asset === HEDERA_TESTNET_USDC &&
            o.payTo === quote.shop.payTo &&
            BigInt(o.amount) <= allowedAtomic,
        ),
    ],
  });

  const res = await wrapFetchWithPayment(fetch, client)(quote.url, { headers: { accept: "application/json" } });
  // A second 402 means the shop turned the signed payment down.
  if (res.status === 402) {
    throw new Error("The payment was rejected, and nothing was charged. The usual cause is too little USDC, so check the balance tool.");
  }
  if (!res.ok) {
    // x402 settles only when the shop delivers, so a failure normally has no PAYMENT-RESPONSE.
    const charged = res.headers.get("PAYMENT-RESPONSE") ? "" : " No payment was settled, so nothing was charged.";
    throw new Error(`The purchase failed (${res.status}).${charged} ${await res.text()}`);
  }

  const goods = (await res.json()) as Record<string, unknown>;
  const settled = new x402HTTPClient(client).getPaymentSettleResponse((name) => res.headers.get(name));
  return {
    goods,
    paidAtomic: BigInt(settled.amount ?? quote.atomic),
    transaction: `https://hashscan.io/testnet/transaction/${encodeURIComponent(settled.transaction)}`,
  };
}
