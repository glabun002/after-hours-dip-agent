# After-Hours Dip Agent

An AI agent that pays another machine for a signal that exists nowhere else, then acts on it. All on [Robinhood Chain](https://robinhood.com/us/en/chain/), Robinhood's own Ethereum L2.

When the NYSE closes, price discovery for a stock does not stop. Robinhood's tokenized stocks keep trading on-chain against USDG, after hours and all weekend. This agent watches a watchlist of them, pays for each price over [x402](https://x402.org), and buys the ones trading below their last NYSE close. No brokerage, no API keys, no human in the loop.

**Live instance: [afterhoursoracle.xyz](https://afterhoursoracle.xyz)** — the oracle running as a public paid API. Any agent with USDG on Robinhood Chain can buy a quote right now.

Default watchlist: **NVDA** (NVIDIA), **AAPL** (Apple), **AMD**, **SNDK** (SanDisk), plus **MU** (Micron) and **QQQ** (Nasdaq-100 ETF) as signal-only tickers (quotable, not buyable — see below).

## The loop

1. **After-Hours Oracle** (`oracle/`): a paid API with one route per stock. Each query reads the live on-chain price from a Uniswap v4 pool, compares it to the last official NYSE close, and returns the discount. Each call costs $0.05 in USDG, paid over x402 (the HTTP "402 Payment Required" protocol).
2. **Facilitator** (`facilitator/`): a self-hosted x402 facilitator for `eip155:4663`. No hosted facilitator supports Robinhood Chain, so you run your own. It verifies the agent's signed EIP-3009 USDG authorization and settles it on-chain.
3. **Agent** (`agent/`): scans the watchlist (paying for each quote), holds the stocks tracking their close, and buys the ones trading at least `THRESHOLD_DISCOUNT_PCT` below it, biggest dip first. Buys route USDG → ETH → stock on Uniswap v4.

## Three ways to run it

- **CLI** (`npm run agent`): the autonomous, headless version. Scan, decide, buy.
- **MCP tools** (`mcp/`): the same engine exposed as tools a model can call, so you can drive it from a chat window in Claude.
- **Dashboard** (`npm run dashboard`): a live visual UI at `localhost:4025`. Watchlist cards with on-chain price vs close, a streaming x402 payment feed with tx links, and wallet balances that update as the agent pays and trades.

All three share one engine: same wallet, same x402 payment path, same Uniswap route (`lib/`).

## Run it

```bash
npm install
npm run gen-wallets     # creates .env with fresh keys, prints the three addresses

# fund the agent on Robinhood Chain (from the Robinhood app, network = Robinhood Chain):
#   agent:       USDG for buys + a little ETH for gas
#   facilitator: a little ETH for settlement gas

npm run status          # balances + live watchlist scan
npm run facilitator     # terminal 1 - the x402 settlement rail
npm run oracle          # terminal 2 - the paid price API
npm run dashboard       # terminal 3 - visual UI at http://localhost:4025
# ...or drive it headless:
npm run agent           # scan the watchlist, buy the dips
```

Tune `THRESHOLD_DISCOUNT_PCT`, `BUY_USDG`, `SLIPPAGE_PCT` in `.env`. `WATCH_MINUTES=30 npm run agent` runs it as a standing after-hours watcher.

## Hosting the oracle as a public product

`server/` is a single deployable service: a public landing page with the live board, the x402-gated `/price/<TICKER>` API, a free cached `/api/board`, and the facilitator running in-process on a loopback port (never exposed). Any agent with USDG on Robinhood Chain can pay it, no account needed.

```bash
npm run gen-prod-facilitator   # prints a FRESH key + address; nothing written to disk
```

Deploy anywhere that runs Node or Docker (Railway, Render, Fly). Entry point is `npm start` (or the included `Dockerfile`), listening on `$PORT`. Set three environment variables on the platform:

| Var | What |
|---|---|
| `FACILITATOR_PRIVATE_KEY` | The fresh prod key from the script. Fund its address with ~0.002 ETH on Robinhood Chain (settlement gas). |
| `TREASURY_ADDRESS` | Where the USDG lands. Its private key never goes on the server. |
| `RPC_URL` | An Alchemy endpoint for chain 4663 (the public RPC is rate-limited). |

Operational notes: the facilitator wallet is a hot wallet, so keep only gas-money in it. The buyer needs no ETH; your facilitator sponsors settlement gas (fractions of a cent per quote on this chain).

## MCP tools

Copy `claude_desktop_config.example.json` into your Claude Desktop config (fix the absolute path), restart Claude, and keep the facilitator + oracle running (the tools pay them).

| Tool | What it does |
|---|---|
| `get_wallet_status` | Read-only balances of the agent + treasury. No spend. |
| `scan_watchlist` | Pays the oracle ~$0.05 USDG over x402 for each stock, returns the board ranked by discount. Real settlement. |
| `buy_the_dips` | Buys every stock trading below threshold, biggest dip first. Real trades. |
| `buy_stock` | Buys one named stock. Manual, no threshold check. |

Then ask Claude: *"scan my watchlist"* and *"buy anything more than 1% below its close."*

**On "paid MCP":** the purest form is the MCP client paying the server with a payment signature, replacing API keys. No shipping MCP client signs x402 yet. So today this server pays a downstream x402 API (the oracle); the payment is real, it just sits one hop past the tool call. When clients support x402 natively, this same server becomes the gated resource directly.

## The one non-obvious thing I learned

Robinhood's tokenized stock pools are paired token-to-token against USDG, and **those pools do not route through Uniswap's Universal Router on this chain**. The Quoter happily simulates a USDG → stock swap, but `execute()` reverts with empty data. Every pool with native ETH on one side works fine, both directions, every fee tier. So buys route **USDG → ETH → stock** as two chained hops. Worth knowing if you build agentic trading of real-world assets here.

## Adding a stock

The watchlist is one array in `config.js`. A stock needs a liquid USDG/`<stock>` pool for the price signal; add an ETH/`<stock>` pool too and it becomes tradable (the buy leg).

```js
stock('TSLA', 'Tesla', '0x...', priceFee, priceTs, ethFee, ethTs)  // tradable
stock('MU',   'Micron', '0x...', priceFee, priceTs)                // signal-only
```

Signal-only entries are served by the oracle but refused by every buy path (agent, MCP tools, dashboard) with a clear message. On a young chain the usable list is short — NVDA, AAPL, AMD, SNDK tradable and MU, QQQ signal-only are verified — and it grows as liquidity arrives. A sanity bar worth keeping: only add a price pool that tracks the real market within a few percent, or you are selling noise.

## Notes

- Set `RPC_URL` in `.env` to an Alchemy endpoint for reliability; the default is Robinhood Chain's public RPC.
- The x402 payment itself needs no ETH from the agent (the facilitator submits the transfer). The agent only needs ETH for its own Uniswap swaps.
- This is a demo, not investment software. Mainnet, real money, tiny amounts. Your keys live in `.env` (gitignored) — fund only with small amounts.

Built on Robinhood Chain, [x402](https://x402.org), Uniswap v4, and USDG.
