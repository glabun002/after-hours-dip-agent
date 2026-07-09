// The After-Hours Oracle: sells the on-chain price of each watchlist stock
// (Uniswap v4 on Robinhood Chain) vs its last official NYSE close, paid
// per-query in USDG via x402. One x402-gated route per ticker.
import express from 'express';
import { paymentMiddleware } from '@x402/express';
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import {
  NETWORK, ORACLE_PORT, ORACLE_PRICE_ATOMIC, FACILITATOR_URL,
  USDG, USDG_EIP712, TREASURY_ADDRESS, WATCHLIST, pricePath, EXPLORER,
} from '../config.js';
import { getOnchainPrice } from '../lib/uniswap.js';
import { getLastClose, isNyseOpenNow } from '../lib/closes.js';

if (!TREASURY_ADDRESS) {
  console.error('TREASURY_ADDRESS missing. Run: npm run gen-wallets');
  process.exit(1);
}

const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register(NETWORK, new ExactEvmScheme());

// One paid route per watchlist ticker.
const routes = {};
for (const s of WATCHLIST) {
  routes[`GET ${pricePath(s.ticker)}`] = {
    description: `Live tokenized-${s.ticker} price from Robinhood Chain vs last NYSE close`,
    accepts: {
      scheme: 'exact',
      network: NETWORK,
      payTo: TREASURY_ADDRESS,
      maxTimeoutSeconds: 120,
      price: { asset: USDG, amount: ORACLE_PRICE_ATOMIC, extra: { ...USDG_EIP712 } },
      extra: { ...USDG_EIP712 },
    },
  };
}

const app = express();
app.use(paymentMiddleware(routes, resourceServer));

for (const s of WATCHLIST) {
  app.get(pricePath(s.ticker), async (_req, res) => {
    try {
      const [onchain, official] = await Promise.all([getOnchainPrice(s), getLastClose(s.ticker)]);
      const discountPct = ((official.close - onchain.price) / official.close) * 100;
      res.json({
        ticker: s.ticker,
        onchainPrice: Number(onchain.price.toFixed(4)),
        lastNyseClose: official.close,
        lastNyseCloseDate: official.closeDate,
        discountPct: Number(discountPct.toFixed(4)), // positive = trading below close
        nyseOpenNow: isNyseOpenNow(),
        source: { chain: 'Robinhood Chain (eip155:4663)', pool: s.pricePool.id, explorer: EXPLORER },
        asOf: new Date().toISOString(),
      });
    } catch (e) {
      console.error(`price handler error (${s.ticker}):`, e.message);
      res.status(500).json({ error: e.message });
    }
  });
}

app.get('/health', (_req, res) => res.json({ ok: true, service: 'after-hours-oracle', watchlist: WATCHLIST.map((s) => s.ticker) }));

app.listen(ORACLE_PORT, () => {
  console.log(`After-Hours Oracle on :${ORACLE_PORT}`);
  console.log(`watchlist: ${WATCHLIST.map((s) => s.ticker).join(', ')} (${Number(ORACLE_PRICE_ATOMIC) / 1e6} USDG per quote via x402 -> ${TREASURY_ADDRESS})`);
});
