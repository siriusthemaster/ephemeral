/**
 * ERC-5564 payments from the chain, not from the announcement (bug bounty, 24 Oct).
 *
 * The ERC-5564 Announcer is permissionless: anyone can announce any address with any metadata, and an announcement
 * moves no value. Taking the payment and its asset from the announcement let a zero-value announcement count as a
 * payment, and let a stranger's "ETH" announcement turn a token-paid address into an ETH payment, which hid the
 * token's real H2 or H5 link (primaryAsset picks ETH first).
 *
 * So a payment is what actually reached the stealth address next to its announcement: the announcement block and the
 * 12 blocks after it, and before it the 2 blocks the client's funding.ts also reads. Before the first announcement of
 * an address the window reaches back a day (7,200 blocks): nobody but the payer can know a fresh stealth address
 * before it is announced, and payers often send first and announce a few blocks later (mainnet has payments 4 and 6
 * blocks ahead of their announcement). The asset is what arrived:
 *   - a token transfer in that window makes it a token payment; ETH that arrives with it is gas, not the payment;
 *   - otherwise ETH in that window makes it an ETH payment;
 *   - otherwise nothing arrived and the announcement is left out (counted as unfunded).
 * The payment transaction (its sender is the payer for H2) is the transaction that moved the value.
 *
 * Umbra announcements stay as decoded: the Umbra contract emits them itself while it moves the funds.
 * Pure function: transfers come in, payments go out; no address leaves this module.
 */
import type { TransferLite } from './data.ts';
import type { PaymentLog } from './decode.ts';

/** blocks before a later announcement of the same address */
export const WINDOW_BEFORE = 2;
/** blocks before the first announcement of an address: about a day */
export const WINDOW_BEFORE_FIRST = 7_200;
export const WINDOW_AFTER = 12;

const ETH_CATEGORIES = new Set(['external', 'internal']);

export interface Confirmed {
  payments: PaymentLog[];
  /** ERC-5564 announcements with nothing arriving next to them: left out */
  unfunded: number;
  /** ERC-5564 announcements whose metadata named another asset than the one that arrived */
  assetMismatch: number;
}

export function confirmPayments(
  logs: readonly PaymentLog[],
  incoming: (stealth: string) => readonly TransferLite[] | undefined,
): Confirmed {
  const payments: PaymentLog[] = [];
  const seen = new Set<string>();
  let unfunded = 0;
  let assetMismatch = 0;
  const firstAnnounced = new Map<string, number>();
  for (const p of logs) {
    if (p.source === 'erc5564') firstAnnounced.set(p.stealth, Math.min(p.blockNumber, firstAnnounced.get(p.stealth) ?? Infinity));
  }
  for (const p of logs) {
    if (p.source !== 'erc5564') {
      payments.push(p);
      continue;
    }
    const before = p.blockNumber === firstAnnounced.get(p.stealth) ? WINDOW_BEFORE_FIRST : WINDOW_BEFORE;
    const arrived = (incoming(p.stealth) ?? []).filter(
      (t) =>
        t.to === p.stealth &&
        t.from !== p.stealth &&
        t.block >= p.blockNumber - before &&
        t.block <= p.blockNumber + WINDOW_AFTER,
    );
    const tokens = arrived.filter((t) => !ETH_CATEGORIES.has(t.category) && t.token !== null);
    const eth = arrived.filter((t) => ETH_CATEGORIES.has(t.category));
    const asset = tokens.length > 0 ? 'TOKEN' : eth.length > 0 ? 'ETH' : null;
    if (asset === null) {
      unfunded++;
      continue;
    }
    const picked = asset === 'TOKEN' ? tokens : eth;
    const claimedOther =
      p.asset !== 'UNKNOWN' && (p.asset !== asset || (asset === 'TOKEN' && p.token !== null && !picked.some((t) => t.token === p.token)));
    if (claimedOther) assetMismatch++;
    for (const t of picked) {
      const key = `${t.hash}|${t.token ?? 'eth'}`;
      if (seen.has(key)) continue; // two announcements for one transfer: one payment
      seen.add(key);
      payments.push({
        source: 'erc5564',
        txHash: t.hash,
        blockNumber: t.block,
        logIndex: p.logIndex,
        blockTimestamp: t.block === p.blockNumber ? p.blockTimestamp : undefined,
        stealth: p.stealth,
        asset,
        token: asset === 'TOKEN' ? t.token : null,
      });
    }
  }
  return { payments, unfunded, assetMismatch };
}
