// Shared x402 client for the After-Hours Oracle. Used by both the CLI agent
// and the MCP server: builds a payment-enabled fetch and reads the signal,
// paying the oracle's per-query USDG fee under the hood.
import { privateKeyToAccount } from 'viem/accounts';
import { wrapFetchWithPayment, x402Client, decodePaymentResponseHeader } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { NETWORK, ORACLE_URL, WATCHLIST, pricePath, AGENT_PRIVATE_KEY } from '../config.js';

export function makeOracleClient(privateKey = AGENT_PRIVATE_KEY) {
  const account = privateKeyToAccount(privateKey);
  const client = new x402Client().register(NETWORK, new ExactEvmScheme(account));
  const payFetch = wrapFetchWithPayment(fetch, client);
  return { account, payFetch };
}

/** Pays the oracle for one ticker's signal; returns it plus the settlement tx hash. */
export async function getSignal(payFetch, ticker, { url = ORACLE_URL } = {}) {
  const res = await payFetch(`${url}${pricePath(ticker)}`);
  if (!res.ok) throw new Error(`oracle returned ${res.status} for ${ticker}: ${await res.text()}`);

  let settlementTx = null;
  const header = res.headers.get('payment-response') || res.headers.get('x-payment-response');
  if (header) {
    try { settlementTx = decodePaymentResponseHeader(header).transaction || null; } catch { /* ignore */ }
  }
  const data = await res.json();
  return { ...data, settlementTx };
}

/** Pays for every watchlist ticker's signal (one x402 payment each). */
export async function surveyWatchlist(payFetch, opts = {}) {
  const signals = [];
  for (const s of WATCHLIST) signals.push(await getSignal(payFetch, s.ticker, opts));
  return signals;
}
