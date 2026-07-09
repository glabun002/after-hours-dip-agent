// Prints wallet balances and the live scan (each watchlist stock vs its NYSE close).
import { privateKeyToAccount } from 'viem/accounts';
import { formatUnits, formatEther } from 'viem';
import { USDG, WATCHLIST, AGENT_PRIVATE_KEY, FACILITATOR_PRIVATE_KEY, TREASURY_ADDRESS, USDG_DECIMALS, THRESHOLD_DISCOUNT_PCT } from '../config.js';
import { publicClient, erc20Abi } from '../lib/chain.js';
import { getOnchainPrice } from '../lib/uniswap.js';
import { getLastClose } from '../lib/closes.js';

const wallets = [];
if (AGENT_PRIVATE_KEY) wallets.push(['agent      ', privateKeyToAccount(AGENT_PRIVATE_KEY).address]);
if (FACILITATOR_PRIVATE_KEY) wallets.push(['facilitator', privateKeyToAccount(FACILITATOR_PRIVATE_KEY).address]);
if (TREASURY_ADDRESS) wallets.push(['treasury   ', TREASURY_ADDRESS]);

for (const [label, address] of wallets) {
  const [eth, usdg] = await Promise.all([
    publicClient.getBalance({ address }),
    publicClient.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
  ]);
  const holdings = await Promise.all(WATCHLIST.map((s) =>
    publicClient.readContract({ address: s.address, abi: erc20Abi, functionName: 'balanceOf', args: [address] })));
  const stockStr = WATCHLIST.map((s, i) => `${s.ticker} ${formatUnits(holdings[i], s.decimals)}`).join('  ');
  console.log(`${label} ${address}  ETH ${formatEther(eth)}  USDG ${formatUnits(usdg, USDG_DECIMALS)}  ${stockStr}`);
}

console.log(`\nwatchlist scan (threshold ${THRESHOLD_DISCOUNT_PCT}%):`);
for (const s of WATCHLIST) {
  const [onchain, official] = await Promise.all([getOnchainPrice(s), getLastClose(s.ticker)]);
  const disc = ((official.close - onchain.price) / official.close) * 100;
  const tag = disc >= THRESHOLD_DISCOUNT_PCT ? 'DIP' : 'pass';
  console.log(`  ${s.ticker.padEnd(5)} ${s.name.padEnd(8)} on-chain $${onchain.price.toFixed(2)} | close $${official.close} (${official.closeDate}) | ${Math.abs(disc).toFixed(2)}% ${disc >= 0 ? 'below' : 'above'}  [${tag}]`);
}
