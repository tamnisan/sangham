import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { PrivateKey } from "@x402/hedera";

// The wallet lives on the user's own computer, and no tool returns the private
// key. The file is plain text, though: an AI or program that can read files here
// could still open it, so this wallet is only for small amounts.
const home = process.env.SANGAM_HOME || path.join(homedir(), ".sangam");
const walletFile = path.join(home, "wallet.json");
const spendingFile = path.join(home, "spending.json");

export type Wallet = { privateKey: string; accountId: string | null };

function save(file: string, data: unknown) {
  mkdirSync(home, { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

export function loadWallet(): Wallet | null {
  return existsSync(walletFile) ? (JSON.parse(readFileSync(walletFile, "utf8")) as Wallet) : null;
}

export function createWallet(): Wallet {
  const wallet = { privateKey: PrivateKey.generateECDSA().toStringRaw(), accountId: null };
  save(walletFile, wallet);
  return wallet;
}

export function saveAccountId(wallet: Wallet, accountId: string): Wallet {
  const updated = { ...wallet, accountId };
  save(walletFile, updated);
  return updated;
}

// Spending limits come from the user's MCP config. No tool changes them, so an
// AI tricked by a web page can't raise its own limit through this server.
function limitFromEnv(name: string, fallback: string): bigint {
  const usdc = Number(process.env[name] || fallback);
  if (!(usdc > 0)) throw new Error(`${name} must be a positive number of USDC`);
  return BigInt(Math.round(usdc * 1e6));
}

export const MAX_PER_PURCHASE = limitFromEnv("SANGAM_MAX_PER_PURCHASE_USDC", "1");
export const MAX_PER_DAY = limitFromEnv("SANGAM_MAX_PER_DAY_USDC", "5");

const today = () => new Date().toISOString().slice(0, 10);

export function spentToday(): bigint {
  if (!existsSync(spendingFile)) return 0n;
  const { day, atomic } = JSON.parse(readFileSync(spendingFile, "utf8")) as { day: string; atomic: string };
  return day === today() ? BigInt(atomic) : 0n;
}

export function recordSpend(atomic: bigint) {
  save(spendingFile, { day: today(), atomic: (spentToday() + atomic).toString() });
}
