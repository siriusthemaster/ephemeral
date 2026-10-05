import { KV } from './cache.ts';
import { MAX_TRANSFER_PAGES } from './config.ts';
import { Rpc, RpcError, type RpcCall } from './rpc.ts';
import { chunk, hex, hexToDecString, hexToNumber, lc, pool, progress } from './util.ts';

export interface TxLite {
  from: string;
  type: number;
  /** maxPriorityFeePerGas in wei for fee-market txs (type >= 2), else null */
  priorityFee: string | null;
}

export interface TransferLite {
  hash: string;
  block: number;
  from: string;
  to: string | null;
  category: string;
  /** token contract for erc20/erc721/erc1155, null for ETH */
  token: string | null;
}

export interface TransferPage {
  transfers: TransferLite[];
  /** true when more than MAX_TRANSFER_PAGES pages existed */
  truncated: boolean;
}

async function batchFill<T>(
  rpc: Rpc,
  keys: readonly string[],
  cache: KV<T>,
  toCall: (key: string) => RpcCall,
  parse: (result: unknown, key: string) => T,
  concurrency: number,
  label: string,
): Promise<void> {
  const todo = [...new Set(keys)].filter((k) => !cache.has(k));
  if (todo.length === 0) return;
  const tick = progress(label);
  let done = 0;
  for (const part of chunk(todo, 2_000)) {
    const results = await rpc.batch<unknown>(part.map(toCall), concurrency);
    for (let i = 0; i < part.length; i++) {
      const key = part[i] as string;
      let r = results[i];
      if (r instanceof RpcError) {
        const c = toCall(key);
        r = await rpc.call<unknown>(c.method, c.params); // one direct retry; throws if it fails again
      }
      cache.set(key, parse(r, key));
    }
    done += part.length;
    tick(done, todo.length);
    cache.flush();
  }
}

export function fetchTxs(rpc: Rpc, hashes: readonly string[], cache: KV<TxLite>, concurrency: number): Promise<void> {
  return batchFill(
    rpc,
    hashes,
    cache,
    (h) => ({ method: 'eth_getTransactionByHash', params: [h] }),
    (r, h) => {
      if (!r) throw new Error(`Transaction ${h} not found`);
      const tx = r as { from: string; type?: string; maxPriorityFeePerGas?: string | null };
      const type = tx.type ? hexToNumber(tx.type) : 0;
      return {
        from: lc(tx.from),
        type,
        priorityFee: type >= 2 ? hexToDecString(tx.maxPriorityFeePerGas ?? null) : null,
      };
    },
    concurrency,
    'transactions',
  );
}

export function fetchBlockTimes(rpc: Rpc, blocks: readonly number[], cache: KV<number>, concurrency: number): Promise<void> {
  return batchFill(
    rpc,
    blocks.map(String),
    cache,
    (b) => ({ method: 'eth_getBlockByNumber', params: [hex(BigInt(b)), false] }),
    (r, b) => {
      if (!r) throw new Error(`Block ${b} not found`);
      return hexToNumber((r as { timestamp: string }).timestamp);
    },
    concurrency,
    'block timestamps',
  );
}

export type CodeKind = 'eoa' | 'contract' | 'delegated';

/** eoa, contract, or an EIP-7702 delegated EOA (code 0xef0100 + address) */
export function fetchCodeKinds(rpc: Rpc, addrs: readonly string[], blockTag: string, cache: KV<CodeKind>, concurrency: number): Promise<void> {
  return batchFill(
    rpc,
    addrs,
    cache,
    (a) => ({ method: 'eth_getCode', params: [a, blockTag] }),
    (r): CodeKind => {
      const code = lc((r as string | null) ?? '0x');
      if (code === '0x') return 'eoa';
      return code.startsWith('0xef0100') ? 'delegated' : 'contract';
    },
    concurrency,
    'code check',
  );
}

/** Nonce of each address just before a given block (keys are "address@block"). */
export function fetchNoncesAt(rpc: Rpc, keys: readonly string[], cache: KV<number>, concurrency: number): Promise<void> {
  return batchFill(
    rpc,
    keys,
    cache,
    (k) => {
      const [addr, block] = k.split('@') as [string, string];
      return { method: 'eth_getTransactionCount', params: [addr, hex(BigInt(block))] };
    },
    (r) => hexToNumber(r as string),
    concurrency,
    'freshness check',
  );
}

/** Alchemy-only. Outgoing (dir 'from') or incoming (dir 'to') value transfers of one address. */
export async function fetchTransfers(
  rpc: Rpc,
  addr: string,
  dir: 'from' | 'to',
  categories: readonly string[],
  fromBlock: bigint,
  toBlock: bigint,
): Promise<TransferPage> {
  const params: Record<string, unknown> = {
    fromBlock: hex(fromBlock),
    toBlock: hex(toBlock),
    category: categories,
    excludeZeroValue: true,
    withMetadata: false,
    maxCount: '0x3e8',
    order: 'asc',
    [dir === 'from' ? 'fromAddress' : 'toAddress']: addr,
  };
  const out: TransferLite[] = [];
  for (let page = 0; page < MAX_TRANSFER_PAGES; page++) {
    let r: {
      transfers: { hash: string; blockNum: string; from: string; to: string | null; category: string; rawContract?: { address?: string | null } }[];
      pageKey?: string;
    };
    try {
      r = await rpc.call('alchemy_getAssetTransfers', [params]);
    } catch (e) {
      if (e instanceof RpcError && /method.*(not|does not)|not (found|supported|available)/i.test(e.message)) {
        throw new Error('This step needs Alchemy (alchemy_getAssetTransfers). Set ALCHEMY_KEY instead of RPC_URL.');
      }
      throw e;
    }
    for (const t of r.transfers) {
      out.push({
        hash: lc(t.hash),
        block: hexToNumber(t.blockNum),
        from: lc(t.from),
        to: t.to ? lc(t.to) : null,
        category: t.category,
        token: t.rawContract?.address ? lc(t.rawContract.address) : null,
      });
    }
    if (!r.pageKey) return { transfers: out, truncated: false };
    params.pageKey = r.pageKey;
  }
  return { transfers: out, truncated: true };
}

export async function fetchAllTransfers(
  rpc: Rpc,
  addrs: readonly string[],
  dir: 'from' | 'to',
  categories: readonly string[],
  fromBlock: bigint,
  toBlock: bigint,
  cache: KV<TransferPage>,
  concurrency: number,
  label: string,
): Promise<void> {
  const todo = [...new Set(addrs)].filter((a) => !cache.has(a));
  if (todo.length === 0) return;
  const tick = progress(label);
  let done = 0;
  await pool(todo, concurrency, async (a) => {
    cache.set(a, await fetchTransfers(rpc, a, dir, categories, fromBlock, toBlock));
    tick(++done, todo.length);
  });
  cache.flush();
}

/** First block whose timestamp is >= ts, searched in [lo, hi]. Returns hi + 1 if none. */
export async function blockAtOrAfter(rpc: Rpc, ts: number, lo: bigint, hi: bigint): Promise<bigint> {
  const time = async (b: bigint): Promise<number> =>
    hexToNumber((await rpc.call<{ timestamp: string }>('eth_getBlockByNumber', [hex(b), false])).timestamp);
  if ((await time(hi)) < ts) return hi + 1n;
  if ((await time(lo)) >= ts) return lo;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if ((await time(mid)) >= ts) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** The finalized block, so a transfer index lagging the head cannot change a fixed range later. */
export async function finalizedBlock(rpc: Rpc): Promise<bigint> {
  try {
    const b = await rpc.call<{ number: string } | null>('eth_getBlockByNumber', ['finalized', false]);
    if (b?.number) return BigInt(b.number);
  } catch {
    // provider without the finalized tag
  }
  return BigInt(await rpc.call<string>('eth_blockNumber', [])) - 64n;
}
