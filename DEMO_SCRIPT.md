# After-Hours Dip Agent - Demo Script

A ~2-minute visual demo. The dashboard is the hero: an AI agent pays for its own
market data over x402 and buys the after-hours dips, live, with real money on
Robinhood Chain. Watchlist: NVDA (NVIDIA), AAPL (Apple), AMD, SNDK (SanDisk).

Live numbers vary. `npm run status` shows the current board.

---

## Pre-flight (before you hit record)

1. **Funds.** Agent needs USDG for buys + a little ETH for gas. `npm run status` to check the agent line. A full "buy the dips" run spends ~2 USDG per dip plus a few cents for the scan.
2. **Start the three services**, fresh, each in its own terminal, from `~/Projects/after-hours-dip-agent`:
   ```bash
   npm run facilitator   # terminal 1 - the x402 settlement rail
   npm run oracle        # terminal 2 - the paid price API (one route per stock)
   npm run dashboard     # terminal 3 - the visual UI
   ```
   Wait for the oracle to print its watchlist and the dashboard to print its URL.
3. **Open the dashboard**: http://localhost:4025
4. **Do one full dry run** (Scan, then Buy the dips) before recording. It warms the path, confirms funds, and gets the one-time approvals out of the way. Then **reload the page** for a clean board and record the real take.
5. **Browser for the recording**: full-screen the window, hide the bookmarks bar, bump zoom to ~110 to 125% so the numbers read on video. Dark room, dark UI.
6. Optional flourish: open a second tab on https://robinhoodchain.blockscout.com so you can click a tx link mid-demo and show it is a real on-chain transaction.

---

## The flow (three beats + receipts)

**Beat 0 - the board loads.** Four tokenized stocks, live on-chain prices next to their last NYSE close, a red **MARKET CLOSED** badge, empty payment feed, wallets on the right.

**Beat 1 - Scan (the x402 moment).** Click **Scan watchlist**. The agent pays five cents per quote. Payments stream into the feed with tx links, the agent's USDG ticks down, the treasury's earnings tick up, and the dips light up amber.

**Beat 2 - Buy (the action).** Click **Buy the dips**. The agent buys every stock under threshold, biggest dip first. Those cards flip green to BOUGHT, swap tx links land in the feed, the agent's stock holdings rise.

**Beat 3 - Receipts.** Point at the wallet panel: the agent spent USDG and now holds the stocks it chose; the treasury earned the fees. Every row on screen has a transaction behind it. Click a tx link to prove it.

---

## The talk track (spoken, keep it flat and confident)

**Opening (board on screen, before clicking):**
> "Robinhood launched its own blockchain last week. Real tokenized stocks trade on it, and unlike the NYSE they do not stop at 4pm. It is after hours right now, the market is closed, but these prices are live. This is an AI agent that watches them and buys the dips on its own."

**Click Scan:**
> "First it needs the data. It is paying five cents for each price, over a protocol called x402. That is the HTTP 402 status code, Payment Required, which sat unused in the spec for thirty years. No API key, no account, the agent just pays. Watch the treasury earn as it does."

**As the dips light up:**
> "NVIDIA and AMD are tracking their close, so it passes. Apple and SanDisk are trading under their close. Those are the dips."

**Click Buy the dips:**
> "So it buys them. Both of them. Routed through Uniswap on-chain, real tokenized stock into its wallet." (point at holdings rising) "No brokerage. No human. A machine surveyed the market, decided, and traded."

**Close:**
> "It paid another machine for a signal, then acted on it, with real money, on infrastructure that is one week old. That is agentic commerce you can watch."

---

## The Claude kicker (optional second clip)

Same engine, driven by an AI in a chat window instead of a UI. Wire the MCP server into Claude Desktop (copy `claude_desktop_config.example.json`, restart Claude, keep the facilitator + oracle running). Then in Claude:
> "Scan my watchlist." -> `scan_watchlist` (pays x402, returns the ranked board)
> "Buy anything more than 1% below its close." -> `buy_the_dips` (buys the dips)

One line: "And it is not even a dashboard. An AI can drive the exact same thing from a chat window. That is paid MCP, the frontier everyone is racing toward."

---

## Making it flawless

- **Reset between takes**: reload the page. It re-reads live prices, cards go back to DIP/HOLD, feed clears. Scan + Buy again for a fresh take. (Buying again just adds to holdings and spends another few USDG.)
- **Pace it**: click, let the stream finish, then talk. Each x402 payment and each swap settles in a second or two. Do not rush the clicks.
- **NVDA/AMD holding is a feature**, not a bug. It shows the agent discriminates and only buys real dips. Say so.
- **If a dip disappears** (prices move): the demo still works with whatever is dipping. If nothing is dipping, either wait a bit or set `THRESHOLD_DISCOUNT_PCT=0.1` in `.env` and restart the oracle + dashboard.
- **If the scan errors**: a service is down. Confirm all three are running (`curl localhost:4020/health`) and restart the missing one.
- **RPC** is already the Alchemy endpoint in `.env` for reliability. Do not switch it mid-demo.
- **Proof shot**: end on a Blockscout tx page. It converts skeptics.

---

## The strongest version

This is true any time the market is closed: weeknights after 4pm ET and all weekend. A weekend recording lands hardest ("it is Sunday, the market is closed, and my agent is trading"), but a weeknight after-hours take is just as honest. Record when at least two names are dipping so "buy the dips" visibly buys a small portfolio, not a single stock.
