// Local dev entry for the self-hosted x402 facilitator (eip155:4663).
// The app itself lives in lib/facilitator-app.js and is shared with the
// production server.
import { privateKeyToAccount } from 'viem/accounts';
import { NETWORK, FACILITATOR_PORT, FACILITATOR_PRIVATE_KEY } from '../config.js';
import { buildFacilitatorApp } from '../lib/facilitator-app.js';

if (!FACILITATOR_PRIVATE_KEY) {
  console.error('FACILITATOR_PRIVATE_KEY missing. Run: npm run gen-wallets');
  process.exit(1);
}

const account = privateKeyToAccount(FACILITATOR_PRIVATE_KEY);
const app = buildFacilitatorApp(account);

app.listen(FACILITATOR_PORT, () => {
  console.log(`x402 facilitator for ${NETWORK} on :${FACILITATOR_PORT}`);
  console.log(`gas/settlement wallet: ${account.address} (needs ETH on Robinhood Chain)`);
});
