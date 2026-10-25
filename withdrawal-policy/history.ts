// Past withdrawals from our own stealth addresses, read from public chain history (Blockscout's public API), so the
// collector check (H3) survives reloads and other devices. Nothing is stored: the list is rebuilt each time.
import type { Hex } from 'viem';
/** The only network field the loader needs: Blockscout's v2 API base, e.g. https://eth.blockscout.com/api/v2 */
export type Net = { blockscout?: string | null };

export type Transfer = { from: string; to: string };

/** A raw log as eth_getLogs returns it (viem's formatted logs fit too). */
export type RpcLog = {
  transactionHash?: string | null;
  logIndex?: string | number | null;
  topics?: readonly (string | null)[];
  removed?: boolean;
};
/** One eth_getLogs call: logs with these topics in [fromBlock, toBlock] (both inclusive). */
export type LogFetcher = (q: { fromBlock: bigint; toBlock: bigint; topics: (Hex | null)[] }) => Promise<RpcLog[]>;
/** The node the token transfers are read from directly, not through the explorer. Injectable, so tests need no node. */
export type NodeReader = { getLogs: LogFetcher; blockNumber: () => Promise<bigint> };
/**
 * Token transfers sent from each address, read straight from the node: ERC-20 (and ERC-721) Transfer logs and ERC-1155
 * TransferSingle and TransferBatch logs with `from` = the address, from its first payment block (or `fromBlock`) to the
 * latest block, in ranges of `chunk` blocks.
 */
export type TokenLogCheck = {
  node: NodeReader;
  fromBlock: bigint; // start for an address without an entry in `firstBlock`
  firstBlock?: Record<string, bigint>; // lowercase address -> block of its first payment
  chunk?: bigint; // blocks per eth_getLogs call (default 10,000); halved while the node refuses a range
};

type Ref = { hash?: string } | null | undefined;
type BsTx = { hash?: string | null; from?: Ref; to?: Ref; value?: string | null; raw_input?: string | null };
type BsTokenTransfer = {
  from?: Ref;
  to?: Ref;
  transaction_hash?: string | null;
  tx_hash?: string | null; // older Blockscout versions
  log_index?: string | number | null;
};
type Page<T> = { items?: T[]; next_page_params?: Record<string, string | number | null> | null };

const PAGES = 4; // 50 items a page; a payment address rarely sends more than a few transactions
const CONCURRENCY = 3;
const TIMEOUT_MS = 15_000;
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as Hex; // Transfer(address,address,uint256)
// ERC-1155: TransferSingle(operator, from, to, id, value) and TransferBatch(operator, from, to, ids, values); `from` is topic 2
const TRANSFER_SINGLE_TOPIC = '0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62' as Hex;
const TRANSFER_BATCH_TOPIC = '0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb' as Hex;
export const ERC20_TRANSFER = '0xa9059cbb'; // transfer(address,uint256)
export const ERC20_TRANSFER_FROM = '0x23b872dd'; // transferFrom(address,address,uint256)
const CHUNK = 10_000n;
const MIN_CHUNK = 500n;

class Failed extends Error {}

/** One Blockscout GET. Retries on rate limits, server errors and network errors. 404 = Blockscout has never seen it. */
async function get<T>(url: URL, signal?: AbortSignal): Promise<T | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) throw new Failed('aborted');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      const res = await fetch(url.toString(), {
        headers: { accept: 'application/json' },
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        signal: ctrl.signal,
      });
      if (res.status === 404) return null;
      if (res.ok) return (await res.json()) as T;
      if (res.status !== 429 && res.status < 500) throw new Failed(`http-${res.status}`);
    } catch (e) {
      if (e instanceof Failed) throw e;
      if (signal?.aborted) throw new Failed('aborted');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
  }
  throw new Failed('unreachable');
}

async function pages<T>(base: string, path: string, signal?: AbortSignal): Promise<T[]> {
  const out: T[] = [];
  let next: Page<T>['next_page_params'] = undefined;
  for (let p = 0; p < PAGES; p++) {
    const url = new URL(base + path);
    url.searchParams.set('filter', 'from');
    for (const [k, v] of Object.entries(next ?? {})) if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
    const page = await get<Page<T>>(url, signal);
    if (!page) break;
    out.push(...(page.items ?? []));
    next = page.next_page_params;
    if (!next || !(page.items ?? []).length) break;
  }
  return out;
}

/** Identifies one log: transaction hash and log index (hex or decimal), or transaction hash and recipient. */
const logKey = (tx: string, index: string | number | null | undefined) =>
  index === null || index === undefined || index === '' ? null : `${tx.toLowerCase()}:${Number(index)}`;
const toKey = (tx: string, to: string) => `${tx.toLowerCase()}>${to.toLowerCase()}`;
const topicAddress = (t: string) => `0x${t.slice(-40)}`.toLowerCase();

/**
 * The token recipient of a call `sender` signed, read from its calldata alone: `to` of transfer(to, amount), or of
 * transferFrom(from, to, amount) when `from` is the sender. null = the call cannot be attributed: another selector, too
 * short, an address word with dirty high bytes, or transferFrom of someone else's tokens.
 */
export function tokenCallRecipient(sender: string, input: unknown): string | null {
  if (typeof input !== 'string' || typeof sender !== 'string') return null;
  const s = input.toLowerCase();
  if (!/^0x([0-9a-f]{2})*$/.test(s) || s.length < 10) return null;
  const word = (i: number) => s.slice(10 + i * 64, 10 + (i + 1) * 64);
  const addr = (w: string) => (/^0{24}[0-9a-f]{40}$/.test(w) ? `0x${w.slice(24)}` : null);
  const words = Math.floor((s.length - 10) / 64);
  const selector = s.slice(0, 10);
  if (selector === ERC20_TRANSFER && words >= 2) return addr(word(0));
  if (selector === ERC20_TRANSFER_FROM && words >= 3) {
    const from = addr(word(0));
    return from !== null && from === sender.toLowerCase() ? addr(word(1)) : null;
  }
  return null;
}

/** Everything one address sent: ETH with a value, token transfers, and what its zero-value transactions did.
 *  `txCount` = transactions it signed, as indexed. `indexed` identifies each token transfer the explorer has (see
 *  logKey/toKey), to compare with the node's logs. A transaction it signed that moved no ETH is read from its calldata:
 *  - no calldata: a plain transaction to `to`, a public link like any send, so `to` is a past destination;
 *  - transfer or transferFrom of its own tokens: the recipient is a past destination, even if the token logged nothing;
 *  - anything else (approve, setApprovalForAll, an unknown call, unreadable input, no `to`): counted in `unattributed`,
 *    which makes the history incomplete, because such a call can let tokens leave later without a trace we can read. */
async function sentBy(
  base: string,
  address: Hex,
  signal?: AbortSignal,
): Promise<{ out: Transfer[]; txCount: number; indexed: Set<string>; unattributed: number }> {
  const out: Transfer[] = [];
  const indexed = new Set<string>();
  const own = (t: BsTx) => (t.from?.hash ?? '').toLowerCase() === address.toLowerCase();
  const add = (from: string, to: string) => {
    if (!out.some((o) => o.from.toLowerCase() === from.toLowerCase() && o.to.toLowerCase() === to.toLowerCase())) out.push({ from, to });
  };
  const txs = await pages<BsTx>(base, `/addresses/${address}/transactions`, signal);
  const txCount = txs.filter(own).length;
  const calls: BsTx[] = [];
  for (const t of txs) {
    const to = t.to?.hash;
    if (to && t.from?.hash && t.value && t.value !== '0') out.push({ from: t.from.hash, to });
    else if (own(t) && (!t.value || t.value === '0')) calls.push(t); // moved no ETH: what it did is read from its calldata below
  }
  const transfers = await pages<BsTokenTransfer>(base, `/addresses/${address}/token-transfers`, signal);
  for (const t of transfers) {
    const to = t.to?.hash;
    if (to && t.from?.hash) out.push({ from: t.from.hash, to });
    const tx = t.transaction_hash ?? t.tx_hash;
    if (!tx) continue;
    const k = logKey(tx, t.log_index);
    if (k) indexed.add(k);
    else if (to) indexed.add(toKey(tx, to)); // no log index from this explorer version: match on transaction + recipient
  }
  let unattributed = 0;
  for (const t of calls) {
    const to = t.to?.hash;
    let input = typeof t.raw_input === 'string' ? t.raw_input : null;
    if (input === null && typeof t.hash === 'string' && /^0x[0-9a-fA-F]{64}$/.test(t.hash)) {
      const full = await get<BsTx>(new URL(`${base}/transactions/${t.hash}`), signal).catch(() => null);
      input = typeof full?.raw_input === 'string' ? full.raw_input : null;
    }
    if (!to || input === null) {
      unattributed++;
      continue;
    }
    if (input === '' || input === '0x') {
      add(address, to); // a zero-value transaction with no call: still a public link from this address to `to`
      continue;
    }
    const recipient = tokenCallRecipient(address, input);
    if (recipient === null) unattributed++;
    else add(address, recipient);
  }
  return { out, txCount, indexed, unattributed };
}

/** eth_getLogs over [from, to] in ranges of `chunk` blocks. A refused range (too many blocks or results for this node,
 *  or a transient error) is retried at half the size, down to MIN_CHUNK; then the read fails. */
async function logsInRange(getLogs: LogFetcher, topics: (Hex | null)[], from: bigint, to: bigint, chunk: bigint, signal?: AbortSignal) {
  const logs: RpcLog[] = [];
  let size = chunk > 0n ? chunk : CHUNK;
  for (let start = from; start <= to; ) {
    if (signal?.aborted) throw new Failed('aborted');
    const end = start + size - 1n < to ? start + size - 1n : to;
    try {
      logs.push(...(await getLogs({ fromBlock: start, toBlock: end, topics })));
      start = end + 1n;
    } catch {
      if (size <= MIN_CHUNK) throw new Failed('logs');
      size = size / 2n > MIN_CHUNK ? size / 2n : MIN_CHUNK;
    }
  }
  return logs;
}

/** Token transfers the node shows `address` sent, up to `latest`, that are not among the explorer's `indexed` ones:
 *  ERC-20 and ERC-721 Transfer (`from` = topic 1, recipient = topic 2) and ERC-1155 TransferSingle and TransferBatch
 *  (`from` = topic 2, recipient = topic 3). An ERC-1155 move by an approved operator does not use the address's nonce. */
async function unindexedTokenTransfers(
  check: TokenLogCheck,
  address: Hex,
  latest: bigint,
  indexed: Set<string>,
  signal?: AbortSignal,
): Promise<number> {
  const from = check.firstBlock?.[address.toLowerCase()] ?? check.fromBlock;
  if (from > latest) return 0;
  const me = address.toLowerCase();
  const padded = `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}` as Hex;
  const kinds: { topics: (Hex | null)[]; fromAt: number; toAt: number }[] = [
    { topics: [TRANSFER_TOPIC, padded], fromAt: 1, toAt: 2 },
    { topics: [TRANSFER_SINGLE_TOPIC, null, padded], fromAt: 2, toAt: 3 },
    { topics: [TRANSFER_BATCH_TOPIC, null, padded], fromAt: 2, toAt: 3 },
  ];
  let missing = 0;
  for (const kind of kinds) {
    const logs = await logsInRange(check.node.getLogs, kind.topics, from, latest, check.chunk ?? CHUNK, signal);
    for (const l of logs) {
      const topics = l.topics ?? [];
      const fromTopic = topics[kind.fromAt];
      if (l.removed || (topics[0] ?? '').toLowerCase() !== kind.topics[0] || !fromTopic || topicAddress(fromTopic) !== me)
        continue; // not a transfer from this address (or dropped by a reorg)
      const tx = l.transactionHash;
      const k = tx ? logKey(tx, l.logIndex) : null;
      const toTopic = topics[kind.toAt];
      const seen = !!tx && ((k !== null && indexed.has(k)) || (!!toTopic && indexed.has(toKey(tx, topicAddress(toTopic)))));
      if (!seen) missing++;
    }
  }
  return missing;
}

/** A NodeReader over plain JSON-RPC (fetch), for callers without a client library. */
export function jsonRpcNode(url: string): NodeReader {
  let id = 0;
  const call = async (method: string, params: unknown[]) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Failed(`rpc-http-${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error || body.result === undefined) throw new Failed(`rpc: ${body.error?.message ?? 'no result'}`);
    return body.result;
  };
  const hex = (n: bigint) => `0x${n.toString(16)}`;
  return {
    blockNumber: async () => BigInt((await call('eth_blockNumber', [])) as string),
    getLogs: async (q) =>
      (await call('eth_getLogs', [{ fromBlock: hex(q.fromBlock), toBlock: hex(q.toBlock), topics: q.topics }])) as RpcLog[],
  };
}

/**
 * The on-chain nonces by lowercase address, from a map whose keys may be in any case (lowercase, checksummed).
 * A value that is not a non-negative safe integer (a failed read such as -1, NaN, a string) is no nonce: the address
 * maps to null. Two keys for one address: any unusable value makes it null, else the larger nonce counts (stricter).
 */
function nonceMap(sentCount: Record<string, number> | null | undefined): Map<string, number | null> {
  const out = new Map<string, number | null>();
  if (!sentCount || typeof sentCount !== 'object') return out;
  for (const [k, v] of Object.entries(sentCount)) {
    const key = k.toLowerCase();
    const prev = out.get(key);
    const usable = typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
    if (!usable || prev === null) out.set(key, null);
    else if (prev === undefined || v > prev) out.set(key, v);
  }
  return out;
}

/**
 * Reads where the given addresses sent funds. `ok` is false when any address could not be read (or the network has
 * no Blockscout), and also when the explorer is behind the chain, checked two ways:
 * - `sentCount` (the on-chain nonce from RPC) says an address signed more transactions than the explorer has indexed.
 *   It is required: it maps every address of `addresses` to its nonce, keys in any case. An address without a usable
 *   entry (missing, a failed read, not a non-negative integer) cannot be checked against the chain, so `ok` is false
 *   (fail safe: an ETH withdrawal the explorer has not indexed yet is only caught here);
 * - `tokenLogs`: the node's token transfer logs from an address (ERC-20 and ERC-721 Transfer, ERC-1155 TransferSingle
 *   and TransferBatch) include one the explorer's token transfers do not. That catches what the nonce cannot: a token
 *   transfer not indexed yet although its transaction is, a token transfer relayed for the address (permit,
 *   transferWithAuthorization) and an ERC-1155 move by an approved operator, none of which use its nonce.
 * A zero-value transaction the address signed that is neither a plain transaction nor a transfer of its own tokens
 * (an approval, an unknown call, unreadable input) also makes `ok` false: it can let tokens leave later without a trace.
 * Without `tokenLogs`, or when the node cannot be read, token transfers cannot be confirmed and `ok` is false (fail safe).
 * `history` then holds whatever did load.
 */
export async function loadWithdrawalHistory(
  net: Net,
  addresses: Hex[],
  signal?: AbortSignal,
  sentCount?: Record<string, number>,
  tokenLogs?: TokenLogCheck,
): Promise<{ history: Transfer[]; ok: boolean }> {
  if (!addresses.length) return { history: [], ok: true };
  const nonces = nonceMap(sentCount);
  const base = net.blockscout;
  if (!base) return { history: [], ok: false };
  const history: Transfer[] = [];
  let ok = true;
  // the node's head, read once before the explorer: every log up to here must already be indexed
  const latest = tokenLogs ? await tokenLogs.node.blockNumber().catch(() => null) : null;
  if (latest === null) ok = false;
  const queue = [...addresses];
  const worker = async () => {
    while (queue.length) {
      const a = queue.shift()!;
      try {
        const r = await sentBy(base, a, signal);
        history.push(...r.out);
        const expected = nonces.get(a.toLowerCase());
        // no usable nonce: the explorer cannot be checked against the chain, so the history is incomplete (fail safe)
        if (expected === undefined || expected === null) ok = false;
        else if (r.txCount < expected) ok = false; // explorer lags the chain: history incomplete
        if (r.unattributed > 0) ok = false; // a zero-value call we cannot attribute: history incomplete (fail safe)
        if (tokenLogs && latest !== null && (await unindexedTokenTransfers(tokenLogs, a, latest, r.indexed, signal)) > 0)
          ok = false; // a token transfer on chain is missing from the explorer: history incomplete
      } catch {
        ok = false;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, addresses.length) }, worker));
  return { history, ok: ok && !signal?.aborted };
}
