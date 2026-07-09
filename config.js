import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { keccak256, encodeAbiParameters } from 'viem';

// Load .env by absolute path so the server works when a host (e.g. Claude
// Desktop) launches it from a different working directory.
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), '.env') });

// ---- Robinhood Chain (verified on-chain 2026-07-08) ----
export const CHAIN_ID = 4663;
export const NETWORK = `eip155:${CHAIN_ID}`;
// Official public endpoint (rate-limited). Set RPC_URL to an Alchemy
// endpoint for production. Blockscout's /api/eth-rpc also works for
// contract reads but errors on eth_getBalance for fresh addresses.
export const RPC_URL = process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
export const EXPLORER = 'https://robinhoodchain.blockscout.com';

// Canonical tokens (docs.robinhood.com/chain/contracts)
export const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'; // 6 decimals
export const ETH = '0x0000000000000000000000000000000000000000'; // native, v4 currency0 on the routable pools
export const USDG_DECIMALS = 6;

// EIP-712 domain of USDG, brute-force matched against on-chain DOMAIN_SEPARATOR
export const USDG_EIP712 = { name: 'Global Dollar', version: '1' };

// Uniswap v4 (developers.uniswap.org/contracts/v4/deployments, chain 4663)
export const POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951';
export const UNIVERSAL_ROUTER = '0x8876789976decbfcbbbe364623c63652db8c0904';
export const QUOTER = '0x8dc178efb8111bb0973dd9d722ebeff267c98f94';
export const STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b';
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';

// v4 poolId = keccak256(abi.encode(PoolKey)). Lets us derive a pool's id from
// its key so switching the target stock only needs the two pool keys below.
const POOL_KEY_ABI = [{ type: 'tuple', components: [
  { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
] }];
const poolId = (key) => keccak256(encodeAbiParameters(POOL_KEY_ABI, [key]));

// ---- Watchlist: the agent scans these and buys the ones under threshold ----
// Add a stock() with a USDG/<stock> price pool (read-only signal) and an
// ETH/<stock> pool (the buy leg). The direct USDG/<stock> pool is NOT swappable
// via the Universal Router on this chain (token/token pools empty-revert;
// verified 2026-07-08), so buys route USDG -> ETH -> <stock>. Only tickers with
// both pools liquid are usable; all four below are verified end to end.
function stock(ticker, name, address, priceFee, priceTs, ethFee, ethTs) {
  const priceKey = { currency0: USDG, currency1: address, fee: priceFee, tickSpacing: priceTs, hooks: ETH };
  const ethKey = { currency0: ETH, currency1: address, fee: ethFee, tickSpacing: ethTs, hooks: ETH };
  return { ticker, name, address, decimals: 18, pricePool: { id: poolId(priceKey), key: priceKey }, ethPool: { key: ethKey } };
}

export const WATCHLIST = [
  stock('NVDA', 'NVIDIA',  '0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC', 3000, 60, 50000, 1000),   // headliner
  stock('AAPL', 'Apple',   '0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9', 50000, 1000, 50000, 1000),
  stock('AMD',  'AMD',     '0x86923f96303D656E4aa86D9d42D1e57ad2023fdC', 10000, 200, 50000, 1000),
  stock('SNDK', 'SanDisk', '0xB90A19fF0Af67f7779afF50A882A9CfF42446400', 10000, 200, 50000, 1000),
];
export const findStock = (ticker) => WATCHLIST.find((s) => s.ticker === ticker.toUpperCase());
export const pricePath = (ticker) => `/price/${ticker}`;

// USDG <-> ETH pool: buy leg 1 (first hop of every USDG -> ETH -> <stock> route).
export const ETH_USDG_POOL = {
  key: { currency0: ETH, currency1: USDG, fee: 500, tickSpacing: 10, hooks: ETH },
};

// ---- Services ----
export const FACILITATOR_PORT = Number(process.env.FACILITATOR_PORT || 4021);
export const ORACLE_PORT = Number(process.env.ORACLE_PORT || 4020);
export const FACILITATOR_URL = process.env.FACILITATOR_URL || `http://localhost:${FACILITATOR_PORT}`;
export const ORACLE_URL = process.env.ORACLE_URL || `http://localhost:${ORACLE_PORT}`;

// ---- Economics ----
// Price of one oracle query, in atomic USDG (6 decimals). 50000 = $0.05.
export const ORACLE_PRICE_ATOMIC = process.env.ORACLE_PRICE_ATOMIC || '50000';
// Buy trigger: on-chain price this % below last official NYSE close.
export const THRESHOLD_DISCOUNT_PCT = Number(process.env.THRESHOLD_DISCOUNT_PCT || 1.0);
// How much USDG to spend when the trigger fires.
export const BUY_USDG = Number(process.env.BUY_USDG || 15);
// Slippage tolerance on the swap, in percent.
export const SLIPPAGE_PCT = Number(process.env.SLIPPAGE_PCT || 1.0);

// ---- Keys / addresses (set by scripts/gen-wallets.js) ----
export const AGENT_PRIVATE_KEY = process.env.AGENT_PRIVATE_KEY;
export const FACILITATOR_PRIVATE_KEY = process.env.FACILITATOR_PRIVATE_KEY;
export const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS;
