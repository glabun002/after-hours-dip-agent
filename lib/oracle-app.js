// Reusable After-Hours Oracle routes: one x402-gated price route per
// watchlist stock. Shared by the local dev script (oracle/) and the
// production server (server/).
import { paymentMiddleware } from '@x402/express';
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import {
  NETWORK, ORACLE_PRICE_ATOMIC, USDG, USDG_EIP712, TREASURY_ADDRESS,
  WATCHLIST, pricePath, EXPLORER,
} from '../config.js';
import { getOnchainPrice } from './uniswap.js';
import { getLastClose, isNyseOpenNow } from './closes.js';

/**
 * Attaches the x402 payment middleware and the per-ticker price handlers
 * to an express app. Call after the facilitator at `facilitatorUrl` is up.
 */
export function attachOracle(app, { facilitatorUrl }) {
  const facilitatorClient = new HTTPFacilitatorClient({ url: facilitatorUrl });
  const resourceServer = new x402ResourceServer(facilitatorClient)
    .register(NETWORK, new ExactEvmScheme());

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

  app.use(paymentMiddleware(routes, resourceServer));

  for (const s of WATCHLIST) {
    app.get(pricePath(s.ticker), async (_req, res) => {
      try {
        const [onchain, official] = await Promise.all([getOnchainPrice(s), getLastClose(s.ticker)]);
        const discountPct = ((official.close - onchain.price) / official.close) * 100;
        res.json({
          ticker: s.ticker,
          name: s.name,
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
}
