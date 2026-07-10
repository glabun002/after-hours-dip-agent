// Production server: the After-Hours Oracle as a public, hosted product.
//
// One process, one public port:
//   GET  /                    public landing page (live board + docs)
//   GET  /api/board           free read-only snapshot (cached, rate-friendly)
//   GET  /price/<TICKER>      the paid API: x402-gated, $0.05 USDG per quote
//   GET  /health              liveness
//
// The x402 facilitator runs inside the same process on a loopback port; it is
// never exposed publicly. It needs FACILITATOR_PRIVATE_KEY (a fresh, prod-only
// key funded with a little ETH for settlement gas) and TREASURY_ADDRESS (an
// address you control; receives the USDG). No other keys belong on the server.
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { formatUnits, createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import {
  NETWORK, ORACLE_PRICE_ATOMIC, TREASURY_ADDRESS, FACILITATOR_PRIVATE_KEY,
  USDG, USDG_DECIMALS, WATCHLIST, pricePath, EXPLORER,
  ACCEPT_BASE, BASE_NETWORK, BASE_RPC_URL, BASE_USDC, ACCEPT_MPP, MPP_TESTNET,
} from '../config.js';
import { publicClient, erc20Abi } from '../lib/chain.js';
import { buildFacilitatorApp } from '../lib/facilitator-app.js';
import { attachOracle, priceHandlerFor } from '../lib/oracle-app.js';
import { createMpp, attachMpp } from '../lib/mpp-app.js';
import { getOnchainPrice } from '../lib/uniswap.js';
import { getLastClose, isNyseOpenNow } from '../lib/closes.js';

const PORT = Number(process.env.PORT || 8080);
const INTERNAL_FACILITATOR_PORT = Number(process.env.INTERNAL_FACILITATOR_PORT || 4021);
const INTERNAL_FACILITATOR_URL = `http://127.0.0.1:${INTERNAL_FACILITATOR_PORT}`;

if (!FACILITATOR_PRIVATE_KEY || !TREASURY_ADDRESS) {
  console.error('FACILITATOR_PRIVATE_KEY and TREASURY_ADDRESS are required (set them as environment variables).');
  process.exit(1);
}

// config.js already forgives paste accidents (quotes, whitespace, NAME=
// prefixes, trailing text); here we validate hard so anything still wrong
// fails with a readable message instead of a viem stack trace.
if (!/^0x[0-9a-fA-F]{64}$/.test(FACILITATOR_PRIVATE_KEY)) {
  console.error(
    `FACILITATOR_PRIVATE_KEY is malformed: expected 0x followed by 64 hex characters (66 total), got ${FACILITATOR_PRIVATE_KEY.length} characters` +
    `${FACILITATOR_PRIVATE_KEY.startsWith('0x') ? '' : ' (missing 0x prefix?)'}. ` +
    'Set ONLY the 0x... value, with no variable name, quotes, or spaces.',
  );
  process.exit(1);
}
if (!/^0x[0-9a-fA-F]{40}$/.test(TREASURY_ADDRESS)) {
  console.error(`TREASURY_ADDRESS is malformed: no 0x address found in ${JSON.stringify(TREASURY_ADDRESS)}. Set ONLY the 0x... address.`);
  process.exit(1);
}

const facilitatorAccount = privateKeyToAccount(FACILITATOR_PRIVATE_KEY);

const basePublicClient = createPublicClient({ chain: base, transport: http(BASE_RPC_URL) });

// ---- free board snapshot, cached so page traffic stays cheap on RPC/Yahoo ----
const BOARD_CACHE_MS = 30_000;
let boardCache = { at: 0, data: null };

async function boardSnapshot() {
  if (boardCache.data && Date.now() - boardCache.at < BOARD_CACHE_MS) return boardCache.data;
  const prices = [];
  for (const s of WATCHLIST) {
    try {
      const [onchain, official] = await Promise.all([getOnchainPrice(s), getLastClose(s.ticker)]);
      const discount = ((official.close - onchain.price) / official.close) * 100;
      prices.push({
        ticker: s.ticker, name: s.name, tradable: s.tradable,
        onchain: Number(onchain.price.toFixed(2)), close: official.close,
        closeDate: official.closeDate, discount: Number(discount.toFixed(2)),
      });
    } catch (e) {
      prices.push({ ticker: s.ticker, name: s.name, tradable: s.tradable, error: e.message });
    }
  }
  // Treasury only ever receives oracle fees, so quotes sold = earnings / price.
  // Earnings arrive as USDG on Robinhood Chain and USDC on Base.
  let stats = null;
  try {
    const usdgBal = await publicClient.readContract({
      address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [TREASURY_ADDRESS],
    });
    let usdcBal = 0n;
    if (ACCEPT_BASE) {
      try {
        usdcBal = await basePublicClient.readContract({
          address: BASE_USDC, abi: erc20Abi, functionName: 'balanceOf', args: [TREASURY_ADDRESS],
        });
      } catch { /* Base RPC hiccup: show Robinhood-side stats rather than none */ }
    }
    const usdgEarned = Number(formatUnits(usdgBal, USDG_DECIMALS));
    const usdcEarned = Number(formatUnits(usdcBal, 6));
    stats = {
      usdgEarned, usdcEarned,
      totalEarned: Number((usdgEarned + usdcEarned).toFixed(2)),
      quotesSold: Math.round((usdgEarned + usdcEarned) / (Number(ORACLE_PRICE_ATOMIC) / 1e6)),
    };
  } catch { /* stats are decorative; keep the board alive without them */ }

  const data = {
    network: NETWORK,
    payWith: [
      ...(ACCEPT_BASE ? [{ network: BASE_NETWORK, asset: 'USDC', label: 'USDC on Base' }] : []),
      { network: NETWORK, asset: 'USDG', label: 'USDG on Robinhood Chain' },
    ],
    protocols: ['x402', ...(ACCEPT_MPP ? ['mpp'] : [])],
    nyseOpenNow: isNyseOpenNow(),
    pricePerQuoteUsdg: Number(ORACLE_PRICE_ATOMIC) / 1e6,
    treasury: TREASURY_ADDRESS,
    explorer: EXPLORER,
    prices, stats,
    asOf: new Date().toISOString(),
  };
  boardCache = { at: Date.now(), data };
  return data;
}

// ---- boot: facilitator first (loopback), then the public app ----
const facilitatorApp = buildFacilitatorApp(facilitatorAccount);
facilitatorApp.listen(INTERNAL_FACILITATOR_PORT, '127.0.0.1', () => {
  console.log(`internal x402 facilitator on 127.0.0.1:${INTERNAL_FACILITATOR_PORT} (settlement wallet ${facilitatorAccount.address})`);
  console.log(`settles: ${NETWORK}${ACCEPT_BASE ? ` + ${BASE_NETWORK} (wallet needs gas on BOTH chains)` : ''}`);

  const app = express();
  const here = dirname(fileURLToPath(import.meta.url));

  app.get('/health', (_req, res) => res.json({ ok: true, service: 'after-hours-oracle', watchlist: WATCHLIST.map((s) => s.ticker) }));

  app.get('/api/board', async (_req, res) => {
    try { res.json(await boardSnapshot()); }
    catch (e) { res.status(500).json({ error: e.message }); }
  });

  // MPP surface first: consumes `Authorization: Payment` credentials on the
  // price routes and grafts MPP's challenge onto unpaid 402s. Everything
  // else falls through to the x402 stack below.
  if (ACCEPT_MPP) {
    try {
      attachMpp(app, createMpp(), priceHandlerFor);
      console.log(`MPP surface on (${MPP_TESTNET ? 'Tempo testnet/Moderato' : 'Tempo mainnet'}, settles to ${TREASURY_ADDRESS})`);
    } catch (e) {
      console.error('MPP surface failed to attach (continuing x402-only):', e.message);
    }
  }

  // paid routes (x402 middleware syncs with the loopback facilitator on start)
  attachOracle(app, { facilitatorUrl: INTERNAL_FACILITATOR_URL });

  app.get('/', (_req, res) => res.sendFile(join(here, 'public', 'index.html')));

  app.listen(PORT, () => {
    console.log(`After-Hours Oracle (public) on :${PORT}`);
    console.log(`paid routes: ${WATCHLIST.map((s) => pricePath(s.ticker)).join(', ')} @ ${Number(ORACLE_PRICE_ATOMIC) / 1e6} USDG -> ${TREASURY_ADDRESS}`);
  });
});
