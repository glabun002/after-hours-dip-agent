// After-Hours Dip Agent as paid MCP tools.
//
// Same engine as the CLI agent, exposed as tool calls: a person in Claude asks
// to scan the watchlist (each quote paid over x402, real USDG settlement on
// Robinhood Chain) and buy the dips (routed USDG -> ETH -> stock on Uniswap v4).
// No API keys.
//
// Note on "paid MCP": the purest form is the MCP *client* paying the server with
// a payment signature. No shipping MCP client signs x402 yet, so today this
// server pays a downstream x402 API (the oracle). The payment is real; it just
// sits one hop past the tool call.
//
// stdio transport: stdout is the protocol channel. NEVER console.log here - all
// human logging goes to stderr via console.error.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { formatUnits, formatEther, parseUnits } from 'viem';
import {
  NETWORK, USDG, WATCHLIST, findStock, USDG_DECIMALS, EXPLORER, TREASURY_ADDRESS,
  BUY_USDG, SLIPPAGE_PCT, THRESHOLD_DISCOUNT_PCT, ORACLE_URL,
} from '../config.js';
import { publicClient, walletFor, erc20Abi } from '../lib/chain.js';
import { quoteUsdgToStock, ensureApprovals, swapUsdgForStock } from '../lib/uniswap.js';
import { makeOracleClient, surveyWatchlist } from '../lib/oracle.js';

const { account, payFetch } = makeOracleClient();
const wallet = walletFor(account);

const tx = (h) => `${EXPLORER}/tx/${h}`;
const ok = (text, data) => ({ content: [{ type: 'text', text: data ? `${text}\n\n${JSON.stringify(data, null, 2)}` : text }] });
const fail = (msg) => ({ content: [{ type: 'text', text: `Error: ${msg}` }], isError: true });

async function balances(address) {
  const [eth, usdg] = await Promise.all([
    publicClient.getBalance({ address }),
    publicClient.readContract({ address: USDG, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
  ]);
  const holdings = {};
  for (const s of WATCHLIST) {
    const bal = await publicClient.readContract({ address: s.address, abi: erc20Abi, functionName: 'balanceOf', args: [address] });
    holdings[s.ticker] = formatUnits(bal, s.decimals);
  }
  return { eth: formatEther(eth), usdg: formatUnits(usdg, USDG_DECIMALS), _usdgAtomic: usdg, holdings };
}

async function buyOne(stock, slip = SLIPPAGE_PCT, amount = BUY_USDG) {
  const amountIn = parseUnits(String(amount), USDG_DECIMALS);
  const quoted = await quoteUsdgToStock(stock, amountIn);
  const minOut = (quoted * BigInt(Math.floor((100 - slip) * 100))) / 10000n;
  const approvals = await ensureApprovals(wallet);
  const swap = await swapUsdgForStock(wallet, stock, amountIn, minOut);
  return {
    ticker: stock.ticker, spentUsdg: amount, expected: formatUnits(quoted, stock.decimals),
    swapTxUrl: tx(swap.hash), status: swap.status, approvalTxUrls: approvals.map((a) => tx(a.hash)),
  };
}

const server = new McpServer({ name: 'after-hours-dip-agent', version: '0.2.0' });

server.registerTool(
  'get_wallet_status',
  {
    title: 'Get wallet status',
    description: `Read-only. Balances (ETH/USDG and each watchlist stock: ${WATCHLIST.map((s) => s.ticker).join(', ')}) for the agent and treasury wallets on Robinhood Chain. No payment, no transaction.`,
  },
  async () => {
    try {
      const [agent, treasury] = await Promise.all([balances(account.address), balances(TREASURY_ADDRESS)]);
      return ok('Wallet status on Robinhood Chain (eip155:4663):', {
        agent: { address: account.address, eth: agent.eth, usdg: agent.usdg, holdings: agent.holdings },
        treasury: { address: TREASURY_ADDRESS, usdg: treasury.usdg, holdings: treasury.holdings },
        explorer: EXPLORER,
      });
    } catch (e) {
      return fail(e.message);
    }
  },
);

server.registerTool(
  'scan_watchlist',
  {
    title: 'Scan the watchlist (paid)',
    description:
      `Pays the After-Hours Oracle ~$0.05 in USDG over x402 for EACH watchlist stock (${WATCHLIST.map((s) => s.ticker).join(', ')}), ` +
      'then returns each stock\'s on-chain price vs its last NYSE close, ranked by discount. ' +
      `discountPct > 0 = trading below the close. Dips are those >= ${THRESHOLD_DISCOUNT_PCT}%. This call moves real USDG and settles on-chain.`,
  },
  async () => {
    try {
      const signals = await surveyWatchlist(payFetch);
      const ranked = signals.sort((a, b) => b.discountPct - a.discountPct).map((s) => ({
        ticker: s.ticker, onchainPrice: s.onchainPrice, lastNyseClose: s.lastNyseClose,
        discountPct: s.discountPct, isDip: s.discountPct >= THRESHOLD_DISCOUNT_PCT,
        settlementTxUrl: s.settlementTx ? tx(s.settlementTx) : null,
      }));
      const dips = ranked.filter((s) => s.isDip).map((s) => s.ticker);
      const nyseOpen = signals[0]?.nyseOpenNow;
      return ok(
        `Scanned ${ranked.length} stocks. NYSE open now: ${nyseOpen}. Dips >= ${THRESHOLD_DISCOUNT_PCT}%: ${dips.length ? dips.join(', ') : 'none'}.`,
        { threshold: THRESHOLD_DISCOUNT_PCT, nyseOpenNow: nyseOpen, dips, signals: ranked },
      );
    } catch (e) {
      return fail(`${e.message} (is the oracle + facilitator running?)`);
    }
  },
);

server.registerTool(
  'buy_the_dips',
  {
    title: 'Buy every watchlist dip (real swaps)',
    description:
      'Scans the watchlist (paid over x402), then buys EVERY stock trading at least the threshold below its NYSE close, biggest dip first. ' +
      'Real on-chain trades routed USDG -> ETH -> stock. Optionally set usdgAmount (per buy), slippagePct, and requireDiscountPct (overrides the default threshold).',
    inputSchema: {
      usdgAmount: z.number().positive().max(1000).optional(),
      slippagePct: z.number().min(0).max(50).optional(),
      requireDiscountPct: z.number().optional(),
    },
  },
  async ({ usdgAmount, slippagePct, requireDiscountPct }) => {
    try {
      const threshold = requireDiscountPct ?? THRESHOLD_DISCOUNT_PCT;
      const signals = await surveyWatchlist(payFetch);
      const allDips = signals.filter((s) => s.discountPct >= threshold).sort((a, b) => b.discountPct - a.discountPct);
      const dips = allDips.filter((d) => findStock(d.ticker)?.tradable);
      const skipped = allDips.filter((d) => !findStock(d.ticker)?.tradable).map((d) => d.ticker);
      if (!dips.length) {
        return ok(`No tradable stock is at least ${threshold}% below its close right now${skipped.length ? ` (${skipped.join(', ')} dipping but signal-only, no route to buy)` : ''}. Holding, no trades made.`,
          { threshold, skippedSignalOnly: skipped, scanned: signals.map((s) => ({ ticker: s.ticker, discountPct: s.discountPct })) });
      }
      const bal = await balances(account.address);
      const per = usdgAmount ?? BUY_USDG;
      if (bal._usdgAtomic < parseUnits(String(per), USDG_DECIMALS)) {
        return fail(`agent holds ${bal.usdg} USDG, needs ${per} per buy. Fund ${account.address} or lower usdgAmount.`);
      }
      const bought = [];
      for (const d of dips) bought.push(await buyOne(findStock(d.ticker), slippagePct ?? SLIPPAGE_PCT, per));
      return ok(`Bought ${bought.length} dip(s): ${bought.map((b) => b.ticker).join(', ')}.${skipped.length ? ` Skipped signal-only: ${skipped.join(', ')}.` : ''}`, { threshold, bought, skippedSignalOnly: skipped });
    } catch (e) {
      return fail(e.message);
    }
  },
);

server.registerTool(
  'buy_stock',
  {
    title: 'Buy one watchlist stock (real swap)',
    description:
      `Buys a specific tradable watchlist stock (${WATCHLIST.filter((s) => s.tradable).map((s) => s.ticker).join(', ')}) with USDG, routed USDG -> ETH -> stock. Real on-chain trade. ` +
      `Does NOT check the dip threshold - use this for a manual buy. Signal-only tickers (${WATCHLIST.filter((s) => !s.tradable).map((s) => s.ticker).join(', ')}) cannot be bought.`,
    inputSchema: {
      ticker: z.string(),
      usdgAmount: z.number().positive().max(1000).optional(),
      slippagePct: z.number().min(0).max(50).optional(),
    },
  },
  async ({ ticker, usdgAmount, slippagePct }) => {
    try {
      const stock = findStock(ticker);
      if (!stock) return fail(`${ticker} is not on the watchlist (${WATCHLIST.map((s) => s.ticker).join(', ')}).`);
      if (!stock.tradable) return fail(`${stock.ticker} is signal-only on this chain (no liquid ETH route pool): the oracle quotes it, but it cannot be bought.`);
      const per = usdgAmount ?? BUY_USDG;
      const bal = await balances(account.address);
      if (bal._usdgAtomic < parseUnits(String(per), USDG_DECIMALS)) {
        return fail(`agent holds ${bal.usdg} USDG, needs ${per}. Fund ${account.address} or lower usdgAmount.`);
      }
      const res = await buyOne(stock, slippagePct ?? SLIPPAGE_PCT, per);
      return ok(`Bought ${stock.ticker} with ${per} USDG. Swap ${res.status}: ${res.swapTxUrl}`, res);
    } catch (e) {
      return fail(e.message);
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`after-hours-dip-agent MCP server ready. watchlist=${WATCHLIST.map((s) => s.ticker).join(',')} agent=${account.address} network=${NETWORK} oracle=${ORACLE_URL}`);
