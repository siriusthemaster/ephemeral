export const hex = (n: bigint | number): string => '0x' + BigInt(n).toString(16);

export const lc = (a: string): string => a.toLowerCase();

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Run fn over items with at most `concurrency` in flight. Results keep input order. */
export async function pool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i] as T, i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Percentage with two decimals; 0 when the denominator is 0. */
export const pct = (part: number, whole: number): number =>
  whole === 0 ? 0 : Math.round((part / whole) * 10_000) / 100;

export const hexToNumber = (h: string): number => Number(BigInt(h));

export const hexToDecString = (h: string | null | undefined): string | null =>
  h === null || h === undefined ? null : BigInt(h).toString(10);

export function progress(label: string): (done: number, total: number) => void {
  let last = 0;
  const started = Date.now();
  return (done, total) => {
    const now = Date.now();
    if (done !== total && now - last < 2_000) return;
    last = now;
    const secs = (now - started) / 1000;
    const rate = done / Math.max(secs, 0.001);
    const eta = rate > 0 ? Math.round((total - done) / rate) : 0;
    const share = total === 0 ? 100 : Math.floor((done / total) * 100);
    process.stderr.write(`  ${label}: ${done}/${total} (${share}%)${done < total ? `, ~${eta}s left` : ''}\n`);
  };
}
