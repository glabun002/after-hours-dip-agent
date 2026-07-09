// Local dev entry for the After-Hours Oracle. The routes live in
// lib/oracle-app.js and are shared with the production server.
import express from 'express';
import {
  ORACLE_PORT, ORACLE_PRICE_ATOMIC, FACILITATOR_URL, TREASURY_ADDRESS, WATCHLIST,
} from '../config.js';
import { attachOracle } from '../lib/oracle-app.js';

if (!TREASURY_ADDRESS) {
  console.error('TREASURY_ADDRESS missing. Run: npm run gen-wallets');
  process.exit(1);
}

const app = express();
attachOracle(app, { facilitatorUrl: FACILITATOR_URL });

app.get('/health', (_req, res) => res.json({ ok: true, service: 'after-hours-oracle', watchlist: WATCHLIST.map((s) => s.ticker) }));

app.listen(ORACLE_PORT, () => {
  console.log(`After-Hours Oracle on :${ORACLE_PORT}`);
  console.log(`watchlist: ${WATCHLIST.map((s) => s.ticker).join(', ')} (${Number(ORACLE_PRICE_ATOMIC) / 1e6} USDG per quote via x402 -> ${TREASURY_ADDRESS})`);
});
