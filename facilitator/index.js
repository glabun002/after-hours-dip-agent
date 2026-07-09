// Self-hosted x402 facilitator for Robinhood Chain (eip155:4663).
// No hosted facilitator supports this chain yet, so we run our own:
// it verifies EIP-3009 payment signatures and settles them on-chain
// from a gas-funded wallet.
import express from 'express';
import { privateKeyToAccount } from 'viem/accounts';
import { x402Facilitator } from '@x402/core/facilitator';
import { registerExactEvmScheme } from '@x402/evm/exact/facilitator';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { NETWORK, FACILITATOR_PORT, FACILITATOR_PRIVATE_KEY, EXPLORER } from '../config.js';
import { walletFor } from '../lib/chain.js';

if (!FACILITATOR_PRIVATE_KEY) {
  console.error('FACILITATOR_PRIVATE_KEY missing. Run: npm run gen-wallets');
  process.exit(1);
}

const account = privateKeyToAccount(FACILITATOR_PRIVATE_KEY);
const wallet = walletFor(account);
// toFacilitatorEvmSigner wants a flat `address`; viem keeps it on `account`
wallet.address = account.address;
const signer = toFacilitatorEvmSigner(wallet);

const facilitator = new x402Facilitator();
registerExactEvmScheme(facilitator, { signer, networks: NETWORK });

facilitator.onAfterSettle(async ({ result }) => {
  if (result.transaction) console.log(`  settled on-chain: ${EXPLORER}/tx/${result.transaction}`);
});

const app = express();
app.use(express.json({ limit: '1mb' }));

app.get('/supported', (_req, res) => res.json(facilitator.getSupported()));

app.post('/verify', async (req, res) => {
  const { paymentPayload, paymentRequirements } = req.body || {};
  try {
    const result = await facilitator.verify(paymentPayload, paymentRequirements);
    console.log(`verify: isValid=${result.isValid}${result.invalidReason ? ` (${result.invalidReason})` : ''}`);
    res.json(result);
  } catch (e) {
    console.error('verify error:', e.message);
    res.status(400).json({ isValid: false, invalidReason: 'unexpected_verify_error', payer: '' });
  }
});

app.post('/settle', async (req, res) => {
  const { paymentPayload, paymentRequirements } = req.body || {};
  try {
    const result = await facilitator.settle(paymentPayload, paymentRequirements);
    console.log(`settle: success=${result.success} tx=${result.transaction || 'n/a'}`);
    res.json(result);
  } catch (e) {
    console.error('settle error:', e.message);
    res.status(400).json({ success: false, errorReason: 'unexpected_settle_error', transaction: '', network: NETWORK, payer: '' });
  }
});

app.listen(FACILITATOR_PORT, () => {
  console.log(`x402 facilitator for ${NETWORK} on :${FACILITATOR_PORT}`);
  console.log(`gas/settlement wallet: ${account.address} (needs ETH on Robinhood Chain)`);
});
