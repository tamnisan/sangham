# Test shops

Five test merchants on one server (`apps/shops`). Each is a normal Sangam merchant: its record lists Sangam's treasury as `payTo`, so the AI agent pays Sangam in USDC over x402, and Sangam pays the shop in rupees over UPI. Each shop stresses a different part of Sangam.

| Shop | ENS name | Price | What it tests | Expected result |
|---|---|---|---|---|
| Rail Tickets | `rail.sangam.eth` | ₹49 | The normal case | paid |
| Paisa News | `news.sangam.eth` | ₹2 per article | Tiny payments: conversion, rounding and fee maths | paid, ₹1.99 payout |
| Monsoon Weather API | `weather.sangam.eth` | ₹1 per call | Many fast payments: the "runaway agent" rule (more than 5 a minute) | payments 6+ held |
| Tapri Kitchen | `food.sangam.eth` | ₹60 listed, ₹15–₹80 per order | Prices that change per order | ₹20 chai held, ₹80 thali paid |
| Indie Night Tickets | `concert.sangam.eth` | ₹75, 3 tickets | The shop failing after the agent pays | 4th buyer gets 410 and is not charged |

All prices stay under ₹88 (about $1), so they fit the buyer's default `CUSTOMER_MAX_PER_PAYMENT` cap.

> **Windows PowerShell:** type `npm.cmd` instead of `npm` for any command with `--` in it. Plain `npm` in PowerShell drops the `--`, and npm then fails with `Unknown cli flag`.

## 1. Run them locally, no keys needed

```bash
npm run settlement:sim     # terminal 1: settlement agent that trusts fake notices
npm run shops              # terminal 2: the five shops on http://localhost:3002
npm run dashboard          # terminal 3 (optional): http://localhost:5173
```

Open **http://localhost:3002** for the shop list. Each shop page shows its live merchant record and the exact commands to test it.

Then fake the payments with the simulator. Run the batches at least a minute apart, because the runaway rule counts every payment from the simulated buyer in the last minute, across all shops.

```bash
npm run simulate -- 1 --merchant rail.sangam.eth
npm run simulate -- 2 --merchant news.sangam.eth
npm run simulate -- 1 --merchant food.sangam.eth --inr 20   # chai only: held
npm run simulate -- 1 --merchant food.sangam.eth --inr 80   # thali: paid
# wait a minute, then:
npm run simulate -- 8 --merchant weather.sangam.eth
```

The concert test can't be simulated: it needs a real x402 payment, because the shop only runs its sold-out check after a payment has been verified.

You can see each shop's real x402 invoice without any keys:

```bash
curl -i "http://localhost:3002/food/order?items=chai,samosa"   # Windows: curl.exe
```

## 2. Real testnet payments

Do README Parts 3 and 4.1–4.2 first (Hedera accounts, USDC, HCS topic). Then set `hederaPayTo` for all five shops in `data/merchants.local.json` to your treasury account ID, set `SKIP_CHAIN_VERIFY=false`, and:

```bash
npm run settlement
npm run shops
npm run buy -- --merchant rail.sangam.eth
npm run buy -- --merchant news.sangam.eth --query "id=2" --count 3
npm run buy -- --merchant weather.sangam.eth --query "city=Delhi" --count 8
npm run buy -- --merchant food.sangam.eth --query "items=chai"
npm run buy -- --merchant concert.sangam.eth --count 4
```

The concert run should print 3 tickets, then `purchase 4 failed with 410 (no payment settled, so not charged)`. Restock it with the button on http://localhost:3002/concert, or restart the server.

## 3. Put them online

**Server (Render Blueprint, free plan).** `render.yaml` creates three services with every mock on: `sangam-settlement` (simulation mode), `sangam-shops` and `sangam-dashboard`. In Render, choose **New → Blueprint**, pick this repo and branch, and fill in the three URLs it asks for:

| Variable | Service | Value |
|---|---|---|
| `SETTLEMENT_AGENT_URL` | sangam-shops | `https://sangam-settlement.onrender.com` |
| `VITE_SETTLEMENT_URL` | sangam-dashboard | `https://sangam-settlement.onrender.com` |
| `VITE_MERCHANT_URL` | sangam-dashboard | `https://sangam-shops.onrender.com/rail` |

If Render adds a suffix to a name because it's taken (like `sangam-shops-x1y2.onrender.com`), fix the value in that service's **Environment** tab, then redeploy. For the dashboard, redeploy after changing a `VITE_` value, because those are baked in at build time.

Free services sleep after about 15 minutes idle, and the first request after that takes about a minute. The settlement agent's payment list also resets when it sleeps.

To run the simulator on your PC against the deployed agent, copy `SETTLEMENT_SHARED_SECRET` from the `sangam-shared` environment group in Render, then in PowerShell:

```powershell
$env:SETTLEMENT_AGENT_URL="https://sangam-settlement.onrender.com"; $env:SETTLEMENT_SHARED_SECRET="<copied value>"
npm.cmd run simulate -- 1 --merchant rail.sangam.eth
```

For real payments, the shops need your Hedera treasury account and an ENS record or merchant file pointing at the public URL. Until then, each shop page's "Paid link" shows the `localhost` address from `data/merchants.local.json`.

**ENS names (Sepolia, free).** On https://sepolia.app.ens.domains, register one name, for example `yourname.eth`, then create five subnames under it: `rail`, `news`, `weather`, `food`, `concert`. Publish each shop's records:

```bash
npm run register-merchant -- --name rail.yourname.eth    --url https://<shops>.onrender.com/rail/book       --payTo <treasury> --price 4900 --upi rail@razorpay
npm run register-merchant -- --name news.yourname.eth    --url https://<shops>.onrender.com/news/article    --payTo <treasury> --price 200  --upi news@razorpay
npm run register-merchant -- --name weather.yourname.eth --url https://<shops>.onrender.com/weather/now     --payTo <treasury> --price 100  --upi weather@razorpay
npm run register-merchant -- --name food.yourname.eth    --url https://<shops>.onrender.com/food/order      --payTo <treasury> --price 6000 --upi food@razorpay
npm run register-merchant -- --name concert.yourname.eth --url https://<shops>.onrender.com/concert/ticket  --payTo <treasury> --price 7500 --upi concert@razorpay
```

Then set `SHOPS_ENS_PARENT=yourname.eth` and `ENS_OFFLINE=false`, on the shops server, the settlement agent, and wherever you run the buyer. Each shop page shows an error box if its ENS records are missing.

## What these tests found

Found with the simulator on 2026-11-01:

1. **Variable prices get held.** Sangam checks each payment against the one price in the merchant's ENS record. Any order more than 5% below that price, like a ₹20 chai at a shop listed at ₹60, is held as an underpayment, even though the agent paid exactly what the shop asked for.
2. **A burst of payments holds all of them.** The runaway rule counts every payment from the buyer in the last minute, including ones that arrived *after* the payment being decided. When 8 payments arrive at once, all 8 are held, not just payments 6 to 8.
