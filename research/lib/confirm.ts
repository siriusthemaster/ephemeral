/**
 * ERC-5564 payments from the chain, not from the announcement (bug bounty, 24 Oct).
 *
 * The ERC-5564 Announcer is permissionless: anyone can announce any address with any metadata, and an announcement
 * moves no value. Taking the payment and its asset from the announcement let a zero-value announcement count as a
 * payment, and let a stranger's "ETH" announcement turn a token-paid address into an ETH payment, which hid the
 * token's real H2 or H5 link (primaryAsset picks ETH first).
 *
 * So a payment is what actually reached the stealth address next to its announcement: the announcement block and the
 * 12 blocks after it, and before it the 2 blocks the client's funding.ts also reads. Until an announcement of an
 * address is funded, each one's window reaches back a day (7,200 blocks; bug bounty 8 Nov: before, only the earliest
 * announcement had it, so a stranger announcing first shortened the real one): nobody but the payer can know a fresh stealth address
 * before it is announced, and payers often send first and announce a few blocks later (mainnet has payments 4 and 6
 * blocks ahead of their announcement). The asset is what arrived:
 *   - a token transfer in that window makes it a token payment; ETH that arrives with it is gas, not the payment;
 *   - otherwise ETH in that window makes it an ETH payment;
 *   - otherwise nothing arrived and the announcement is left out (counted as unfunded).
 * The payment transaction (its sender is the payer for H2) is the transaction that moved the value.
 *
 * A stranger can also send a token to the address (bug bounty N14, 3 Nov), and announce it (bug bounty 4 and 5 Nov:
 * the Announcer is permissionless, so another announcement's claim proves nothing). The payer of an announcement is
 * the signer of the transaction that carries it (`senderOf`); who a transfer log says sent a token proves nothing
 * (a fake token logs any `from`), and neither does a stranger's wei (bug bounty 6 Nov, four bypasses). A token is
 * bound to the announcement being confirmed only when it arrived in the same transaction as that announcement, in a
 * transaction the payer signed that also carried ETH (a gas tip, StealthBuy), or when this announcement itself names
 * that exact token; when its metadata names no token, also when the payer signed the transaction that moved the
 * token (one payer sent the token and its gas). Bound tokens are the payment. Otherwise ETH the payer sent is the
 * payment, whatever the metadata says (ETH, a token, a selector without a token, or too short to read), and the
 * unbound tokens are counted in `tokenDust`. Only when the payer sent no ETH do unbound tokens stay the payment (a
 * stranger's ETH, claim or wei, cannot hide a token-paid address, 24 Oct, 6 Nov). Without the signer of the
 * announcement's transaction (scan.ts always has it) only the announcement's own transaction binds a token and any
 * arrived ETH is the payment, as before.
 * Every announcement is confirmed on its own: a griefer's announcement with its own dust becomes the griefer's own
 * small payment, never a change to the real one. Only ERC-5564 scheme 1 (secp256k1 with view tags) is read
 * (decode.ts).
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
  /** ERC-5564 announcements where tokens not bound to them arrived next to the payment: not the payment */
  tokenDust: number;
}

/** the signer (`from`) of a transaction, lower case; undefined when unknown */
export type SenderOf = (txHash: string) => string | undefined;

type Incoming = (stealth: string) => readonly TransferLite[] | undefined;

/** Arrivals at the stealth address from `before` blocks ahead of the announcement to WINDOW_AFTER blocks after it. */
function arrivals(p: PaymentLog, incoming: Incoming, before: number): TransferLite[] {
  return (incoming(p.stealth) ?? []).filter(
    (t) => t.to === p.stealth && t.from !== p.stealth && t.block >= p.blockNumber - before && t.block <= p.blockNumber + WINDOW_AFTER,
  );
}

/** Transactions whose signer confirmPayments needs: each ERC-5564 announcement's own, and the arrivals in its longest
 *  possible window when a token arrived there or the announcement names a token (binding, and whether the payer's
 *  own ETH arrived, decide those; bug bounty 8 Nov: without the ETH signers a payment named as a token but paid in
 *  ETH was dropped). */
export function neededTxs(logs: readonly PaymentLog[], incoming: Incoming): string[] {
  const out = new Set<string>();
  for (const p of logs) {
    if (p.source !== 'erc5564') continue;
    out.add(p.txHash);
    const arrived = arrivals(p, incoming, WINDOW_BEFORE_FIRST);
    const tokenArrived = arrived.some((t) => !ETH_CATEGORIES.has(t.category) && t.token !== null);
    if (tokenArrived || (p.asset === 'TOKEN' && p.token !== null)) for (const t of arrived) out.add(t.hash);
  }
  return [...out];
}

export function confirmPayments(logs: readonly PaymentLog[], incoming: Incoming, senderOf: SenderOf = () => undefined): Confirmed {
  const payments: PaymentLog[] = [];
  const seen = new Set<string>();
  let unfunded = 0;
  let assetMismatch = 0;
  let tokenDust = 0;
  // Announcements are read in chain order. The long look-back belongs to the first announcement of an address until
  // one of them is funded: a stranger's earlier announcement that ends unfunded no longer shortens the real one's
  // window (bug bounty 8 Nov). After a funded one, a later announcement looks 2 blocks back, so ETH topped up for gas
  // is not read as a new payment. What arrived before that funded announcement and stayed unclaimed, from a signer
  // other than its own, is still in reach of a later one (bug bounty 8 Nov, afternoon: a stranger who funded his own
  // earlier announcement with 1 wei or a dust token still shortened the real one's window and hid the payment), and so
  // is what landed unclaimed inside that funded announcement's own window (bug bounty 9 Nov). The payer's own gas next
  // to its funded announcement stays out. Results keep the input order.
  const order = logs
    .map((p, i) => ({ p, i }))
    .sort((x, y) => x.p.blockNumber - y.p.blockNumber || x.p.logIndex - y.p.logIndex || x.i - y.i);
  const fundedAt = new Map<string, { block: number; payer: string | undefined }>();
  const claimed = (t: TransferLite, stealth: string) => seen.has(`${t.hash}|${stealth}|${t.token ?? 'eth'}`);
  const byIndex = new Map<number, PaymentLog[]>();
  for (const { p, i } of order) {
    if (p.source !== 'erc5564') {
      byIndex.set(i, [p]);
      continue;
    }
    const first = fundedAt.get(p.stealth);
    let arrived: TransferLite[];
    if (first !== undefined && first.block < p.blockNumber) {
      arrived = arrivals(p, incoming, WINDOW_BEFORE);
      if (first.payer !== undefined) {
        // up to the end of the funded announcement's own window: what landed in its 12 blocks after it and stayed
        // unclaimed was read there as dust, not as its payment (bug bounty 9 Nov: before, only what arrived before
        // the funded announcement's block was in reach, so a token paid inside that window stayed hidden)
        const older = arrivals(p, incoming, WINDOW_BEFORE_FIRST).filter((t) => {
          const by = senderOf(t.hash);
          return t.block <= first.block + WINDOW_AFTER && !claimed(t, p.stealth) && by !== undefined && by !== first.payer && !arrived.includes(t);
        });
        arrived = [...older, ...arrived];
      }
    } else arrived = arrivals(p, incoming, WINDOW_BEFORE_FIRST);
    const allTokens = arrived.filter((t) => !ETH_CATEGORIES.has(t.category) && t.token !== null);
    const eth = arrived.filter((t) => ETH_CATEGORIES.has(t.category));
    // Metadata that names no token (too short, an unknown selector, or a token selector without the token) cannot
    // bind a token by name; there a token sent by the same sender as arrived ETH is the payment and the ETH its gas.
    const namesNoToken = p.asset === 'UNKNOWN' || (p.asset === 'TOKEN' && p.token === null);
    // The payer signed the announcement's transaction. A log's `from` is not evidence (any token contract can log
    // any `from`), and a stranger can put wei and dust in one transaction: only transaction signers count.
    const payer = senderOf(p.txHash);
    const byPayer = (hash: string): boolean => hash === p.txHash || (payer !== undefined && senderOf(hash) === payer);
    const payerEth = eth.filter((e) => byPayer(e.hash));
    const bound = allTokens.filter(
      (t) =>
        t.hash === p.txHash ||
        payerEth.some((e) => e.hash === t.hash) ||
        (p.asset === 'TOKEN' && p.token !== null && t.token === p.token) ||
        (namesNoToken && byPayer(t.hash)),
    );
    // A token bound only by its name can also come from a stranger (the same token, any amount): when the payer
    // signed a transfer of it, only those count (bug bounty 4 Nov, P4c).
    const signedBound = payer === undefined ? [] : bound.filter((t) => byPayer(t.hash) || payerEth.some((e) => e.hash === t.hash));
    // Bound by its name only, not signed by the payer (a relayer moved it, or a stranger sent it): when the token's own
    // log names the payer as its sender (a permit or transferWithAuthorization relay), only those (bug bounty 8 Nov:
    // a stranger's dust of the same token became a second payment). The log narrows here, it never binds.
    const nameBound = bound.some((t) => payer !== undefined && t.from === payer) ? bound.filter((t) => t.from === payer) : bound;
    const namesToken = p.asset === 'TOKEN' && p.token !== null;
    let tokens: TransferLite[];
    if (signedBound.length > 0) tokens = signedBound;
    // a relayed transfer of the named token whose log names the payer (a permit or transferWithAuthorization relay) is
    // the payer's payment, and the payer's ETH next to it is its gas (bug bounty 9 Nov: that ETH took the payment over
    // and the token was dropped as dust). A stranger's transfer of the same token names the stranger, not the payer.
    else if (payer !== undefined && bound.some((t) => t.from === payer)) tokens = nameBound;
    // the payer's own ETH, not yet another announcement's payment, beats a token bound only by its name (bug bounty
    // 8 Nov: one unit of the named token from anyone took over a payment the payer made in ETH)
    else if (payer !== undefined && payerEth.some((e) => !claimed(e, p.stealth))) tokens = [];
    else if (bound.length > 0) tokens = nameBound;
    else if (payer === undefined ? eth.length > 0 : payerEth.length > 0) tokens = []; // unknown payer: any ETH, as before 6 Nov
    else if (namesToken && payer !== undefined && eth.every((e) => senderOf(e.hash) !== undefined)) {
      // The announcement names a token that never arrived and its payer sent nothing (every ETH signer known, none the
    // payer's; an unknown ETH signer falls through to the rule below, bug bounty 8 Nov): another token or a stranger's
      // ETH next to it is not this payment (bug bounty 3 and 4 Nov, P4b). Left out as unfunded.
      if (allTokens.length > 0) tokenDust++;
      unfunded++;
      continue;
    } else tokens = allTokens; // the payer sent no ETH: the tokens are what was paid
    if (tokens.length < allTokens.length) tokenDust++;
    const asset = tokens.length > 0 ? 'TOKEN' : eth.length > 0 ? 'ETH' : null;
    if (asset === null) {
      unfunded++;
      continue;
    }
    const picked = asset === 'TOKEN' ? tokens : eth;
    if (!fundedAt.has(p.stealth)) fundedAt.set(p.stealth, { block: p.blockNumber, payer });
    const out: PaymentLog[] = [];
    byIndex.set(i, out);
    const claimedOther =
      p.asset !== 'UNKNOWN' && (p.asset !== asset || (asset === 'TOKEN' && p.token !== null && !picked.some((t) => t.token === p.token)));
    if (claimedOther) assetMismatch++;
    for (const t of picked) {
      const key = `${t.hash}|${p.stealth}|${t.token ?? 'eth'}`; // one transaction can pay several stealth addresses (N06)
      if (seen.has(key)) continue; // two announcements for one transfer: one payment
      seen.add(key);
      out.push({
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
  for (let i = 0; i < logs.length; i++) payments.push(...(byIndex.get(i) ?? []));
  return { payments, unfunded, assetMismatch, tokenDust };
}
