# Sangam

**Agents pay in USDC. Merchants get rupees.**

Sangam is a settlement rail for the agent economy. An AI agent pays an Indian merchant's API over x402 in USDC on Hedera. Sangam checks the payment on-chain, decides how to settle it with 0G Compute, pays the merchant in INR over UPI, and writes a receipt to a Hedera Consensus Service (HCS) topic. Agents find merchants by ENS name.

This guide takes you from a fresh machine to a real payment. Do the parts in order.

- [How it works](#how-it-works)
- [Part 1: Install](#part-1-install) (macOS, Linux, Windows)
- [Part 2: Run it with mocks (no keys)](#part-2-run-it-with-mocks-no-keys)
- [Part 3: Create accounts and keys](#part-3-create-accounts-and-keys)
- [Part 4: Turn on the real services](#part-4-turn-on-the-real-services)
- [Part 5: Make a real payment](#part-5-make-a-real-payment)
- [Part 6: Deploy](#part-6-deploy)
- [Running on Windows](#running-on-windows)
- [Reference](#reference): commands, env variables, mode switches, layout
- [Troubleshooting](#troubleshooting)
- [What's verified](#whats-verified)

---

## How it works

The payer is an AI agent, not a person, so there's no QR code. The merchant's server answers with **HTTP 402 Payment Required**, a machine-readable invoice. The agent reads it, signs a USDC transfer, and retries.

```
1  customer-agent looks up tickets.sangam.eth on ENS → URL, price, payTo, UPI ID
2  customer-agent: GET /book         → merchant-api replies 402 + invoice
3  customer-agent signs a USDC transfer; the x402 facilitator submits it on Hedera
   merchant-api returns the ticket, then notifies settlement-agent
4  settlement-agent: confirm the transfer on the Mirror Node
                     decide with 0G Compute (pay out or hold, fee)
5                    pay the merchant INR over UPI (RazorpayX test mode)
                     write a receipt to an HCS topic
   dashboard shows every step
```

| Service | Port | What it does |
|---|---|---|
| `merchant-api` | 3000 | The merchant's shop: rail tickets behind an x402 paywall |
| `settlement-agent` | 3001 | Confirms, decides, pays out, writes receipts |
| `dashboard` | 5173 | Shows the flow, the live invoice, every payment |
| `customer-agent` | (CLI) | The buyer: pays with no human approval |

---

## Part 1: Install

**You need:** Node.js 22 and npm, on macOS, Linux or Windows.

**1. Install Node 22**

| OS | How |
|---|---|
| macOS | `brew install node@22`, then `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"` (add that line to `~/.zshrc` to keep it) |
| Linux | your package manager, or https://nodejs.org |
| Windows | `winget install OpenJS.NodeJS.LTS`, or the installer from https://nodejs.org. Open a **new** terminal afterwards. |

**2. Install the project**

```bash
node -v             # should print v22.x
cd sangam
npm install
npm run typecheck   # should print nothing and exit cleanly
```

**3. Create `.env`** (skip if the folder already has one)

```bash
cp .env.example .env        # Windows PowerShell: Copy-Item .env.example .env
npm run gen-keys            # prints SETTLEMENT_SHARED_SECRET and an EVM key
```

Paste the printed `SETTLEMENT_SHARED_SECRET` into `.env`. Keep the rest of the output for step 3.2.

Every `npm run …` command in this guide works the same on all three OSes. On Windows, see [Running on Windows](#running-on-windows) for the few other commands that differ.

---

## Part 2: Run it with mocks (no keys)

Before any accounts exist, every external service can be mocked, so you can see the whole flow. The dashboard shows a yellow badge for each mock that's on.

Open three terminals in `sangam/`:

```bash
# terminal 1: settlement agent in simulation mode
npm run settlement:sim

# terminal 2: merchant
npm run merchant

# terminal 3: dashboard
npm run dashboard
```

Open **http://localhost:5173** and click **Send a payment**. Watch it move through the five steps. **Send an underpayment** shows the "held" path.

Other things to try:

```bash
curl -s localhost:3000/quote                     # the merchant's price
curl -i "localhost:3000/book?from=CSMT&to=PUNE"  # the real 402 invoice (PAYMENT-REQUIRED header)
npm run simulate -- 3                            # three payments from the command line
```

On Windows PowerShell, type `curl.exe` instead of `curl`. Or just open http://localhost:3000/quote in a browser.

`settlement:sim` is the normal settlement agent with `SKIP_CHAIN_VERIFY=true`: it trusts payment notices without checking the chain. Only that run is affected; `.env` isn't changed. The simulate buttons only appear in this mode.

---

## Part 3: Create accounts and keys

You need **2 Hedera accounts** and **1 EVM key**. Use fresh testnet-only keys, never a wallet that holds real money.

### 3.1 Hedera testnet accounts (customer + treasury)

1. Go to **https://portal.hedera.com**, sign up, and choose **Testnet**.
2. Create an account with an **ECDSA** key. Copy its **account ID** (`0.0.xxxxx`) and its **private key**. Hex, `0x`-hex and DER formats all work.
3. Do it again for a second account.
4. Paste them into the bottom of `.env`:

```bash
CUSTOMER_ACCOUNT_ID=0.0.xxxxx      # the buyer agent
CUSTOMER_PRIVATE_KEY=...
TREASURY_ACCOUNT_ID=0.0.yyyyy      # receives the USDC
TREASURY_PRIVATE_KEY=...
OPERATOR_ACCOUNT_ID=0.0.yyyyy      # pays for HCS receipts; copy the treasury values
OPERATOR_PRIVATE_KEY=...
```

New portal accounts come with testnet HBAR. Each account needs about 10 HBAR. The x402 transfer fee is paid by the facilitator, not the agent.

### 3.2 One EVM key (for 0G and ENS)

Use the key `npm run gen-keys` printed in Part 1, or run it again for a new one:

```bash
npm run gen-keys
```

Put the key in both lines, and keep the printed address handy for the faucets:

```bash
OG_PRIVATE_KEY=0x...
ENS_OWNER_PRIVATE_KEY=0x...
```

### 3.3 Test tokens

| Token | Amount | Where | Send to |
|---|---|---|---|
| HBAR | ~10 per account | comes with portal accounts | — |
| USDC (Hedera testnet) | 10 | https://faucet.circle.com, choose **Hedera Testnet** | the **customer** account. Do step 4.1 first: the account must be associated with USDC before it can receive it. |
| OG | ~2 | https://faucet.0g.ai | your EVM address |
| Sepolia ETH | ~0.05 | any Sepolia faucet, e.g. Google Cloud's Web3 faucet | your EVM address |

One ₹49 ticket costs about 0.52 USDC, so 10 USDC buys about 19 tickets. To make it last while testing, lower the price (see 4.4).

If a faucet gives too little OG, ask in 0G's Discord. Their hackathon prize page says teams get free credits.

### 3.4 RazorpayX test keys (optional)

Only needed for real UPI payouts in test mode. Without them, payouts stay mocked and everything else works.

1. Sign up at https://razorpay.com and enable **RazorpayX**. Approval can take days, so start early.
2. In **test mode**, create API keys and note your RazorpayX account number.
3. Fill in `PSP_KEY_ID`, `PSP_KEY_SECRET`, `RAZORPAYX_ACCOUNT_NUMBER`.

---

## Part 4: Turn on the real services

Each step replaces one mock. After each one, run the check under it before moving on.

### 4.1 Hedera: associate USDC

```bash
npm run setup-hedera
```

This links testnet USDC (`0.0.429274`) to the customer and treasury accounts, then prints every balance. Now get USDC from the Circle faucet for the customer (3.3), and run it again:

```bash
npm run setup-hedera
# customer  0.0.xxxxx       1000.00 HBAR   10.00 USDC
# treasury  0.0.yyyyy       1000.00 HBAR   0.00 USDC
# operator  0.0.yyyyy       1000.00 HBAR   0.00 USDC
```

Then open `data/merchants.local.json` and set `hederaPayTo` to your **treasury** ID. The script warns you if it doesn't match.

### 4.2 Hedera: create the receipt topic

```bash
npm run create-topic
# HCS_TOPIC_ID=0.0.zzzzz
# https://hashscan.io/testnet/topic/0.0.zzzzz
```

Paste `HCS_TOPIC_ID` into `.env`.

### 4.3 0G: fund inference

```bash
npm run setup-0g             # prints your OG balance and the list of providers
```

Pick a provider address from the list and set `OG_PROVIDER_ADDRESS` in `.env`. Then:

```bash
npm run setup-0g -- fund     # opens the ledger (1 OG) and funds the provider (0.5 OG)
```

The testnet contract minimums are 0.1 OG for the ledger and 0.01 OG per provider. Change `OG_LEDGER_DEPOSIT` / `OG_PROVIDER_FUND` if you have less. Finally, set `OG_MOCK=false`.

### 4.4 ENS: publish the merchant

1. Go to **https://sepolia.app.ens.domains** (ENSv2 is live on Sepolia) and register a name with your EVM key's wallet, e.g. `yourshop-tickets.eth`. ENSv2 registration fees on Sepolia are paid in MockUSDC, which anyone can mint; the ENS docs explain how. A plain `.eth` name is enough; a subname like `tickets.yourname.eth` is optional.
2. Publish Sangam's records on it:

```bash
npm run register-merchant -- \
  --name yourshop-tickets.eth \
  --url http://localhost:3000/book \
  --payTo 0.0.yyyyy \
  --price 4900 \
  --upi tickets@razorpay
```

- `--url`: `localhost` is fine while the buyer runs on your machine. Change it to the public URL after deploying (Part 6).
- `--payTo`: your **treasury** account ID.
- `--price`: in paise. `4900` = ₹49. Use `500` (₹5) to make test USDC last longer.
- `--upi`: the merchant's UPI ID. With RazorpayX test mode, use a test VPA from their docs.

3. In `.env`, set `MERCHANT_ENS_NAME=yourshop-tickets.eth` and `ENS_OFFLINE=false`.

**Check:** `npm run merchant` should print your ENS name and treasury ID. If a record is missing, it names the missing key.

### 4.5 UPI: RazorpayX test mode (optional)

Set `PSP_MODE=razorpayx` once the keys from 3.4 are in. Before relying on it, compare the request body in `apps/settlement-agent/src/payout.ts` with the current RazorpayX composite payout docs. It hasn't been run against the live API yet.

---

## Part 5: Make a real payment

Check `.env`: `SKIP_CHAIN_VERIFY=false`, plus whichever of `OG_MOCK`, `ENS_OFFLINE`, `PSP_MODE` you've switched to real. Then:

```bash
# terminal 1
npm run settlement
# terminal 2
npm run merchant
# terminal 3
npm run dashboard          # http://localhost:5173
# terminal 4: the buyer
npm run buy -- --merchant yourshop-tickets.eth --count 3
```

The buyer prints something like:

```
[agent] yourshop-tickets.eth → http://localhost:3000/book (₹49, found via ENS)
[agent] #1 paid 0.515816 USDC · PNR 4821930571 · Intercity Express · C3/41
        https://hashscan.io/testnet/transaction/...
[agent] done. spent 1.547448 of 2.000000 USDC budget
```

On the dashboard, each payment should reach **paid**, with a working **USDC tx** link and **HCS #n** link in the Proof column. Run `npm run setup-hedera` to see USDC leave the customer and arrive at the treasury.

The buyer stops at `CUSTOMER_BUDGET_USDC` per run (default 2), and the SDK refuses any single payment over `CUSTOMER_MAX_PER_PAYMENT` (default $1).

---

## Part 6: Deploy

You need a public URL for the demo. Any Node host works; these steps use Render.

**merchant-api and settlement-agent:** two Web Services from the same repo.

| | merchant-api | settlement-agent |
|---|---|---|
| Build command | `npm install` | `npm install` |
| Start command | `npm run merchant` | `npm run settlement` |
| Env vars | everything from `.env`, plus `SETTLEMENT_AGENT_URL=<settlement URL>` | everything from `.env`, plus `DEMO_STEP_DELAY_MS=0` |

Set `DASHBOARD_ORIGIN` on both to the dashboard's URL. Both servers listen on `PORT` when the host sets it, so there's nothing to map.

**dashboard:** a Static Site.

```bash
VITE_SETTLEMENT_URL=https://<settlement>.onrender.com \
VITE_MERCHANT_URL=https://<merchant>.onrender.com \
npm --workspace @sangam/dashboard run build      # output: apps/dashboard/dist
```

Or put both `VITE_*` values in `.env` and run just the last line. That works on every OS. On a static host like Render, set them as the site's env vars with build command `npm install && npm --workspace @sangam/dashboard run build` and publish directory `apps/dashboard/dist`.

**Then:** re-run `register-merchant` with `--url https://<merchant>.onrender.com/book`, so agents find the public shop.

Notes:
- Free hosts have temporary disks, so `data/settlements.json` resets on restart. That's fine for a demo.
- Set the env vars in the host's dashboard. Never commit `.env`.
- Generate a new `SETTLEMENT_SHARED_SECRET` for the deployed services (`npm run gen-keys`).

---

## Running on Windows

You have two options.

**Option A: WSL (easiest).** WSL gives you a Linux terminal inside Windows, and every command in this guide then works exactly as written.

1. In an **admin** PowerShell: `wsl --install`, then restart.
2. Open **Ubuntu** from the Start menu and install Node 22 inside it, e.g. with `nvm` or the NodeSource packages from https://nodejs.org.
3. Put the project inside the Linux file system (e.g. `~/sangam`), not under `/mnt/c/…`, which is much slower.
4. Follow this guide as if you were on Linux. Browsers on Windows can open `http://localhost:5173` directly.

**Option B: native PowerShell.** `npm run …` commands work, except that ones with `--` need `npm.cmd` (first row). These are the only differences:

| In this guide | In PowerShell |
|---|---|
| `cp .env.example .env` | `Copy-Item .env.example .env` |
| `npm run buy -- --merchant …` (anything with `--`) | `npm.cmd run buy -- --merchant …` (plain `npm` in PowerShell drops the `--`) |
| `curl …` | `curl.exe …` (plain `curl` is a different command in Windows PowerShell) |
| `export PATH=…` | not needed; the Node installer sets PATH |
| `lsof -nP -iTCP:3000 -sTCP:LISTEN` | `netstat -ano \| findstr :3000`, then `taskkill /PID <pid> /F` |
| `\` at the end of a line (multi-line commands) | `` ` `` (backtick), or put the whole command on one line |
| `VAR=value npm run …` | `$env:VAR="value"; npm run …` (stays set for that window) |

For example, the ENS step on one line in PowerShell:

```powershell
npm run register-merchant -- --name yourshop-tickets.eth --url http://localhost:3000/book --payTo 0.0.yyyyy --price 4900 --upi tickets@razorpay
```

If Windows Firewall asks about Node.js when a server starts, **Allow** on private networks is enough for local use.

---

## Reference

### Commands

| Command | What it does |
|---|---|
| `npm run settlement` | Start settlement-agent (:3001) |
| `npm run settlement:sim` | Start settlement-agent in simulation mode (enables simulate buttons + `npm run simulate`) |
| `npm run gen-keys` | Print a new shared secret and EVM key |
| `npm run merchant` | Start merchant-api (:3000) |
| `npm run shops` | Start the five test shops (:3002). See `docs/TEST-SHOPS.md` |
| `npm run dashboard` | Start the dashboard (:5173) |
| `npm run buy -- --merchant <name> [--count N] [--from CSMT --to PUNE]` | Run the buyer agent |
| `npm run simulate -- [N] [--short]` | Send fake notices (needs `npm run settlement:sim` running) |
| `npm run setup-hedera` | Associate USDC, print balances |
| `npm run create-topic` | Create the HCS receipt topic |
| `npm run setup-0g [-- fund]` | List 0G providers / fund the ledger and provider |
| `npm run register-merchant -- --name … --url … --payTo … --price … --upi …` | Publish ENS records |
| `npm run typecheck` | Typecheck everything |

### Mode switches

| Variable | Mock value | Real value | Real needs |
|---|---|---|---|
| `SKIP_CHAIN_VERIFY` | `true` | `false` | Hedera accounts (4.1) |
| `OG_MOCK` | `true` | `false` | 0G funded (4.3) |
| `ENS_OFFLINE` | `true` | `false` | ENS records (4.4) |
| `PSP_MODE` | `mock` | `razorpayx` | RazorpayX test keys (4.5) |
| `DEMO_STEP_DELAY_MS` | `800` | `0` | — (only slows steps so you can watch) |

### Env variables you fill in

| Variable | From |
|---|---|
| `CUSTOMER_ACCOUNT_ID`, `CUSTOMER_PRIVATE_KEY` | portal.hedera.com (3.1) |
| `TREASURY_ACCOUNT_ID`, `TREASURY_PRIVATE_KEY` | portal.hedera.com (3.1) |
| `OPERATOR_ACCOUNT_ID`, `OPERATOR_PRIVATE_KEY` | same as treasury (3.1) |
| `OG_PRIVATE_KEY`, `ENS_OWNER_PRIVATE_KEY` | generated EVM key (3.2) |
| `HCS_TOPIC_ID` | `npm run create-topic` (4.2) |
| `OG_PROVIDER_ADDRESS` | `npm run setup-0g` (4.3) |
| `MERCHANT_ENS_NAME` | the ENS name you register (4.4) |
| `PSP_KEY_ID`, `PSP_KEY_SECRET`, `RAZORPAYX_ACCOUNT_NUMBER` | RazorpayX test mode (3.4, optional) |
| `SEPOLIA_RPC_URL` | optional; blank uses a public RPC |

Everything else in `.env.example` has a working default.

### Layout

| Path | What |
|---|---|
| `packages/shared` | Types, env loading, ENS lookup, FX rate, Hedera helpers |
| `apps/merchant-api` | Express + `@x402/express` paywall on `GET /book` |
| `apps/settlement-agent` | Pipeline: `confirm.ts` → `decide.ts` (0G) → `payout.ts` → `receipt.ts` (HCS) |
| `apps/customer-agent` | Buyer CLI with a session budget |
| `apps/shops` | Five test merchants on one server, each testing a different part of Sangam |
| `apps/dashboard` | Vite page; dev proxy in `vite.config.ts` |
| `scripts/` | One-off setup scripts and the simulator |
| `data/merchants.local.json` | Merchant records used while `ENS_OFFLINE=true` |
| `data/settlements.json` | Settlement store (created on first payment, gitignored) |
| `docs/SPEC.md` | The build spec |

---

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `Missing env var X` | Fill in X in `.env` (see the table above). |
| `command not found: node` (macOS) | Run `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`. |
| `'node' is not recognized` (Windows) | Open a new terminal after installing Node. If it persists, reinstall Node and tick "Add to PATH". |
| `EADDRINUSE` on 3000/3001/5173 | Something's already running there. macOS/Linux: `lsof -nP -iTCP:3000 -sTCP:LISTEN`. Windows: `netstat -ano \| findstr :3000`. Stop that process. |
| Windows: `running scripts is disabled on this system` | PowerShell blocks npm's script wrapper. Run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, or use Command Prompt. |
| Circle faucet won't send USDC | The account isn't associated yet. Run `npm run setup-hedera` first. |
| Settlement `failed: transaction … not found on mirror node` | The Mirror Node can lag; the agent retries for ~15s. If it persists, check the tx on HashScan. |
| Settlement `failed: treasury credited 0 …` | `hederaPayTo` (local file or ENS record) isn't your treasury, or `HEDERA_USDC_TOKEN_ID` is wrong. |
| Buyer: `expected 402 from merchant, got …` | merchant-api isn't running, or the ENS `url` record points somewhere else. |
| Buyer refuses to pay | The price is over `CUSTOMER_MAX_PER_PAYMENT`, or the run budget is used up. |
| Payment rejected by the facilitator | Try another facilitator in `FACILITATOR_URL`: `https://x402.org/facilitator` or `https://testnet.facilitator.ax402.io`. |
| `is missing ENS text records` | Re-run `register-merchant`; wait a minute for Sepolia to confirm. |
| 0G: `insufficient balance` | Fund the wallet, then run `npm run setup-0g -- fund`. Each request needs a funded provider. |
| 0G decision is always "hold: not valid decision JSON" | The model isn't returning JSON. Try another provider from `setup-0g`. |
| Dashboard: "settlement agent unreachable" | Start `npm run settlement`. Deployed: check `VITE_SETTLEMENT_URL` and `DASHBOARD_ORIGIN`. |
| HashScan link shows "not found" | Wait a few seconds. If it persists, search the tx ID on hashscan.io by hand; the link format hasn't been checked against a real tx yet. |
| No simulate buttons on the dashboard | Start the agent with `npm run settlement:sim` instead of `npm run settlement`. |

---

## What's verified

| Part | Status |
|---|---|
| x402 paywall returns a correct 402 (testnet USDC, Blocky402 fee payer) | ✅ Tested against the live facilitator |
| Settlement pipeline, store, dashboard, simulator, duplicate + auth checks | ✅ Tested with mocks |
| Typecheck of every package and script | ✅ |
| Hedera SDK accepts raw, `0x` and DER private keys | ✅ |
| 0G testnet minimums (0.1 OG ledger, 0.01 OG provider) | ✅ Read from the live contract |
| Real x402 payment end to end | ⬜ Needs funded Hedera accounts |
| Mirror Node confirmation, HCS receipts, `setup-hedera` | ⬜ Needs Hedera accounts |
| 0G Compute decision, `setup-0g` | ⬜ Needs OG funds |
| ENS lookup, `register-merchant` | ⬜ Needs a Sepolia ENSv2 name |
| RazorpayX payout | ⬜ Needs test keys; request body unverified |
| HashScan link format | ⬜ Needs a real tx |
| Windows (native or WSL) | ⬜ Not run yet; only tested on macOS. The code uses no OS-specific APIs. |

## Built with

TypeScript, Express, `@x402/*` (Hedera exact scheme), `@hiero-ledger/sdk`, `@0gfoundation/0g-compute-ts-sdk`, viem, Vite. Built with help from Claude Code; the spec it worked from is `docs/SPEC.md`.

MIT license.
# sangham
