import { createRequire } from 'node:module';
import { maxUint160, maxUint256 } from 'viem';
import {
  USDG, ETH_USDG_POOL,
  STATE_VIEW, QUOTER, UNIVERSAL_ROUTER, PERMIT2, USDG_DECIMALS,
} from '../config.js';
import { publicClient, erc20Abi } from './chain.js';

// @uniswap/v4-sdk ships a broken ESM build (unresolved directory imports), so
// load its CJS build via createRequire. V4Planner is the authoritative encoder
// for v4 action calldata.
const require = createRequire(import.meta.url);
const { V4Planner, Actions } = require('@uniswap/v4-sdk');

const OPEN_DELTA = '0'; // v4 sentinel: "use the full current delta" (chains hop N+1 onto hop N)

const stateViewAbi = [
  { type: 'function', name: 'getSlot0', stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' }, { name: 'tick', type: 'int24' },
      { name: 'protocolFee', type: 'uint24' }, { name: 'lpFee', type: 'uint24' },
    ] },
  { type: 'function', name: 'getLiquidity', stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }], outputs: [{ type: 'uint128' }] },
];

const poolKeyComponents = [
  { name: 'currency0', type: 'address' },
  { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' },
  { name: 'tickSpacing', type: 'int24' },
  { name: 'hooks', type: 'address' },
];

const quoterAbi = [
  { type: 'function', name: 'quoteExactInputSingle', stateMutability: 'nonpayable',
    inputs: [{ name: 'params', type: 'tuple', components: [
      { name: 'poolKey', type: 'tuple', components: poolKeyComponents },
      { name: 'zeroForOne', type: 'bool' },
      { name: 'exactAmount', type: 'uint128' },
      { name: 'hookData', type: 'bytes' },
    ] }],
    outputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'gasEstimate', type: 'uint256' }] },
];

const universalRouterAbi = [
  { type: 'function', name: 'execute', stateMutability: 'payable',
    inputs: [
      { name: 'commands', type: 'bytes' },
      { name: 'inputs', type: 'bytes[]' },
      { name: 'deadline', type: 'uint256' },
    ], outputs: [] },
];

const permit2Abi = [
  { type: 'function', name: 'allowance', stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }, { type: 'address' }],
    outputs: [{ name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' }, { name: 'nonce', type: 'uint48' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' }, { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint160' }, { name: 'expiration', type: 'uint48' },
    ], outputs: [] },
];

/** A stock's current price in USDG, from its direct pool's slot0 (read-only signal). */
export async function getOnchainPrice(stock) {
  const [slot0, liquidity] = await Promise.all([
    publicClient.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: 'getSlot0', args: [stock.pricePool.id] }),
    publicClient.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: 'getLiquidity', args: [stock.pricePool.id] }),
  ]);
  const sqrt = Number(slot0[0]) / 2 ** 96;
  const raw = sqrt * sqrt; // currency1(stock) per currency0(USDG), raw units
  const priceUsdgPerStock = 10 ** (stock.decimals - USDG_DECIMALS) / raw;
  return { price: priceUsdgPerStock, tick: Number(slot0[1]), liquidity: liquidity.toString() };
}

async function quoteSingle(poolKey, zeroForOne, amountInAtomic) {
  const { result } = await publicClient.simulateContract({
    address: QUOTER, abi: quoterAbi, functionName: 'quoteExactInputSingle',
    args: [{ poolKey, zeroForOne, exactAmount: amountInAtomic, hookData: '0x' }],
  });
  return result[0]; // amountOut atomic
}

/**
 * Quote the executable route USDG -> ETH -> <stock> (the direct USDG/<stock>
 * pool is not routable via the Universal Router on this chain). Atomic out.
 */
export async function quoteUsdgToStock(stock, amountInAtomic) {
  const ethOut = await quoteSingle(ETH_USDG_POOL.key, false, amountInAtomic); // USDG(c1) -> ETH(c0)
  const stockOut = await quoteSingle(stock.ethPool.key, true, ethOut);        // ETH(c0) -> stock(c1)
  return stockOut;
}

/**
 * One-time approvals: USDG -> Permit2 (ERC-20), then Permit2 -> Universal Router.
 * No-ops when already in place.
 */
export async function ensureApprovals(wallet) {
  const owner = wallet.account.address;
  const txs = [];

  const erc20Allowance = await publicClient.readContract({
    address: USDG, abi: erc20Abi, functionName: 'allowance', args: [owner, PERMIT2],
  });
  if (erc20Allowance < maxUint256 / 2n) {
    const hash = await wallet.writeContract({
      address: USDG, abi: erc20Abi, functionName: 'approve', args: [PERMIT2, maxUint256],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    txs.push({ step: 'USDG.approve(Permit2)', hash });
  }

  const [p2Amount, p2Expiration] = await publicClient.readContract({
    address: PERMIT2, abi: permit2Abi, functionName: 'allowance', args: [owner, USDG, UNIVERSAL_ROUTER],
  });
  const now = Math.floor(Date.now() / 1000);
  if (p2Amount < maxUint160 / 2n || p2Expiration <= now + 3600) {
    const expiration = 2 ** 48 - 1;
    const hash = await wallet.writeContract({
      address: PERMIT2, abi: permit2Abi, functionName: 'approve',
      args: [USDG, UNIVERSAL_ROUTER, maxUint160, expiration],
    });
    await publicClient.waitForTransactionReceipt({ hash });
    txs.push({ step: 'Permit2.approve(UniversalRouter)', hash });
  }
  return txs;
}

const V4_SWAP_COMMAND = '0x10';

/**
 * Buy <stock> with exact USDG in, routed USDG -> ETH -> <stock> through the
 * Universal Router. Two chained single swaps (ETH passed between them via
 * OPEN_DELTA), then settle USDG and take the stock. Simulates first, then sends.
 */
export async function swapUsdgForStock(wallet, stock, amountInAtomic, minOutAtomic) {
  const planner = new V4Planner();
  // hop 1: USDG(currency1) -> ETH(currency0)  => zeroForOne = false
  planner.addAction(Actions.SWAP_EXACT_IN_SINGLE, [{
    poolKey: ETH_USDG_POOL.key, zeroForOne: false,
    amountIn: amountInAtomic.toString(), amountOutMinimum: '1', hookData: '0x',
  }]);
  // hop 2: ETH(currency0) -> stock(currency1) => zeroForOne = true, consume all ETH
  planner.addAction(Actions.SWAP_EXACT_IN_SINGLE, [{
    poolKey: stock.ethPool.key, zeroForOne: true,
    amountIn: OPEN_DELTA, amountOutMinimum: minOutAtomic.toString(), hookData: '0x',
  }]);
  planner.addAction(Actions.SETTLE_ALL, [USDG, amountInAtomic.toString()]);
  planner.addAction(Actions.TAKE_ALL, [stock.address, minOutAtomic.toString()]);

  const input = planner.finalize();
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 300);

  const { request } = await publicClient.simulateContract({
    address: UNIVERSAL_ROUTER, abi: universalRouterAbi, functionName: 'execute',
    args: [V4_SWAP_COMMAND, [input], deadline],
    account: wallet.account,
  });
  const hash = await wallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { hash, status: receipt.status };
}
