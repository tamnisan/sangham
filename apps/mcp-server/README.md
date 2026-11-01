# sangam-mcp

Let your AI assistant buy from [Sangam](https://github.com/tamnisan/sangham)'s shops. It pays in USDC over x402, and the shop gets rupees over UPI.

**This runs on Hedera testnet. The money is test money with no real value.**

## 1. Add it to your AI app

Claude Code:

```bash
claude mcp add sangam -- npx -y sangam-mcp
```

On Windows, use:

```bash
claude mcp add sangam -- cmd /c npx -y sangam-mcp
```

Other apps that support MCP take a config like this:

```json
{ "mcpServers": { "sangam": { "command": "npx", "args": ["-y", "sangam-mcp"] } } }
```

You need [Node.js](https://nodejs.org) 20 or newer.

## 2. Ask your AI to set up the wallet

> Set up my Sangam wallet.

This creates a wallet on your computer, opens its Hedera testnet account and adds free starter USDC. The first request can take about a minute, because Sangam's free servers sleep when idle. If it times out, ask again.

## 3. Ask it to buy something

> What can I buy from Sangam?
>
> Buy a train ticket from Mumbai CSMT to Pune.

## Tools

| Tool | What it does |
|---|---|
| `setup_wallet` | Creates the wallet and account. Safe to run again. |
| `balance` | USDC balance and how much of today's limit is left |
| `list_shops` | What each shop sells and how to order |
| `get_price` | The exact price of an order, without paying |
| `buy` | Pays and returns what you bought |

## Staying safe

- **Spending limits.** By default, at most 1 USDC per purchase and 5 USDC per day. No tool can change them, so an AI tricked by a web page can't raise them through this server.
- **Your key stays on your computer.** Only your public key is sent to Sangam, and no tool returns the private key.
- **The wallet file is plain text.** It's at `~/.sangam/wallet.json`. An AI or program that can read your files could open it, and one that can edit files could change your limits. That's fine for test money, but this design isn't ready for real money.

## Settings

Set these as environment variables in your MCP config.

| Variable | Default | What it does |
|---|---|---|
| `SANGAM_MAX_PER_PURCHASE_USDC` | `1` | Most one purchase can cost |
| `SANGAM_MAX_PER_DAY_USDC` | `5` | Most you can spend per day (UTC) |
| `SANGAM_HOME` | `~/.sangam` | Where the wallet is kept |
| `SANGAM_SHOPS_URL` | `https://sangam-shops.onrender.com` | The shop server |
| `SANGAM_SETTLEMENT_URL` | `https://sangam-settlement.onrender.com` | The sign-up server |
