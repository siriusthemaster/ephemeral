/** Spot prices: Coinbase first, Kraken as fallback. No price means no publish. */
import type { Prices } from './value.ts';

type Fetch = typeof fetch;

async function getJson(f: Fetch, url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await f(url, { signal: ctrl.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const coinbase = async (f: Fetch, pair: string): Promise<number> => {
  const j = (await getJson(f, `https://api.coinbase.com/v2/prices/${pair}/spot`)) as { data?: { amount?: string } };
  return Number(j.data?.amount);
};

const kraken = async (f: Fetch, pair: string): Promise<number> => {
  const j = (await getJson(f, `https://api.kraken.com/0/public/Ticker?pair=${pair}`)) as { error?: string[]; result?: Record<string, { c?: string[] }> };
  if (j.error && j.error.length > 0) throw new Error(j.error.join(','));
  const first = Object.values(j.result ?? {})[0];
  return Number(first?.c?.[0]);
};

const sane = (n: number, lo: number, hi: number): boolean => Number.isFinite(n) && n >= lo && n <= hi;

async function one(f: Fetch, cb: string, kr: string, lo: number, hi: number, log: (m: string) => void): Promise<number> {
  for (const [name, fn, pair] of [['coinbase', coinbase, cb], ['kraken', kraken, kr]] as const) {
    try {
      const n = await fn(f, pair);
      if (sane(n, lo, hi)) return n;
      log(`price ${pair} from ${name} out of range`);
    } catch (e) {
      log(`price ${pair} from ${name} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`no price for ${cb}`);
}

export async function fetchPrices(f: Fetch = fetch, log: (m: string) => void = () => {}): Promise<Prices> {
  const eth = await one(f, 'ETH-USD', 'ETHUSD', 100, 100_000, log);
  const pol = await one(f, 'POL-USD', 'POLUSD', 0.001, 1_000, log);
  return { eth, pol };
}
