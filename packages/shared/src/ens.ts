import { readFileSync } from "node:fs";
import path from "node:path";
import { createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";
import { normalize } from "viem/ens";
import { REPO_ROOT, envOr, flag } from "./config.ts";
import type { MerchantRecord } from "./types.ts";

/** ENS text-record keys a Sangam merchant publishes. */
export const MERCHANT_TEXT_KEYS = {
  endpoint: "url",
  hederaPayTo: "sangam.payTo",
  network: "sangam.network",
  priceInrPaise: "sangam.priceInrPaise",
  upiHandle: "sangam.upi",
} as const;

const CACHE_MS = 60_000;
const cache = new Map<string, { record: MerchantRecord; at: number }>();

/**
 * Look a merchant up by ENS name. This is the only place any app learns a
 * merchant's URL, Hedera account or UPI handle.
 *
 * ENS_OFFLINE=true reads data/merchants.local.json instead (dev only), or the
 * file named by MERCHANTS_FILE, e.g. data/merchants.render.json for the deployed shops.
 */
export async function resolveMerchant(ensName: string): Promise<MerchantRecord> {
  const hit = cache.get(ensName);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.record;

  const record = flag("ENS_OFFLINE") ? readLocalMerchant(ensName) : await readEnsMerchant(ensName);
  cache.set(ensName, { record, at: Date.now() });
  return record;
}

async function readEnsMerchant(ensName: string): Promise<MerchantRecord> {
  const client = createPublicClient({ chain: sepolia, transport: http(process.env.SEPOLIA_RPC_URL) });
  const name = normalize(ensName);
  const values: Partial<Record<keyof typeof MERCHANT_TEXT_KEYS, string>> = {};

  await Promise.all(
    (Object.keys(MERCHANT_TEXT_KEYS) as (keyof typeof MERCHANT_TEXT_KEYS)[]).map(async (field) => {
      const value = await client.getEnsText({ name, key: MERCHANT_TEXT_KEYS[field] });
      if (value) values[field] = value;
    }),
  );

  const missing = (Object.keys(MERCHANT_TEXT_KEYS) as (keyof typeof MERCHANT_TEXT_KEYS)[]).filter((f) => !values[f]);
  if (missing.length > 0) {
    const keys = missing.map((f) => MERCHANT_TEXT_KEYS[f]).join(", ");
    throw new Error(`${ensName} is missing ENS text records: ${keys}`);
  }

  return toRecord(ensName, values as Record<keyof typeof MERCHANT_TEXT_KEYS, string>);
}

function readLocalMerchant(ensName: string): MerchantRecord {
  const name = envOr("MERCHANTS_FILE", "data/merchants.local.json");
  const all = JSON.parse(readFileSync(path.join(REPO_ROOT, name), "utf8")) as Record<string, Record<keyof typeof MERCHANT_TEXT_KEYS, string>>;
  const values = all[ensName];
  if (!values) throw new Error(`${ensName} not found in ${name}`);
  return toRecord(ensName, values);
}

function toRecord(ensName: string, v: Record<keyof typeof MERCHANT_TEXT_KEYS, string>): MerchantRecord {
  const priceInrPaise = Number(v.priceInrPaise);
  if (!Number.isInteger(priceInrPaise) || priceInrPaise <= 0) {
    throw new Error(`${ensName}: sangam.priceInrPaise must be a positive integer, got "${v.priceInrPaise}"`);
  }
  return {
    ensName,
    endpoint: v.endpoint,
    hederaPayTo: v.hederaPayTo,
    network: v.network,
    upiHandle: v.upiHandle,
    priceInrPaise,
  };
}
