// Visual dashboard for the After-Hours Dip Agent. Serves a single-page UI and
// drives the same engine as the CLI agent / MCP server:
//   GET /                initial page
//   GET /api/state       free read-only snapshot (prices, discounts, wallet)
//   GET /api/scan (SSE)   pays the oracle per ticker over x402, streams events
//   GET /api/buy  (SSE)   buys every dip, streams swap events
// Needs the facilitator + oracle running (it is an x402 client of the oracle).
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { parseUnits, formatUnits, formatEther } from 'viem';
import {
  WATCHLIST, findStock, USDG, USDG_DECIMALS, TREASURY_ADDRESS, EXPLORER,
  THRESHOLD_DISCOUNT_PCT, BUY_USDG, SLIPPAGE_PCT, AGENT_PRIVATE_KEY,
} from '../config.js';
import { publicClient, walletFor, erc20Abi } from '../lib/chain.js';
import { getOnchainPrice, quoteUsdgToStock, ensureApprovals, swapUsdgForStock } from '../lib/uniswap.js';
import { getLastClose, isNyseOpenNow } from '../lib/closes.js';
import { makeOracleClient, getSignal } from '../lib/oracle.js';

const PORT = Number(process.env.DASHBOARD_PORT || 4025);
const DASH_BUY = Number(process.env.BUY_USDG || 2); // small default so demo buys fit the agent's balance
const account = privateKeyToAccount(AGENT_PRIVATE_KEY);
const wallet = walletFor(account);
const { payFetch } = makeOracleClient(AGENT_PRIVATE_KEY);
const txUrl = (h) => `${EXPLORER}/tx/${h}`;

async function walletSnapshot() {
  const read = async (address) => {
    const [eth, usdg] = await Promise.all([
      publicClient.getBalance({ address }),
      publicClient.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
    ]);
    const holdings = {};
    for (const s of WATCHLIST) {
      const b = await publicClient.readContract({ address: s.address, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
      holdings[s.ticker] = Number(formatUnits(b, s.decimals));
    }
    return { eth: Number(formatEther(eth)), usdg: Number(formatUnits(usdg, USDG_DECIMALS)), holdings };
  };
  const [agent, treasury] = await Promise.all([read(account.address), read(TREASURY_ADDRESS)]);
  return { agent: { address: account.address, ...agent }, treasury: { address: TREASURY_ADDRESS, ...treasury } };
}

async function pricesSnapshot() {
  const rows = [];
  for (const s of WATCHLIST) {
    try {
      const [onchain, official] = await Promise.all([getOnchainPrice(s), getLastClose(s.ticker)]);
      const discount = ((official.close - onchain.price) / official.close) * 100;
      rows.push({ ticker: s.ticker, name: s.name, onchain: onchain.price, close: official.close, closeDate: official.closeDate, discount });
    } catch (e) {
      rows.push({ ticker: s.ticker, name: s.name, error: e.message });
    }
  }
  return rows;
}

const app = express();
const here = dirname(fileURLToPath(import.meta.url));
app.get('/', (_req, res) => res.sendFile(join(here, 'index.html')));

app.get('/api/state', async (_req, res) => {
  try {
    const [prices, wallet] = await Promise.all([pricesSnapshot(), walletSnapshot()]);
    res.json({ threshold: THRESHOLD_DISCOUNT_PCT, buyUsdg: DASH_BUY, nyseOpenNow: isNyseOpenNow(), prices, wallet, explorer: EXPLORER });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function sse(res) {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders?.();
  return (event, data) => res.write(`data: ${JSON.stringify({ event, ...data })}\n\n`);
}

app.get('/api/scan', async (_req, res) => {
  const send = sse(res);
  try {
    send('start', { tickers: WATCHLIST.map((s) => s.ticker), threshold: THRESHOLD_DISCOUNT_PCT });
    const signals = [];
    for (const s of WATCHLIST) {
      send('paying', { ticker: s.ticker });
      const sig = await getSignal(payFetch, s.ticker);
      signals.push(sig);
      send('quote', {
        ticker: sig.ticker, name: s.name, onchain: sig.onchainPrice, close: sig.lastNyseClose, discount: sig.discountPct,
        isDip: sig.discountPct >= THRESHOLD_DISCOUNT_PCT, txUrl: sig.settlementTx ? txUrl(sig.settlementTx) : null,
        nyseOpenNow: sig.nyseOpenNow,
      });
    }
    const dips = signals.filter((s) => s.discountPct >= THRESHOLD_DISCOUNT_PCT).sort((a, b) => b.discountPct - a.discountPct).map((s) => s.ticker);
    send('done', { dips, wallet: await walletSnapshot() });
  } catch (e) {
    send('error', { message: e.message });
  } finally { res.end(); }
});

app.get('/api/buy', async (_req, res) => {
  const send = sse(res);
  const per = DASH_BUY;
  try {
    // re-scan quietly (free reads) to decide dips, so a buy click is self-contained
    const prices = await pricesSnapshot();
    const dips = prices
      .filter((p) => !p.error && p.discount >= THRESHOLD_DISCOUNT_PCT && findStock(p.ticker)?.tradable)
      .sort((a, b) => b.discount - a.discount);
    if (!dips.length) { send('done', { bought: [], wallet: await walletSnapshot() }); return; }
    for (const d of dips) {
      const s = findStock(d.ticker);
      send('buying', { ticker: d.ticker, discount: d.discount, usdg: per });
      const amountIn = parseUnits(String(per), USDG_DECIMALS);
      const quoted = await quoteUsdgToStock(s, amountIn);
      const minOut = (quoted * BigInt(Math.floor((100 - SLIPPAGE_PCT) * 100))) / 10000n;
      await ensureApprovals(wallet);
      const swap = await swapUsdgForStock(wallet, s, amountIn, minOut);
      send('bought', { ticker: d.ticker, got: Number(formatUnits(quoted, s.decimals)), usdg: per, txUrl: txUrl(swap.hash), status: swap.status });
    }
    send('done', { bought: dips.map((d) => d.ticker), wallet: await walletSnapshot() });
  } catch (e) {
    send('error', { message: e.message });
  } finally { res.end(); }
});

app.listen(PORT, () => {
  console.log(`Dashboard on http://localhost:${PORT}  (needs facilitator + oracle running)`);
  console.log(`watchlist: ${WATCHLIST.map((s) => s.ticker).join(', ')}  agent ${account.address}`);
});
