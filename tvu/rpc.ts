/**
 * JSON-RPC client with several URLs per chain: retries with backoff on rate limits, 5xx and network errors,
 * then falls over to the next URL. Errors about block range or response size are not retried here, the log
 * scanner reacts to them by shrinking the range.
 */

export class RpcError extends Error {
  constructor(
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

export interface Rpc {
  call<T>(method: string, params: unknown[]): Promise<T>;
  /** Results keep input order. Throws if any item fails. */
  batch(calls: { method: string; params: unknown[] }[]): Promise<unknown[]>;
}

export const isRangeError = (e: unknown): boolean =>
  e instanceof RpcError &&
  (e.code === -32005 || /range|results|response size|too large|too many|exceed|limit|timeout|timed out|payload|max/i.test(e.message));

const RATE_RE = /rate|too many requests|capacity|throughput|try again|busy|overloaded|header not found|missing trie|not synced/i;

export interface FallbackOpts {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  attempts?: number;
  rounds?: number;
  timeoutMs?: number;
}

class Retryable extends Error {}

export class FallbackRpc implements Rpc {
  private pref = 0;
  private id = 1;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly attempts: number;
  private readonly rounds: number;
  private readonly timeoutMs: number;
  constructor(
    public urls: string[],
    o: FallbackOpts = {},
  ) {
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.attempts = o.attempts ?? 3;
    this.rounds = o.rounds ?? 2;
    this.timeoutMs = o.timeoutMs ?? 60_000;
  }

  /** Drop URLs that answer with a different chain id. Unreachable URLs stay (they may recover). */
  async verifyChain(chainId: number): Promise<void> {
    const keep: string[] = [];
    for (const url of this.urls) {
      try {
        const r = (await this.post(url, { jsonrpc: '2.0', id: 0, method: 'eth_chainId', params: [] })) as { result?: string };
        if (r.result !== undefined && Number(BigInt(r.result)) !== chainId) continue;
      } catch {
        /* keep */
      }
      keep.push(url);
    }
    if (keep.length === 0) throw new RpcError(undefined, 'no RPC url for chain ' + chainId);
    this.urls = keep;
  }

  private async post(url: string, body: unknown): Promise<unknown> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (res.status === 429 || res.status >= 500) throw new Retryable(`HTTP ${res.status}`);
      const text = await res.text();
      try {
        return JSON.parse(text);
      } catch {
        throw new Retryable(`non-JSON answer (HTTP ${res.status})`);
      }
    } catch (e) {
      if (e instanceof Retryable) throw e;
      throw new Retryable(e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
    }
  }

  private async run(make: () => unknown, parse: (j: unknown) => unknown): Promise<unknown> {
    let last = 'no url';
    for (let round = 0; round < this.rounds; round++) {
      for (let k = 0; k < this.urls.length; k++) {
        const idx = (this.pref + k) % this.urls.length;
        const url = this.urls[idx] as string;
        for (let attempt = 0; attempt < this.attempts; attempt++) {
          try {
            const out = parse(await this.post(url, make()));
            this.pref = idx;
            return out;
          } catch (e) {
            if (e instanceof RpcError) {
              if (isRangeError(e) && !RATE_RE.test(e.message)) throw e; // caller shrinks the range
              if (e.code === -32601 || e.code === -32600) {
                last = e.message;
                break; // method or batch not supported here, next url
              }
              if (!RATE_RE.test(e.message)) throw e; // a real answer, not a transport problem
            }
            last = e instanceof Error ? e.message : String(e);
            await this.sleep(Math.min(20_000, 500 * 2 ** attempt) + Math.floor(Math.random() * 250));
          }
        }
      }
    }
    throw new RpcError(undefined, `all RPC urls failed: ${last}`);
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    const id = this.id++;
    return (await this.run(
      () => ({ jsonrpc: '2.0', id, method, params }),
      (j) => {
        const r = j as { result?: unknown; error?: { code?: number; message?: string } };
        if (r.error) throw new RpcError(r.error.code, r.error.message ?? 'RPC error');
        return r.result;
      },
    )) as T;
  }

  async batch(calls: { method: string; params: unknown[] }[]): Promise<unknown[]> {
    if (calls.length === 0) return [];
    const ids = calls.map(() => this.id++);
    try {
      return (await this.run(
        () => calls.map((c, i) => ({ jsonrpc: '2.0', id: ids[i], method: c.method, params: c.params })),
        (j) => {
          if (!Array.isArray(j)) {
            const e = (j as { error?: { code?: number; message?: string } }).error;
            throw new RpcError(e?.code ?? -32600, e?.message ?? 'batch not supported');
          }
          const byId = new Map<number, { result?: unknown; error?: { code?: number; message?: string } }>();
          for (const r of j as { id: number }[]) byId.set(r.id, r as never);
          return ids.map((id) => {
            const r = byId.get(id);
            if (!r) throw new Retryable('batch answer is missing an item');
            if (r.error) throw new RpcError(r.error.code, r.error.message ?? 'RPC error');
            return r.result;
          });
        },
      )) as unknown[];
    } catch (e) {
      if (calls.length === 1) throw e;
      // Endpoint without batch support: one call at a time.
      const out: unknown[] = [];
      for (const c of calls) out.push(await this.call(c.method, c.params));
      return out;
    }
  }
}
