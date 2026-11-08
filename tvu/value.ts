/**
 * Value now: native balance and whitelisted token balances through Multicall3 (batches of about 500 calls),
 * then the spoof filters (contract code, nonce, single address too large).
 */
import { decodeFunctionResult, encodeFunctionData, parseAbi } from 'viem';
import { MULTICALL3, RULES, UMBRA, type ChainCfg, type TokenCfg } from './config.ts';
import type { Rpc } from './rpc.ts';

export const ABI = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) payable returns (Result[] returnData)',
  'function getEthBalance(address addr) view returns (uint256 balance)',
  'function balanceOf(address owner) view returns (uint256)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);

export const CALLS_PER_BATCH = 500;

type Call = { target: string; callData: `0x${string}` };

/** A node refused a batch for its size: execution time or gas cap (public Arbitrum nodes stop eth_call after 5 s). */
const TOO_HEAVY = /timeout|timed out|aborted|out of gas|gas limit|gas cap|exceed|too large|response size/i;
const MIN_BATCH = 10;
/** Every endpoint answered "too many requests": wait and try the same batch again (8 Nov, public Arbitrum nodes). */
const RATE_LIMITED = /\b429\b|rate limit|too many requests|capacity/i;
const RATE_WAITS_MS = [15_000, 30_000, 60_000, 120_000, 240_000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function callWithPatience<T>(f: () => Promise<T>, waits = RATE_WAITS_MS, wait = sleep): Promise<T> {
  for (let k = 0; ; k++) {
    try {
      return await f();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (k >= waits.length || !RATE_LIMITED.test(msg)) throw e;
      await wait(waits[k] as number);
    }
  }
}
export const __test = { callWithPatience };

/** Run calls through Multicall3.aggregate3 in batches. Failed sub calls come back as null. A batch a node refuses as
 *  too heavy is split in half (down to MIN_BATCH calls) and the smaller size is kept for the rest (7 Nov: one Arbitrum
 *  batch of 500 calls hit the 5 s execution limit on every public endpoint and the run failed). */
export async function multicall(rpc: Rpc, calls: Call[], block: string, perBatch = CALLS_PER_BATCH): Promise<(`0x${string}` | null)[]> {
  const out: (`0x${string}` | null)[] = [];
  let size = perBatch;
  const run = async (slice: Call[]): Promise<void> => {
    const data = encodeFunctionData({
      abi: ABI,
      functionName: 'aggregate3',
      args: [slice.map((c) => ({ target: c.target as `0x${string}`, allowFailure: true, callData: c.callData }))],
    });
    let raw: `0x${string}`;
    try {
      raw = await callWithPatience(() => rpc.call<`0x${string}`>('eth_call', [{ to: MULTICALL3, data }, block]));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (slice.length <= MIN_BATCH || !TOO_HEAVY.test(msg)) throw e;
      size = Math.min(size, Math.ceil(slice.length / 2));
      for (let j = 0; j < slice.length; ) {
        const part = slice.slice(j, j + size);
        await run(part);
        j += part.length;
      }
      return;
    }
    const res = decodeFunctionResult({ abi: ABI, functionName: 'aggregate3', data: raw }) as readonly { success: boolean; returnData: `0x${string}` }[];
    if (res.length !== slice.length) throw new Error('multicall answer has the wrong length');
    for (const r of res) out.push(r.success ? r.returnData : null);
  };
  for (let i = 0; i < calls.length; ) {
    const slice = calls.slice(i, i + size);
    await run(slice);
    i += slice.length;
  }
  return out;
}

const u256 = (d: `0x${string}` | null): bigint => (d === null || d.length < 66 ? 0n : BigInt(d.slice(0, 66)));

/** Keep only tokens whose decimals and symbol match the config on chain. */
export async function verifyTokens(rpc: Rpc, c: ChainCfg, block: string, log: (m: string) => void): Promise<TokenCfg[]> {
  const calls: Call[] = c.tokens.flatMap((t) => [
    { target: t.address, callData: encodeFunctionData({ abi: ABI, functionName: 'symbol' }) },
    { target: t.address, callData: encodeFunctionData({ abi: ABI, functionName: 'decimals' }) },
  ]);
  const res = await multicall(rpc, calls, block);
  const ok: TokenCfg[] = [];
  c.tokens.forEach((t, i) => {
    try {
      const sym = decodeFunctionResult({ abi: ABI, functionName: 'symbol', data: res[2 * i] as `0x${string}` }) as string;
      const dec = Number(u256(res[2 * i + 1] ?? null));
      if (dec === t.decimals && sym.toLowerCase().includes(t.symbolMatch.toLowerCase())) ok.push(t);
      else log(`${c.key}: token ${t.symbol} skipped, chain says ${sym}/${dec}`);
    } catch {
      log(`${c.key}: token ${t.symbol} skipped, no symbol or decimals on chain`);
    }
  });
  return ok;
}

export interface Prices {
  eth: number;
  pol: number;
}

export interface AddrValue {
  address: string;
  nativeUsd: number;
  tokensUsd: number;
}

const toUsd = (raw: bigint, decimals: number, price: number): number => (Number(raw) / 10 ** decimals) * price;

export const nativePrice = (c: ChainCfg, p: Prices): number => (c.native === 'eth' ? p.eth : c.native === 'pol' ? p.pol : 1);
export const tokenPrice = (t: TokenCfg, p: Prices): number => (t.kind === 'eth' ? p.eth : 1);

/** Balances of every address. Only addresses with a value above zero are returned. */
export async function readBalances(
  rpc: Rpc,
  c: ChainCfg,
  tokens: TokenCfg[],
  addresses: string[],
  p: Prices,
  block: string,
  perBatch = CALLS_PER_BATCH,
): Promise<AddrValue[]> {
  const per = 1 + tokens.length;
  const calls: Call[] = [];
  for (const a of addresses) {
    calls.push({ target: MULTICALL3, callData: encodeFunctionData({ abi: ABI, functionName: 'getEthBalance', args: [a as `0x${string}`] }) });
    for (const t of tokens) calls.push({ target: t.address, callData: encodeFunctionData({ abi: ABI, functionName: 'balanceOf', args: [a as `0x${string}`] }) });
  }
  // whole addresses per batch so a batch never splits one address
  const batchCalls = Math.max(per, Math.floor(perBatch / per) * per);
  const res = await multicall(rpc, calls, block, batchCalls);
  const out: AddrValue[] = [];
  addresses.forEach((address, i) => {
    const base = i * per;
    const nativeUsd = toUsd(u256(res[base] ?? null), 18, nativePrice(c, p));
    let tokensUsd = 0;
    tokens.forEach((t, k) => {
      tokensUsd += toUsd(u256(res[base + 1 + k] ?? null), t.decimals, tokenPrice(t, p));
    });
    if (nativeUsd > 0 || tokensUsd > 0) out.push({ address, nativeUsd, tokensUsd });
  });
  return out;
}

/** Tokens Umbra holds for stealth owners who have not withdrawn yet. */
export async function readUmbraPending(rpc: Rpc, tokens: TokenCfg[], p: Prices, block: string): Promise<number> {
  const calls: Call[] = tokens.map((t) => ({
    target: t.address,
    callData: encodeFunctionData({ abi: ABI, functionName: 'balanceOf', args: [UMBRA as `0x${string}`] }),
  }));
  const res = await multicall(rpc, calls, block);
  return tokens.reduce((sum, t, i) => sum + toUsd(u256(res[i] ?? null), t.decimals, tokenPrice(t, p)), 0);
}

/** EIP-7702 delegation markers (0xef0100 + address) belong to ordinary accounts, not contracts. */
export const hasContractCode = (code: string): boolean => code !== '0x' && code !== '0x0' && code !== '' && !code.toLowerCase().startsWith('0xef0100');

export interface Filtered {
  kept: AddrValue[];
  outliers: { count: number; usd: number };
}

/** Spoof protection. See METHOD.md. Contract code and nonce are read only for addresses that hold value. */
export async function applyFilters(rpc: Rpc, vals: AddrValue[], p: Prices, block: string, step = 100): Promise<Filtered> {
  const kept: AddrValue[] = [];
  const outliers = { count: 0, usd: 0 };
  const maxUsd = RULES.maxEthEquivalent * p.eth;
  for (let i = 0; i < vals.length; i += step) {
    const slice = vals.slice(i, i + step);
    const calls = slice.flatMap((v) => [
      { method: 'eth_getCode', params: [v.address, block] },
      { method: 'eth_getTransactionCount', params: [v.address, block] },
    ]);
    const res = await rpc.batch(calls);
    slice.forEach((v, k) => {
      const code = res[2 * k] as string;
      const nonce = Number(BigInt(res[2 * k + 1] as string));
      const usd = v.nativeUsd + v.tokensUsd;
      const isContract = RULES.excludeContracts && hasContractCode(code);
      if (isContract || nonce > RULES.maxNonce || usd > maxUsd) {
        outliers.count++;
        outliers.usd += usd;
      } else kept.push(v);
    });
  }
  return { kept, outliers };
}
