import express from "express";
import { z } from "zod";
import { env, envOr, flag, inrPerUsd, paiseToUsdcAtomic, resolveMerchant } from "@sangam/shared";
import { ogBalance } from "./decide.ts";
import { DuplicateSettlementError, acceptNotice } from "./pipeline.ts";
import { listSettlements } from "./store.ts";

const NoticeSchema = z.object({
  merchant: z.string().min(1),
  hederaTxId: z.string().min(1),
  payer: z.string().optional(),
  usdcAmount: z.string().regex(/^\d+$/),
});

const sharedSecret = env("SETTLEMENT_SHARED_SECRET");
const app = express();
app.use(express.json());

// The dashboard runs on another port (another origin once deployed). Its JSON
// POSTs make the browser send a CORS preflight first, so answer that too.
app.use((req, res, next) => {
  res.setHeader("access-control-allow-origin", envOr("DASHBOARD_ORIGIN", "*"));
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

app.post("/settlements", async (req, res) => {
  if (req.header("x-sangam-key") !== sharedSecret) {
    res.status(401).json({ error: "bad x-sangam-key" });
    return;
  }
  const notice = NoticeSchema.safeParse(req.body);
  if (!notice.success) {
    res.status(400).json({ error: notice.error.message });
    return;
  }
  try {
    res.status(202).json(await acceptNotice(notice.data));
  } catch (err) {
    if (err instanceof DuplicateSettlementError) res.status(409).json({ error: err.message });
    else throw err;
  }
});

// Dev only: the dashboard's "simulate" buttons. Exists only while
// SKIP_CHAIN_VERIFY=true, since that already means notices aren't checked on-chain.
if (flag("SKIP_CHAIN_VERIFY")) {
  app.post("/dev/simulate", async (req, res) => {
    const merchantName = env("MERCHANT_ENS_NAME");
    const merchant = await resolveMerchant(merchantName);
    let atomic = paiseToUsdcAtomic(merchant.priceInrPaise, await inrPerUsd());
    if (req.body?.short) atomic = (atomic * 9n) / 10n;
    res.status(202).json(
      await acceptNotice({
        merchant: merchantName,
        hederaTxId: `sim-0.0.1001@${Date.now()}.0`,
        payer: "0.0.1001",
        usdcAmount: atomic.toString(),
      }),
    );
  });
}

app.get("/settlements", (_req, res) => {
  res.json(listSettlements());
});

app.get("/stats", async (_req, res) => {
  const all = listSettlements();
  let og: string | null = null;
  try {
    og = await ogBalance();
  } catch (err) {
    console.warn(`[stats] could not read 0G ledger: ${(err as Error).message}`);
  }
  res.json({
    count: all.length,
    usdcInAtomic: all.reduce((sum, s) => sum + BigInt(s.usdcAmount), 0n).toString(),
    inrPaidOutPaise: all.filter((s) => s.status === "paid").reduce((sum, s) => sum + (s.payoutPaise ?? 0), 0),
    ogBalance: og,
    hcsTopicId: process.env.HCS_TOPIC_ID || null,
    mocks: {
      og: flag("OG_MOCK"),
      psp: envOr("PSP_MODE", "mock") === "mock",
      chainVerify: flag("SKIP_CHAIN_VERIFY"),
      ens: flag("ENS_OFFLINE"),
    },
  });
});

const port = Number(process.env.PORT || envOr("SETTLEMENT_AGENT_PORT", "3001"));
app.listen(port, () => {
  console.log(`[settlement] listening on :${port}`);
});
