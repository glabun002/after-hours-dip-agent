// Reusable x402 facilitator app. Verifies EIP-3009 payment signatures and
// settles them on-chain from a gas-funded wallet. Multi-network: one signer
// per chain, same wallet address everywhere. Used by the local dev script
// (facilitator/) and the production server (server/), which mounts it on a
// loopback port.
import express from 'express';
import { createWalletClient, http, publicActions } from 'viem';
import { base } from 'viem/chains';
import { x402Facilitator } from '@x402/core/facilitator';
import { registerExactEvmScheme } from '@x402/evm/exact/facilitator';
import { toFacilitatorEvmSigner } from '@x402/evm';
import { NETWORK, EXPLORER, BASE_NETWORK, BASE_RPC_URL, ACCEPT_BASE } from '../config.js';
import { robinhoodChain, walletFor } from './chain.js';

/** The networks this facilitator settles: Robinhood Chain always, Base when enabled. */
export function defaultNetworkEntries() {
  const entries = [{ networks: NETWORK, chain: robinhoodChain, rpcUrl: null }]; // null -> walletFor default
  if (ACCEPT_BASE) entries.push({ networks: BASE_NETWORK, chain: base, rpcUrl: BASE_RPC_URL });
  return entries;
}

export function buildFacilitatorApp(account, networkEntries = defaultNetworkEntries()) {
  const facilitator = new x402Facilitator();

  for (const entry of networkEntries) {
    const wallet = entry.rpcUrl
      ? createWalletClient({ account, chain: entry.chain, transport: http(entry.rpcUrl) }).extend(publicActions)
      : walletFor(account);
    // toFacilitatorEvmSigner wants a flat `address`; viem keeps it on `account`
    wallet.address = account.address;
    registerExactEvmScheme(facilitator, { signer: toFacilitatorEvmSigner(wallet), networks: entry.networks });
  }

  facilitator.onAfterSettle(async ({ paymentPayload, result }) => {
    if (!result.transaction) return;
    const net = paymentPayload?.network || result.network || '';
    const url = net === BASE_NETWORK ? `https://basescan.org/tx/${result.transaction}` : `${EXPLORER}/tx/${result.transaction}`;
    console.log(`  settled on-chain (${net}): ${url}`);
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
