// The After-Hours Dip Agent: pays the After-Hours Oracle in USDG via x402 for each
// stock on its watchlist, then buys the ones trading far enough below their last
// NYSE close - all on Robinhood Chain, routed USDG -> ETH -> stock on Uniswap v4.
import { privateKeyToAccount } from 'viem/accounts';
import { parseUnits, formatUnits } from 'viem';
import {
  NETWORK, ORACLE_URL, THRESHOLD_DISCOUNT_PCT, BUY_USDG, SLIPPAGE_PCT,
  AGENT_PRIVATE_KEY, USDG_DECIMALS, WATCHLIST, findStock, EXPLORER,
} from '../config.js';
import { walletFor } from '../lib/chain.js';
import { makeOracleClient, getSignal } from '../lib/oracle.js';
import { quoteUsdgToStock, ensureApprovals, swapUsdgForStock } from '../lib/uniswap.js';

if (!AGENT_PRIVATE_KEY) {
  console.error('AGENT_PRIVATE_KEY missing. Run: npm run gen-wallets');
  process.exit(1);
}

const account = privateKeyToAccount(AGENT_PRIVATE_KEY);
const wallet = walletFor(account);
const { payFetch } = makeOracleClient(AGENT_PRIVATE_KEY);

console.log(`agent wallet: ${account.address}`);
console.log(`watchlist: ${WATCHLIST.map((s) => s.ticker).join(', ')}`);
console.log(`rule: buy ${BUY_USDG} USDG of any stock trading >= ${THRESHOLD_DISCOUNT_PCT}% below its last NYSE close\n`);

async function buy(stock, discountPct) {
  console.log(`   buying ${BUY_USDG} USDG of ${stock.ticker} (${discountPct.toFixed(2)}% below close)...`);
  const amountIn = parseUnits(String(BUY_USDG), USDG_DECIMALS);
  const quoted = await quoteUsdgToStock(stock, amountIn);
  const minOut = (quoted * BigInt(Math.floor((100 - SLIPPAGE_PCT) * 100))) / 10000n;
  const approvals = await ensureApprovals(wallet);
  for (const a of approvals) console.log(`     ${a.step}: ${EXPLORER}/tx/${a.hash}`);
  const { hash, status } = await swapUsdgForStock(wallet, stock, amountIn, minOut);
  console.log(`   ${stock.ticker} swap ${status}: got ~${formatUnits(quoted, stock.decimals)} ${stock.ticker} | ${EXPLORER}/tx/${hash}`);
  return { ticker: stock.ticker, tx: hash, status };
}

async function runOnce() {
  console.log('1. scanning the watchlist (paying the oracle per quote via x402)...');
  const signals = [];
  for (const s of WATCHLIST) {
    const sig = await getSignal(payFetch, s.ticker);
    signals.push(sig);
    const tag = sig.discountPct >= THRESHOLD_DISCOUNT_PCT ? 'DIP' : 'pass';
    const dir = sig.discountPct >= 0 ? 'below' : 'above';
    console.log(`   ${sig.ticker} (${s.name}): $${sig.onchainPrice} vs $${sig.lastNyseClose} close = ${Math.abs(sig.discountPct).toFixed(2)}% ${dir}  [${tag}]${sig.settlementTx ? `  paid: ${EXPLORER}/tx/${sig.settlementTx}` : ''}`);
  }

  const allDips = signals.filter((s) => s.discountPct >= THRESHOLD_DISCOUNT_PCT).sort((a, b) => b.discountPct - a.discountPct);
  const dips = allDips.filter((d) => findStock(d.ticker)?.tradable);
  const signalOnly = allDips.filter((d) => !findStock(d.ticker)?.tradable);
  console.log(`\n2. NYSE open now: ${signals[0]?.nyseOpenNow}. Dips over ${THRESHOLD_DISCOUNT_PCT}%: ${allDips.length ? allDips.map((d) => d.ticker).join(', ') : 'none'}.`);
  if (signalOnly.length) console.log(`   (${signalOnly.map((d) => d.ticker).join(', ')} signal-only on this chain - no route to buy, skipping)`);

  if (!dips.length) {
    console.log('3. nothing tradable below threshold. holding.');
    return { bought: [] };
  }

  console.log(`3. buying ${dips.length} dip${dips.length > 1 ? 's' : ''}, biggest first:`);
  const bought = [];
  for (const d of dips) bought.push(await buy(findStock(d.ticker), d.discountPct));
  console.log(`\n4. done. bought: ${bought.map((b) => b.ticker).join(', ')}.`);
  return { bought };
}

const watchMinutes = Number(process.env.WATCH_MINUTES || 0);
if (watchMinutes > 0) {
  console.log(`watch mode: checking every ${watchMinutes} min\n`);
  const tick = () => runOnce().catch((e) => console.error('run failed:', e.message));
  await tick();
  setInterval(tick, watchMinutes * 60 * 1000);
} else {
  await runOnce();
}
