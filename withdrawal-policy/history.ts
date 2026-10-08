// Past withdrawals from our own stealth addresses, read from public chain history (Blockscout's public API), so the
// collector check (H3) survives reloads and other devices. Nothing is stored: the list is rebuilt each time.
import type { Hex } from 'viem';
/** The only network field the loader needs: Blockscout's v2 API base, e.g. https://eth.blockscout.com/api/v2 */
export type Net = { blockscout?: string | null };

export type Transfer = { from: string; to: string };

type Ref = { hash?: string } | null | undefined;
type BsTx = { from?: Ref; to?: Ref; value?: string | null };
type BsTokenTransfer = { from?: Ref; to?: Ref };
type Page<T> = { items?: T[]; next_page_params?: Record<string, string | number | null> | null };

const PAGES = 4; // 50 items a page; a payment address rarely sends more than a few transactions
const CONCURRENCY = 3;
const TIMEOUT_MS = 15_000;

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

/** Everything one address sent: ETH with a value, and token transfers. `txCount` = transactions it signed, as indexed. */
async function sentBy(base: string, address: Hex, signal?: AbortSignal): Promise<{ out: Transfer[]; txCount: number }> {
  const out: Transfer[] = [];
  const txs = await pages<BsTx>(base, `/addresses/${address}/transactions`, signal);
  const txCount = txs.filter((t) => (t.from?.hash ?? '').toLowerCase() === address.toLowerCase()).length;
  for (const t of txs) {
    const to = t.to?.hash;
    if (to && t.from?.hash && t.value && t.value !== '0') out.push({ from: t.from.hash, to });
  }
  const transfers = await pages<BsTokenTransfer>(base, `/addresses/${address}/token-transfers`, signal);
  for (const t of transfers) {
    const to = t.to?.hash;
    if (to && t.from?.hash) out.push({ from: t.from.hash, to });
  }
  return { out, txCount };
}

/**
 * Reads where the given addresses sent funds. `ok` is false when any address could not be read (or the network has
 * no Blockscout), and also when the explorer is behind the chain: `sentCount` (the on-chain nonce from RPC) says an
 * address signed more transactions than the explorer has indexed. `history` then holds whatever did load.
 */
export async function loadWithdrawalHistory(
  net: Net,
  addresses: Hex[],
  signal?: AbortSignal,
  sentCount: Record<string, number> = {},
): Promise<{ history: Transfer[]; ok: boolean }> {
  if (!addresses.length) return { history: [], ok: true };
  const base = net.blockscout;
  if (!base) return { history: [], ok: false };
  const history: Transfer[] = [];
  let ok = true;
  const queue = [...addresses];
  const worker = async () => {
    while (queue.length) {
      const a = queue.shift()!;
      try {
        const r = await sentBy(base, a, signal);
        history.push(...r.out);
        const expected = sentCount[a.toLowerCase()];
        if (expected !== undefined && r.txCount < expected) ok = false; // explorer lags the chain: history incomplete
      } catch {
        ok = false;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, addresses.length) }, worker));
  return { history, ok: ok && !signal?.aborted };
}
