import { Rpc, RpcError } from './rpc.ts';
import { hex, sleep } from './util.ts';

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
  logIndex: string;
  removed?: boolean;
  blockTimestamp?: string;
}

export interface LogQuery {
  addresses: string[];
  topic0s: string[];
  from: bigint;
  to: bigint;
  initialSpan?: bigint;
  maxSpan?: bigint;
  onProgress?: (scannedBlocks: bigint, totalBlocks: bigint, logs: number) => void;
  /** wait before retrying after the nth transient failure in a row (tests pass a fast one) */
  backoffMs?: (n: number) => number;
}

/** Errors that mean "ask for a smaller block range". */
const SHRINK_RE =
  /block range|range is too|range too|too many|too large|response size|more than|exceed|limit|query returned|timeout|timed out|abort/i;
const FREE_TIER_RE = /free tier|upgrade to (pay|payg|growth)|pay as you go/i;
const SUGGESTED_RE = /\[\s*(0x[0-9a-f]+)\s*,\s*(0x[0-9a-f]+)\s*\]/i;

export class FreePlanError extends Error {
  constructor(detail: string) {
    super(
      'Your RPC plan only allows tiny eth_getLogs ranges (Alchemy Free: 10 blocks on Ethereum). ' +
        'A full history scan would take days. Switch the Alchemy app to Pay As You Go ' +
        '(this scan costs a few dollars) or set RPC_URL to a provider with wide log ranges.\n' +
        `Provider said: ${detail.slice(0, 300)}`,
    );
    this.name = 'FreePlanError';
  }
}

/**
 * Pull logs for several contracts and event signatures in one pass. The block span adapts:
 * it shrinks when the provider rejects a range (or suggests one) and grows after quiet ranges.
 */
export async function scanLogs(rpc: Rpc, q: LogQuery): Promise<RawLog[]> {
  const maxSpan = q.maxSpan ?? 2_000_000n;
  let span = q.initialSpan ?? 500_000n;
  let cur = q.from;
  let transient = 0;
  const out: RawLog[] = [];
  const total = q.to - q.from + 1n;

  while (cur <= q.to) {
    const end = cur + span - 1n > q.to ? q.to : cur + span - 1n;
    try {
      const logs = await rpc.call<RawLog[]>(
        'eth_getLogs',
        [{ fromBlock: hex(cur), toBlock: hex(end), address: q.addresses, topics: [q.topic0s] }],
        { retries: 1, timeoutMs: 60_000 },
      );
      for (const l of logs) if (!l.removed) out.push(l);
      cur = end + 1n;
      transient = 0;
      q.onProgress?.(cur - q.from, total, out.length);
      if (logs.length < 2_000 && span < maxSpan) span = span * 2n > maxSpan ? maxSpan : span * 2n;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (FREE_TIER_RE.test(msg)) throw new FreePlanError(msg);
      const code = e instanceof RpcError ? e.code : undefined;
      const isTransient = code === 429 || (code !== undefined && code >= 500);
      if (isTransient) {
        // Outage, rate limit or a range too heavy to answer in time: wait, then retry; halve the span
        // only after repeated failures on the same range. Give up after ~10 minutes of failures.
        transient++;
        if (transient > 12) throw e;
        if (transient % 3 === 0 && span > 1n) span = span / 2n;
        await sleep(q.backoffMs ? q.backoffMs(transient) : Math.min(60_000, 2_000 * 2 ** Math.min(transient, 5)));
        continue;
      }
      if (!(e instanceof RpcError) || !SHRINK_RE.test(msg) || span === 1n) throw e;
      const suggested = SUGGESTED_RE.exec(msg);
      const suggestedEnd = suggested?.[2] ? BigInt(suggested[2]) : undefined;
      if (suggestedEnd !== undefined && suggestedEnd >= cur && suggestedEnd < end) {
        span = suggestedEnd - cur + 1n;
        // The provider itself says only a tiny range works: that is a plan limit, not a busy range.
        if (span <= 100n && q.to - cur > 1_000_000n) throw new FreePlanError(msg);
      } else {
        span = span / 4n > 0n ? span / 4n : 1n;
      }
    }
  }
  out.sort((a, b) => {
    const d = BigInt(a.blockNumber) - BigInt(b.blockNumber);
    return d !== 0n ? (d < 0n ? -1 : 1) : Number(BigInt(a.logIndex) - BigInt(b.logIndex));
  });
  return out;
}
