/**
 * Address collection: Umbra Announcement and ERC-5564 Announcement logs, incremental, adaptive range.
 */
import { ANNOUNCER, ANNOUNCER_TOPIC0, EXCLUDED_CALLERS, UMBRA, UMBRA_TOPIC0 } from './config.ts';
import { skipHash, type ChainState } from './checkpoint.ts';
import { isRangeError, type Rpc } from './rpc.ts';

export interface RawLog {
  address: string;
  topics: string[];
  blockNumber: string;
}

const tail20 = (topic: string): string => '0x' + topic.slice(-40).toLowerCase();
const excluded = new Set<string>(EXCLUDED_CALLERS);

/** Apply one log to the state. Returns nothing about excluded announcements on purpose: they are never counted. */
export function applyLog(s: ChainState, log: RawLog): void {
  const a = log.address.toLowerCase();
  if (a === UMBRA && log.topics[0] === UMBRA_TOPIC0 && log.topics.length === 3) {
    s.addresses.add(tail20(log.topics[1] as string));
    s.umbra++;
  } else if (a === ANNOUNCER && log.topics[0] === ANNOUNCER_TOPIC0 && log.topics.length === 4) {
    const stealth = tail20(log.topics[2] as string);
    if (excluded.has(tail20(log.topics[3] as string))) {
      s.skip.add(skipHash(stealth));
    } else {
      s.addresses.add(stealth);
      s.erc5564++;
    }
  }
}

export interface ScanOpts {
  start: number;
  head: number;
  maxSpan?: number;
  /** Return true to stop (run budget). Checked between ranges. */
  stop?: () => boolean;
  /** Called after every completed range. */
  onProgress?: (s: ChainState) => void;
}

const hex = (n: number): string => '0x' + n.toString(16);

/** Scan from state.lastBlock+1 (or opts.start) to opts.head. Returns true when the head was reached. */
export async function scanChain(rpc: Rpc, s: ChainState, o: ScanOpts): Promise<boolean> {
  const maxSpan = o.maxSpan ?? 5_000_000;
  let from = s.lastBlock > 0 ? s.lastBlock + 1 : o.start;
  while (from <= o.head) {
    if (o.stop?.()) return false;
    const span = Math.max(1, Math.min(s.span, maxSpan));
    const to = Math.min(o.head, from + span - 1);
    let logs: RawLog[];
    try {
      logs = await rpc.call<RawLog[]>('eth_getLogs', [
        { fromBlock: hex(from), toBlock: hex(to), address: [UMBRA, ANNOUNCER], topics: [[UMBRA_TOPIC0, ANNOUNCER_TOPIC0]] },
      ]);
    } catch (e) {
      if (isRangeError(e) && span > 1) {
        s.span = Math.max(1, Math.floor(span / 2));
        continue;
      }
      throw e;
    }
    for (const l of logs) applyLog(s, l);
    s.lastBlock = to;
    from = to + 1;
    if (logs.length === 0) s.span = Math.min(maxSpan, span * 2);
    else if (logs.length > 1500) s.span = Math.max(1, Math.floor(span / 2));
    o.onProgress?.(s);
  }
  return true;
}
