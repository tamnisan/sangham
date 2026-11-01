// Five test merchants on one server. Each is a normal Sangam merchant: its ENS
// record says what it costs and lists Sangam's treasury as payTo, so agents pay
// Sangam over x402 and Sangam pays the shop in rupees over UPI.
import express from "express";
import { HTTPFacilitatorClient, type HTTPRequestContext, type HTTPTransportContext } from "@x402/core/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HEDERA_TESTNET_USDC, HEDERA_USDC_DECIMALS } from "@x402/hedera";
import { ExactHederaScheme } from "@x402/hedera/exact/server";
import {
  env,
  envOr,
  formatUsdc,
  inrPerUsd,
  paiseToUsdcAtomic,
  resolveMerchant,
  type SettlementNotice,
} from "@sangam/shared";
import { homePage, shopPage, type PageQuote } from "./pages.ts";
import { SHOPS, type Query, type Shop } from "./shops.ts";

const NETWORK = "hedera:testnet";
const usdcTokenId = envOr("HEDERA_USDC_TOKEN_ID", HEDERA_TESTNET_USDC);
const settlementUrl = envOr("SETTLEMENT_AGENT_URL", "http://localhost:3001");

/** This request's price in paise: the shop's own price for the order, or its listed ENS price. */
async function pricePaise(shop: Shop, query: Query): Promise<number> {
  return shop.pricePaise ? shop.pricePaise(query) : (await resolveMerchant(shop.ensName)).priceInrPaise;
}

const queryOf = (ctx: HTTPRequestContext): Query => ctx.adapter.getQueryParams?.() ?? {};

const facilitator = new HTTPFacilitatorClient({
  url: envOr("FACILITATOR_URL", "https://api.testnet.blocky402.com"),
});

const resourceServer = new x402ResourceServer(facilitator).register(
  "hedera:*",
  new ExactHederaScheme({
    defaultAssets: { [NETWORK]: { asset: usdcTokenId, decimals: HEDERA_USDC_DECIMALS } },
  }),
);

// Hand every settled payment to the settlement agent, under the name of the
// shop that was paid. All shops share one server, so the request path says which.
resourceServer.onAfterSettle(async ({ result, requirements, transportContext }) => {
  if (!result.success) return;
  const path = (transportContext as HTTPTransportContext | undefined)?.request.path;
  const shop = SHOPS.find((s) => s.buyPath === path);
  if (!shop) {
    console.error(`[shops] settled ${result.transaction}, but no shop owns ${path}`);
    return;
  }
  const notice: SettlementNotice = {
    merchant: shop.ensName,
    hederaTxId: result.transaction,
    payer: result.payer,
    usdcAmount: result.amount ?? requirements.amount,
  };
  console.log(`[shops] ${shop.slug}: settled ${notice.hederaTxId} for ${formatUsdc(notice.usdcAmount)} USDC`);
  fetch(`${settlementUrl}/settlements`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sangam-key": env("SETTLEMENT_SHARED_SECRET") },
    body: JSON.stringify(notice),
  }).catch((err) => console.error(`[shops] could not notify settlement agent: ${err.message}`));
});

const app = express();

app.use((_req, res, next) => {
  res.setHeader("access-control-allow-origin", envOr("DASHBOARD_ORIGIN", "*"));
  res.setHeader("access-control-expose-headers", "PAYMENT-REQUIRED, PAYMENT-RESPONSE");
  next();
});

app.get("/health", (_req, res) => {
  res.json({ ok: true, shops: SHOPS.map((s) => s.ensName) });
});

app.get("/", (_req, res) => {
  res.send(homePage(SHOPS));
});

// The shop list agents browse. Exact prices come from each shop's 402 invoice.
app.get("/shops", async (_req, res) => {
  const listings = await Promise.all(
    SHOPS.map(async (shop) => {
      const merchant = await resolveMerchant(shop.ensName).catch(() => null);
      if (!merchant) return null;
      return {
        slug: shop.slug,
        ensName: shop.ensName,
        title: shop.title,
        sells: shop.sells,
        orderHelp: shop.orderHelp,
        example: shop.example,
        listedPriceInr: merchant.priceInrPaise / 100,
        payTo: merchant.hederaPayTo,
        buyUrl: merchant.endpoint,
        ...shop.extras?.(),
      };
    }),
  );
  res.json(listings.filter(Boolean));
});

for (const shop of SHOPS) {
  app.get(`/${shop.slug}`, async (req, res) => {
    let quote: PageQuote;
    try {
      const merchant = await resolveMerchant(shop.ensName);
      const atomic = paiseToUsdcAtomic(merchant.priceInrPaise, await inrPerUsd());
      quote = {
        ok: true,
        priceInr: merchant.priceInrPaise / 100,
        priceUsdc: formatUsdc(atomic),
        payTo: merchant.hederaPayTo,
        upiHandle: merchant.upiHandle,
        endpoint: merchant.endpoint,
      };
    } catch (err) {
      quote = { ok: false, error: (err as Error).message };
    }
    res.send(shopPage(shop, quote, `${req.protocol}://${req.get("host")}`));
  });

  // Free price check, so an agent can decide before paying.
  app.get(`/${shop.slug}/quote`, async (_req, res) => {
    const merchant = await resolveMerchant(shop.ensName);
    res.json({
      merchant: shop.ensName,
      priceInr: merchant.priceInrPaise / 100,
      priceUsdc: formatUsdc(paiseToUsdcAtomic(merchant.priceInrPaise, await inrPerUsd())),
      network: merchant.network,
      payTo: merchant.hederaPayTo,
      upiHandle: merchant.upiHandle,
      buy: merchant.endpoint,
      ...shop.extras?.(),
    });
  });

  for (const [name, action] of Object.entries(shop.actions ?? {})) {
    app.post(`/${shop.slug}/${name}`, (_req, res) => {
      action();
      res.redirect(303, `/${shop.slug}`);
    });
  }

  // Runs before the paywall: turn away broken requests (and shops with no
  // merchant record) without asking anyone to pay.
  app.get(shop.buyPath, async (req, res, next) => {
    try {
      await resolveMerchant(shop.ensName);
    } catch (err) {
      res.status(503).json({ error: (err as Error).message });
      return;
    }
    const problem = shop.check?.(req.query);
    if (problem) {
      res.status(400).json({ error: problem });
      return;
    }
    next();
  });
}

app.use(
  paymentMiddleware(
    Object.fromEntries(
      SHOPS.map((shop) => [
        `GET ${shop.buyPath}`,
        {
          accepts: {
            scheme: "exact",
            network: NETWORK,
            payTo: async () => (await resolveMerchant(shop.ensName)).hederaPayTo,
            price: async (ctx: HTTPRequestContext) => {
              const paise = await pricePaise(shop, queryOf(ctx));
              return `$${formatUsdc(paiseToUsdcAtomic(paise, await inrPerUsd()))}`;
            },
          },
          description: `${shop.title} (${shop.ensName})`,
          mimeType: "application/json",
        },
      ]),
    ),
    resourceServer,
  ),
);

// Reached only once x402 has verified the payment. Settlement happens after
// this answers, and only if the status is below 400.
for (const shop of SHOPS) {
  app.get(shop.buyPath, (req, res) => {
    const { status = 200, body } = shop.deliver(req.query);
    res.status(status).json(body);
  });
}

const port = Number(process.env.PORT || envOr("SHOPS_PORT", "3002"));
app.listen(port, async () => {
  console.log(`[shops] ${SHOPS.length} test shops on http://localhost:${port}`);
  for (const shop of SHOPS) {
    try {
      const merchant = await resolveMerchant(shop.ensName);
      console.log(`  ${shop.ensName.padEnd(20)} ₹${merchant.priceInrPaise / 100}\thttp://localhost:${port}/${shop.slug}`);
    } catch (err) {
      console.warn(`  ${shop.ensName.padEnd(20)} not ready: ${(err as Error).message}`);
    }
  }
});
