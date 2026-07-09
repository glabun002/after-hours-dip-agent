// Reusable x402 facilitator app for Robinhood Chain (eip155:4663).
// Verifies EIP-3009 payment signatures and settles them on-chain from a
// gas-funded wallet. Used by both the local dev script (facilitator/) and
// the production server (server/), which mounts it on a loopback port.
import express from 'express';
import { x402Facilitator } from '@x402/core/facilitator';
import { registerExactEvmScheme } from '@x402/evm/exact/facilitator';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { NETWORK, EXPLORER } from '../config.js';
import { walletFor } from './chain.js';

export function buildFacilitatorApp(account) {
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

  return app;
}
