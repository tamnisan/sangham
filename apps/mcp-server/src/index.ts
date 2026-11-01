#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PrivateKey } from "@x402/hedera";
import { z } from "zod";
import { formatUsdc, getQuote, listShops, pay, signup, usdcBalance } from "./sangam.ts";
import { MAX_PER_DAY, MAX_PER_PURCHASE, createWallet, loadWallet, recordSpend, saveAccountId, spentToday } from "./wallet.ts";

const server = new McpServer(
  { name: "sangam", version: "0.1.0" },
  {
    instructions:
      "Buy from Sangam's shops with USDC on Hedera testnet (test money with no real value). Call setup_wallet once, " +
      "list_shops to see what's for sale and how to order, and get_price before buying. Tell the user the price and get their OK before calling buy.",
  },
);

/** Run a tool and turn its result, or its error message, into an MCP reply. */
async function reply(work: () => Promise<unknown>) {
  try {
    return { content: [{ type: "text" as const, text: JSON.stringify(await work(), null, 2) }] };
  } catch (err) {
    return { content: [{ type: "text" as const, text: (err as Error).message }], isError: true };
  }
}

function limits() {
  const spent = spentToday();
  return {
    maxPerPurchaseUsdc: formatUsdc(MAX_PER_PURCHASE),
    maxPerDayUsdc: formatUsdc(MAX_PER_DAY),
    spentTodayUsdc: formatUsdc(spent),
    leftTodayUsdc: formatUsdc(MAX_PER_DAY > spent ? MAX_PER_DAY - spent : 0n),
  };
}

function requireAccount() {
  const wallet = loadWallet();
  if (!wallet?.accountId) throw new Error("No wallet yet. Call setup_wallet first.");
  return { ...wallet, accountId: wallet.accountId };
}

const Order = z.record(z.string()).optional().describe('Order details from the shop\'s orderHelp, e.g. { "items": "chai,samosa" }');

server.registerTool(
  "setup_wallet",
  {
    description:
      "Create the user's Sangam wallet on this computer and open its Hedera testnet account with free starter USDC. Safe to call again: it won't create a second one.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  () =>
    reply(async () => {
      let wallet = loadWallet() ?? createWallet();
      let usdc: string;
      if (wallet.accountId) {
        usdc = formatUsdc(await usdcBalance(wallet.accountId));
      } else {
        const account = await signup(PrivateKey.fromStringECDSA(wallet.privateKey).publicKey.toStringRaw());
        wallet = saveAccountId(wallet, account.accountId);
        usdc = account.starterUsdc;
      }
      return { accountId: wallet.accountId, usdc, network: "Hedera testnet (test money, no real value)", ...limits() };
    }),
);

server.registerTool(
  "balance",
  {
    description: "Show the wallet's USDC balance, and how much of today's spending limit is left.",
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  () =>
    reply(async () => {
      const { accountId } = requireAccount();
      return { accountId, usdc: formatUsdc(await usdcBalance(accountId)), ...limits() };
    }),
);

server.registerTool(
  "list_shops",
  {
    description: "List Sangam's shops: what each sells and how to order from it. Prices here are the listed ones; use get_price for an exact order.",
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  () => reply(listShops),
);

server.registerTool(
  "get_price",
  {
    description: "Get the exact USDC price of an order, without paying.",
    inputSchema: { shop: z.string().describe("The shop's slug from list_shops"), order: Order },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  ({ shop, order }) =>
    reply(async () => {
      const quote = await getQuote(shop, order ?? {});
      return { shop, usdc: formatUsdc(quote.atomic), ...limits() };
    }),
);

server.registerTool(
  "buy",
  {
    description: "Pay a Sangam shop in USDC and return what was bought. This spends money, so confirm the price with the user first.",
    inputSchema: {
      shop: z.string().describe("The shop's slug from list_shops"),
      order: Order,
      max_price_usdc: z.number().positive().optional().describe("Refuse to pay more than this, e.g. the price the user agreed to"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  },
  ({ shop, order, max_price_usdc }) =>
    reply(async () => {
      const wallet = requireAccount();
      const quote = await getQuote(shop, order ?? {});
      const price = formatUsdc(quote.atomic);

      if (quote.atomic > MAX_PER_PURCHASE) {
        throw new Error(
          `This costs ${price} USDC, over the ${formatUsdc(MAX_PER_PURCHASE)} USDC limit per purchase. Only the user can raise it, with SANGAM_MAX_PER_PURCHASE_USDC in their MCP config.`,
        );
      }
      const spent = spentToday();
      const leftToday = MAX_PER_DAY > spent ? MAX_PER_DAY - spent : 0n;
      if (quote.atomic > leftToday) {
        throw new Error(
          `This costs ${price} USDC, and only ${formatUsdc(leftToday)} USDC of today's limit is left. Only the user can raise it, with SANGAM_MAX_PER_DAY_USDC in their MCP config.`,
        );
      }
      const maxPrice = max_price_usdc === undefined ? null : BigInt(Math.round(max_price_usdc * 1e6));
      if (maxPrice !== null && quote.atomic > maxPrice) {
        throw new Error(`This costs ${price} USDC, over the agreed maximum of ${max_price_usdc} USDC. Nothing was paid.`);
      }

      const limit = MAX_PER_PURCHASE < leftToday ? MAX_PER_PURCHASE : leftToday;
      const { goods, paidAtomic, transaction } = await pay(wallet, quote, maxPrice !== null && maxPrice < limit ? maxPrice : limit);
      recordSpend(paidAtomic);
      return { paidUsdc: formatUsdc(paidAtomic), goods, transaction, ...limits() };
    }),
);

await server.connect(new StdioServerTransport());
