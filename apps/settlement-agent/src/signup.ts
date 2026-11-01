import { AccountCreateTransaction, Client, PrivateKey, PublicKey, TransferTransaction } from "@hiero-ledger/sdk";
import { HEDERA_TESTNET_USDC } from "@x402/hedera";
import { env, envOr } from "@sangam/shared";

// Limits on what the public sign-up can spend. Kept in memory, so they reset on
// restart: fine for test money, not for real money.
const MAX_PER_IP_PER_DAY = 3;
const MAX_PER_DAY = 50;

export class SignupRefused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let client: Client | null = null;
let counts = { day: "", total: 0, perIp: new Map<string, number>() };

function checkLimits(ip: string) {
  const day = new Date().toISOString().slice(0, 10);
  if (counts.day !== day) counts = { day, total: 0, perIp: new Map() };
  const fromIp = counts.perIp.get(ip) ?? 0;
  if (counts.total >= MAX_PER_DAY || fromIp >= MAX_PER_IP_PER_DAY) {
    throw new SignupRefused(429, "Too many sign-ups today. Try again tomorrow.");
  }
  counts.total++;
  counts.perIp.set(ip, fromIp + 1);
}

/** An account that already uses this key, so asking twice doesn't fund twice. */
async function existingAccount(publicKey: PublicKey): Promise<string | null> {
  const mirror = envOr("MIRROR_NODE_URL", "https://testnet.mirrornode.hedera.com");
  const res = await fetch(`${mirror}/api/v1/accounts?account.publickey=${publicKey.toStringRaw()}&balance=false&limit=1`);
  if (!res.ok) throw new Error(`mirror node returned ${res.status}`);
  const { accounts } = (await res.json()) as { accounts: { account: string }[] };
  return accounts[0]?.account ?? null;
}

/**
 * Open a Hedera testnet account for a key the user generated, and send it some
 * starter USDC. Only the public key is sent here; the private key stays with the user.
 */
export async function signup(publicKeyText: string, ip: string) {
  let publicKey: PublicKey;
  try {
    publicKey = PublicKey.fromStringECDSA(publicKeyText);
  } catch {
    throw new SignupRefused(400, "publicKey must be an ECDSA public key in hex.");
  }

  const existing = await existingAccount(publicKey);
  if (existing) return { accountId: existing, starterUsdc: "0", created: false };

  checkLimits(ip);
  const operator = env("OPERATOR_ACCOUNT_ID");
  client ??= Client.forTestnet().setOperator(operator, PrivateKey.fromStringECDSA(env("OPERATOR_PRIVATE_KEY")));

  // The one automatic association slot opts the account in to USDC when the
  // first USDC arrives, so the user never has to sign an association.
  const created = await new AccountCreateTransaction()
    .setKeyWithoutAlias(publicKey)
    .setMaxAutomaticTokenAssociations(1)
    .execute(client);
  const accountId = (await created.getReceipt(client)).accountId!.toString();

  const starterUsdc = envOr("SIGNUP_STARTER_USDC", "1");
  const atomic = Math.round(Number(starterUsdc) * 1e6);
  const token = envOr("HEDERA_USDC_TOKEN_ID", HEDERA_TESTNET_USDC);
  try {
    const funded = await new TransferTransaction()
      .addTokenTransfer(token, operator, -atomic)
      .addTokenTransfer(token, accountId, atomic)
      .execute(client);
    await funded.getReceipt(client);
  } catch (err) {
    // The account is still usable: it can receive USDC from a faucet.
    console.error(`[signup] could not fund ${accountId}: ${(err as Error).message}`);
    return { accountId, starterUsdc: "0", created: true };
  }
  return { accountId, starterUsdc, created: true };
}
