import { defineChain, createPublicClient, createWalletClient, http, publicActions } from 'viem';
import { CHAIN_ID, RPC_URL, EXPLORER } from '../config.js';

export const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: 'Blockscout', url: EXPLORER } },
});

export const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(RPC_URL),
});

export function walletFor(account) {
  return createWalletClient({
    account,
    chain: robinhoodChain,
    transport: http(RPC_URL),
  }).extend(publicActions);
}

export const erc20Abi = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
];
