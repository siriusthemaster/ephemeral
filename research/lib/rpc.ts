import { chunk, pool, sleep } from './util.ts';

export class RpcError extends Error {
  constructor(
    readonly code: number | undefined,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

class RetryableError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export interface RpcCall {
  method: string;
  params: unknown[];
}

export interface RpcOptions {
  maxBatch?: number;
  retries?: number;
  timeoutMs?: number;
}

export interface CallOptions {
  retries?: number;
  timeoutMs?: number;
}

interface JsonRpcResponse {
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

const RATE_LIMIT_RE = /rate limit|too many requests|throughput|capacity|compute units per second|exceeded .*limit for/i;
const NOT_RATE_LIMIT_RE = /block range|range|results|response size|log response/i;

function isRateLimited(err: JsonRpcResponse['error']): boolean {
  if (!err) return false;
  const msg = err.message ?? '';
  if (err.code === 429) return true;
  return RATE_LIMIT_RE.test(msg) && !NOT_RATE_LIMIT_RE.test(msg);
}

function isNetworkError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name} ${e.message} ${String((e as { cause?: unknown }).cause ?? '')}` : String(e);
  return /AbortError|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|UND_ERR/i.test(msg);
}

/**
 * Minimal JSON-RPC client: retries on HTTP 429/5xx, rate-limit errors and network errors,
 * and batches calls. Errors that are not about rate limits are returned to the caller.
 */
export class Rpc {
  private nextId = 1;
  readonly stats = { httpRequests: 0, calls: 0, retries: 0 };

  constructor(
    readonly url: string,
    private readonly opts: RpcOptions = {},
  ) {}

  private async post(body: unknown, co: CallOptions = {}): Promise<JsonRpcResponse | JsonRpcResponse[]> {
    const retries = co.retries ?? this.opts.retries ?? 7;
    for (let attempt = 0; ; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), co.timeoutMs ?? this.opts.timeoutMs ?? 90_000);
      try {
        this.stats.httpRequests++;
        const res = await fetch(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (res.status === 429 || res.status >= 500) throw new RetryableError(`HTTP ${res.status}`, res.status);
        const text = await res.text();
        let json: JsonRpcResponse | JsonRpcResponse[];
        try {
          json = JSON.parse(text) as JsonRpcResponse | JsonRpcResponse[];
        } catch {
          throw new RpcError(res.status, `Non-JSON response (HTTP ${res.status}): ${text.slice(0, 200)}`);
        }
        if (Array.isArray(json)) {
          if (json.some((r) => isRateLimited(r.error))) throw new RetryableError('rate limited inside batch');
        } else if (isRateLimited(json.error)) {
          throw new RetryableError(json.error?.message ?? 'rate limited');
        }
        return json;
      } catch (e) {
        const retryable = e instanceof RetryableError || isNetworkError(e);
        if (!retryable || attempt >= retries) {
          if (e instanceof RetryableError) throw new RpcError(e.status ?? 429, `Gave up after ${attempt + 1} attempts: ${e.message}`);
          if (isNetworkError(e)) throw new RpcError(599, `Gave up after ${attempt + 1} attempts: ${e instanceof Error ? e.message : String(e)}`);
          throw e;
        }
        this.stats.retries++;
        await sleep(Math.min(30_000, 400 * 2 ** attempt) + Math.random() * 300);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async call<T>(method: string, params: unknown[], co: CallOptions = {}): Promise<T> {
    this.stats.calls++;
    const json = await this.post({ jsonrpc: '2.0', id: this.nextId++, method, params }, co);
    if (Array.isArray(json)) throw new RpcError(undefined, `Unexpected batch response to ${method}`);
    if (json.error) throw new RpcError(json.error.code, json.error.message ?? 'RPC error', json.error.data);
    return json.result as T;
  }

  /**
   * Run many calls as JSON-RPC batches. Results keep input order; a failed item is an RpcError.
   * Falls back to single calls if the endpoint rejects batches.
   */
  async batch<T>(calls: readonly RpcCall[], concurrency = 4): Promise<(T | RpcError)[]> {
    const size = this.opts.maxBatch ?? 50;
    const groups = chunk(
      calls.map((c, i) => ({ ...c, i })),
      size,
    );
    const out = new Array<T | RpcError>(calls.length);
    await pool(groups, concurrency, async (group) => {
      this.stats.calls += group.length;
      const ids = group.map(() => this.nextId++);
      const json = await this.post(
        group.map((c, k) => ({ jsonrpc: '2.0', id: ids[k], method: c.method, params: c.params })),
      );
      if (!Array.isArray(json)) {
        // Endpoint does not accept batches: fall back to one call at a time.
        for (const c of group) {
          try {
            out[c.i] = await this.call<T>(c.method, c.params);
          } catch (e) {
            out[c.i] = e instanceof RpcError ? e : new RpcError(undefined, String(e));
          }
        }
        return;
      }
      const byId = new Map(json.map((r) => [r.id, r]));
      group.forEach((c, k) => {
        const r = byId.get(ids[k] as number);
        if (!r) out[c.i] = new RpcError(undefined, 'Missing item in batch response');
        else if (r.error) out[c.i] = new RpcError(r.error.code, r.error.message ?? 'RPC error', r.error.data);
        else out[c.i] = r.result as T;
      });
    });
    return out;
  }
}
