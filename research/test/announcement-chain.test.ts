/**
 * ERC-5564 payments come from the chain, not from the announcement (bug bounty, 24 Oct, two reports, one cause).
 * A zero-value announcement must not count as a payment, and a stranger's "ETH" announcement must not turn a
 * token-paid address into an ETH payment and hide its H2 or H5 link. Also: the ERC-1155 batch selector (28 Oct).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UNIQUE_FEE_MAX } from '../lib/config.ts';
import { confirmPayments, WINDOW_AFTER, WINDOW_BEFORE, WINDOW_BEFORE_FIRST } from '../lib/confirm.ts';
import type { TransferLite } from '../lib/data.ts';
import { parseMetadata, type PaymentLog } from '../lib/decode.ts';
import { analyze, type Dataset, type Funding, type Payment, type Registration, type Withdrawal } from '../lib/heuristics.ts';
import { a, h } from './fixture.ts';

const C = 1_000_000; // cutoff block; everything below happens after it
const opts = { uniqueFeeMax: UNIQUE_FEE_MAX, cutoffBlock: C };

const P = a(0xa001); // the payer
const X = a(0xbad1); // a stranger
const R = a(0x1e9); // a registrant
const D1 = a(0xd001);
const TA = a(0x7a7a);
const S = (i: number): string => a(0x5000 + i);

const ann = (stealth: string, asset: PaymentLog['asset'], token: string | null, tx: number, block = C + 1_000): PaymentLog => ({
  source: 'erc5564',
  txHash: h(tx),
  blockNumber: block,
  logIndex: 0,
  blockTimestamp: 1_700_000_000 + block * 12,
  stealth,
  asset,
  token,
});
const arrive = (to: string, tx: number, block: number, token: string | null, from = P): TransferLite => ({
  hash: h(tx),
  block,
  from,
  to,
  category: token === null ? 'external' : 'erc20',
  token,
});
const out = (stealth: string, to: string, kind: Withdrawal['kind'], token: string | null, tx: number, block = C + 2_000): Withdrawal => ({
  stealth,
  txHash: h(tx),
  block,
  to,
  kind,
  token,
  txFrom: stealth,
  txType: 2,
  priorityFee: '1000000000',
});

/** What scan.ts does after confirmation: the payer is the sender of the transaction that moved the value. */
function toPayments(logs: readonly PaymentLog[], senderOf: Record<string, string>): Payment[] {
  return logs.map((p) => ({
    source: p.source,
    stealth: p.stealth,
    sender: senderOf[p.txHash] ?? '',
    block: p.blockNumber,
    timestamp: p.blockTimestamp ?? 0,
    asset: p.asset,
    token: p.token,
    txHash: p.txHash,
  }));
}
const world = (payments: Payment[], withdrawals: Withdrawal[], fundings: Funding[] = [], registrations: Registration[] = []): Dataset => ({
  payments,
  withdrawals,
  fundings,
  registrations,
  contracts: new Set(),
  delegated: new Set(),
  preUsed: new Set(),
});
const byStealth = (transfers: TransferLite[]) => (s: string) => transfers.filter((t) => t.to === s);

test('Fenzy 28 Oct: safeBatchTransferFrom (0x2eb2c2d6) in metadata is a token payment, not unknown', () => {
  const token = a(0x1155);
  const r = parseMetadata('0x99' + '2eb2c2d6' + token.slice(2) + '00'.repeat(32));
  assert.deepEqual(r, { asset: 'TOKEN', token });
  // control: an unlisted selector stays unknown
  assert.equal(parseMetadata('0x99' + 'deadbeef' + token.slice(2)).asset, 'UNKNOWN');
});

test('an announcement with nothing arriving next to it is not a payment', () => {
  const r = confirmPayments([ann(S(1), 'ETH', null, 1)], () => []);
  assert.deepEqual(r.payments, []);
  assert.equal(r.unfunded, 1);
  // so the address is not counted at all, even after a withdrawal from it
  const m = analyze(world(toPayments(r.payments, {}), [out(S(1), D1, 'eth', null, 101)]), opts).all;
  assert.equal(m.stealthAddresses, 0);
  assert.equal(m.withdrawn, 0);
});

test("Swaplane / One Cursor 24 Oct: a stranger's ETH announcement does not hide the token payment's H2", () => {
  const logs = [ann(S(1), 'TOKEN', TA, 1), ann(S(1), 'ETH', null, 2, C + 1_500)];
  const transfers = [arrive(S(1), 1, C + 1_000, TA)];
  const senders = { [h(1)]: P, [h(2)]: X };
  const withdrawals = [out(S(1), P, 'token', TA, 101)];

  // before: the announcement alone decided, so the address looked ETH-paid and the token back to the payer vanished
  const before = analyze(world(toPayments(logs, senders), withdrawals), opts).all;
  assert.equal(before.withdrawn, 0);
  assert.equal(before.h2Any, 0);

  const r = confirmPayments(logs, byStealth(transfers));
  assert.equal(r.unfunded, 1, 'the ETH claim moved nothing');
  assert.deepEqual(r.payments.map((p) => [p.asset, p.token]), [['TOKEN', TA]]);
  const after = analyze(world(toPayments(r.payments, senders), withdrawals), opts).all;
  assert.equal(after.withdrawn, 1);
  assert.equal(after.singleWithdrawal, 1);
  assert.equal(after.h2Single, 1, 'the isolated H2 stays 1');
  assert.equal(after.h2Any, 1);
  assert.equal(after.identityLinked, 1);
});

test("a stranger's ETH announcement does not hide H5 either (token-only address, gas from a registrant)", () => {
  const logs = [ann(S(2), 'TOKEN', TA, 3), ann(S(2), 'ETH', null, 4, C + 1_200)];
  const transfers = [arrive(S(2), 3, C + 1_000, TA)];
  const senders = { [h(3)]: P, [h(4)]: X };
  const fundings = [{ stealth: S(2), txHash: h(203), block: C + 1_500, from: R }];
  const registrations = [{ registrant: R, block: C + 10, registry: 'erc6538' as const }];
  const withdrawals = [out(S(2), D1, 'token', TA, 102)];

  const before = analyze(world(toPayments(logs, senders), withdrawals, fundings, registrations), opts).all;
  assert.equal(before.h5, 0);
  const r = confirmPayments(logs, byStealth(transfers));
  const after = analyze(world(toPayments(r.payments, senders), withdrawals, fundings, registrations), opts).all;
  assert.equal(after.needingOwnGas, 1);
  assert.equal(after.h5, 1);
  assert.equal(after.identityLinked, 1);
});

test('the asset is what arrived: ETH sent with a token is gas, a wrong metadata claim is counted', () => {
  const tip = arrive(S(3), 5, C + 1_000, null);
  const tok = arrive(S(3), 5, C + 1_000, TA);
  const r = confirmPayments([ann(S(3), 'ETH', null, 5)], byStealth([tip, tok]));
  assert.deepEqual(r.payments.map((p) => [p.asset, p.token, p.txHash]), [['TOKEN', TA, h(5)]]);
  assert.equal(r.assetMismatch, 1);
  // unknown metadata (short or unlisted selector) is no mismatch: the chain names the asset
  const u = confirmPayments([ann(S(3), 'UNKNOWN', null, 5)], byStealth([tok]));
  assert.equal(u.assetMismatch, 0);
  assert.equal(u.payments[0]?.asset, 'TOKEN');
});

test('the payment transaction is the one that moved the value, inside the window around the announcement', () => {
  const at = C + 10_000;
  // first announcement of the address: paid up to a day before it (payers often send first), or 12 blocks after
  for (const b of [at - WINDOW_BEFORE_FIRST, at - 6, at, at + WINDOW_AFTER]) {
    const r = confirmPayments([ann(S(4), 'ETH', null, 6, at)], byStealth([arrive(S(4), 7, b, null)]));
    assert.equal(r.payments.length, 1, `block ${b - at}`);
    assert.equal(r.payments[0]?.txHash, h(7));
    assert.equal(r.payments[0]?.blockNumber, b);
  }
  for (const b of [at - WINDOW_BEFORE_FIRST - 1, at + WINDOW_AFTER + 1]) {
    const r = confirmPayments([ann(S(4), 'ETH', null, 6, at)], byStealth([arrive(S(4), 7, b, null)]));
    assert.equal(r.unfunded, 1, `block ${b - at}`);
  }
  // a later announcement of the same address only looks 2 blocks back: gas sent after the first payment is not a new payment
  const first = ann(S(4), 'TOKEN', TA, 6, at);
  const later = ann(S(4), 'ETH', null, 8, at + 500);
  const paid = arrive(S(4), 6, at, TA);
  for (const b of [at + 500 - WINDOW_BEFORE, at + 500 + WINDOW_AFTER]) {
    const r = confirmPayments([first, later], byStealth([paid, arrive(S(4), 9, b, null)]));
    assert.deepEqual(r.payments.map((p) => p.asset), ['TOKEN', 'ETH'], `block ${b - at - 500}`);
  }
  const gas = confirmPayments([first, later], byStealth([paid, arrive(S(4), 9, at + 500 - WINDOW_BEFORE - 1, null)]));
  assert.deepEqual(gas.payments.map((p) => p.asset), ['TOKEN']);
  assert.equal(gas.unfunded, 1);
  // the address sending to itself is not a payment; two announcements for one transfer are one payment
  assert.equal(confirmPayments([ann(S(4), 'ETH', null, 6, at)], byStealth([arrive(S(4), 7, at, null, S(4))])).unfunded, 1);
  const twice = confirmPayments([ann(S(4), 'ETH', null, 6, at), ann(S(4), 'ETH', null, 8, at + 1)], byStealth([arrive(S(4), 7, at, null)]));
  assert.equal(twice.payments.length, 1);
});

test('Umbra announcements pass through unchanged: the Umbra contract moves the funds itself', () => {
  const u: PaymentLog = { ...ann(S(5), 'ETH', null, 9), source: 'umbra' };
  const r = confirmPayments([u], () => []);
  assert.deepEqual(r.payments, [u]);
  assert.equal(r.unfunded, 0);
});

test('N14 (Rusdi, 3 Nov, Low): token dust from a stranger in the 12 blocks after the announcement does not turn a real ETH payment into a token payment', () => {
  const at = C + 20_000;
  const eth = arrive(S(6), 20, at + 1, null);
  const dust = arrive(S(6), 21, at + 5, TA, X);
  const r = confirmPayments([ann(S(6), 'ETH', null, 19, at)], byStealth([eth, dust]));
  assert.deepEqual(r.payments.map((p) => [p.asset, p.token, p.txHash]), [['ETH', null, h(20)]]);
  assert.equal(r.tokenDust, 1);
  assert.equal(r.assetMismatch, 0);
  // the token is the payment when another announcement of the address claims it (a real token payment next to an ETH claim)
  const claimed = confirmPayments([ann(S(6), 'ETH', null, 19, at), ann(S(6), 'TOKEN', TA, 22, at + 2)], byStealth([eth, dust]));
  assert.ok(claimed.payments.some((p) => p.asset === 'TOKEN' && p.token === TA));
  // the token arrives in the same transaction as the ETH: a gas tip, so the token is the payment (as before)
  const tip = confirmPayments([ann(S(6), 'ETH', null, 19, at)], byStealth([arrive(S(6), 23, at + 1, null), arrive(S(6), 23, at + 1, TA)]));
  assert.deepEqual(tip.payments.map((p) => p.asset), ['TOKEN']);
  // without ETH the token still decides (the stranger's ETH claim for a token-paid address, tested above)
  assert.equal(confirmPayments([ann(S(6), 'ETH', null, 19, at)], byStealth([dust])).payments[0]?.asset, 'TOKEN');
});

test('N06 (Swaplane EPH-10, 3 Nov, Low): one transaction that pays two stealth addresses is two payments, not one', () => {
  const at = C + 30_000;
  const logs = [ann(S(7), 'ETH', null, 30, at), ann(S(8), 'ETH', null, 31, at)];
  const batch = [arrive(S(7), 32, at + 1, null), arrive(S(8), 32, at + 1, null)]; // one tx, two recipients
  const r = confirmPayments(logs, byStealth(batch));
  assert.deepEqual(r.payments.map((p) => p.stealth).sort(), [S(7), S(8)].sort());
  // the same for a token batch
  const tokens = confirmPayments([ann(S(7), 'TOKEN', TA, 30, at), ann(S(8), 'TOKEN', TA, 31, at)], byStealth([arrive(S(7), 33, at, TA), arrive(S(8), 33, at, TA)]));
  assert.equal(tokens.payments.length, 2);
  // two announcements for one transfer to the SAME address are still one payment
  const twice = confirmPayments([ann(S(7), 'ETH', null, 30, at), ann(S(7), 'ETH', null, 34, at + 1)], byStealth([batch[0]!]));
  assert.equal(twice.payments.length, 1);
});

// Bug bounty 4 and 5 Nov (Rusdi, Van Z, Ox Radu): the N14 fix trusted any other announcement of the address that
// claimed a token, a token-free selector claimed every token, and announcements that did not claim ETH had no dust
// rule at all. A token is now bound to the announcement being confirmed, or it is dust.
const TB = a(0x7b7b); // a stranger's token
const X2 = a(0xbad2);

test('N14 bypass (Rusdi 4 Nov): a stranger announcing a token claim for the address does not flip the real ETH payment', () => {
  const at = C + 40_000;
  const eth = arrive(S(9), 40, at + 1, null);
  const dust = arrive(S(9), 41, at + 3, TB, X);
  for (const claim of [ann(S(9), 'TOKEN', TB, 42, at + 4), ann(S(9), 'TOKEN', null, 42, at + 4)]) {
    const r = confirmPayments([ann(S(9), 'ETH', null, 39, at), claim], byStealth([eth, dust]));
    const real = r.payments.filter((p) => p.txHash === h(40));
    assert.deepEqual(real.map((p) => [p.asset, p.token]), [['ETH', null]], 'the real payment stays ETH');
    // the griefer's own announcement confirms only its own dust, when it names that token
    const griefer = r.payments.filter((p) => p.txHash === h(41));
    assert.ok(griefer.length <= 1);
  }
});

test('Ox Radu 5 Nov: short or token-free metadata cannot be flipped by dust either, before or after the announcement', () => {
  const at = C + 50_000;
  const eth = arrive(S(10), 50, at + 1, null, P);
  const after = arrive(S(10), 51, at + 5, TB, X); // dust after the announcement
  const before = arrive(S(10), 52, at - 3_000, TB, X2); // dust inside the 7,200 blocks before a first announcement (PoC E)
  for (const asset of ['UNKNOWN', 'TOKEN'] as const) {
    const r = confirmPayments([ann(S(10), asset, null, 49, at)], byStealth([eth, after, before]));
    assert.deepEqual(r.payments.map((p) => [p.asset, p.txHash]), [['ETH', h(50)]], asset);
    assert.equal(r.tokenDust, 1, asset);
  }
  // a griefer front-running with his own claim naming his token and his own dust: two payments, the real one stays ETH
  const g = confirmPayments([ann(S(10), 'TOKEN', TB, 53, at), ann(S(10), 'UNKNOWN', null, 49, at)], byStealth([eth, after]));
  assert.deepEqual(g.payments.filter((p) => p.txHash === h(50)).map((p) => p.asset), ['ETH']);
});

test('Rusdi 4 Nov (2): a token claim confirms only the named token; a different token from a stranger is dust, not a payer row', () => {
  const at = C + 60_000;
  const real = arrive(S(11), 60, at + 1, TA, P);
  const dust = arrive(S(11), 61, at + 2, TB, X);
  const r = confirmPayments([ann(S(11), 'TOKEN', TA, 59, at)], byStealth([real, dust]));
  assert.deepEqual(r.payments.map((p) => [p.asset, p.token, p.txHash]), [['TOKEN', TA, h(60)]]);
  assert.equal(r.tokenDust, 1);
  // so the stranger never joins the H2 payer set
  const m = analyze(world(toPayments(r.payments, { [h(60)]: P, [h(61)]: X }), [out(S(11), X, 'token', TA, 160, at + 100)]), opts).all;
  assert.equal(m.h2Any, 0);
});

test('a token payment with short metadata and gas ETH from the same payer is still a token payment', () => {
  const at = C + 70_000;
  const token = arrive(S(12), 70, at + 1, TA, P);
  const gas = arrive(S(12), 71, at + 2, null, P);
  const r = confirmPayments([ann(S(12), 'UNKNOWN', null, 69, at)], byStealth([token, gas]));
  assert.deepEqual(r.payments.map((p) => [p.asset, p.token]), [['TOKEN', TA]]);
  assert.equal(r.tokenDust, 0);
});

test('Ox Radu 5 Nov end to end: the griefed world gives the same withdrawn and H2 as the clean one', () => {
  const at = C + 80_000;
  const eth = arrive(S(13), 80, at + 1, null, P);
  const dust = arrive(S(13), 81, at + 2, TB, X);
  const w = [out(S(13), P, 'eth', null, 180, at + 100)];
  const senders = { [h(80)]: P, [h(81)]: X };
  const clean = confirmPayments([ann(S(13), 'UNKNOWN', null, 79, at)], byStealth([eth]));
  const griefed = confirmPayments([ann(S(13), 'TOKEN', TB, 82, at), ann(S(13), 'UNKNOWN', null, 79, at)], byStealth([eth, dust]));
  const mc = analyze(world(toPayments(clean.payments, senders), w), opts).all;
  const mg = analyze(world(toPayments(griefed.payments, senders), w), opts).all;
  assert.equal(mc.withdrawn, 1);
  assert.equal(mc.h2Single, 1);
  assert.equal(mg.withdrawn, mc.withdrawn);
  assert.equal(mg.h2Single, mc.h2Single);
  assert.equal(mg.paperPct, mc.paperPct);
});

test('Adams 4 Nov (F-07): an announcement under another scheme id is not a payment', async () => {
  const { decodeLogs } = await import('../lib/decode.ts');
  const { EVENTS } = await import('../lib/config.ts');
  const { encodeEventTopics, encodeAbiParameters } = await import('viem');
  const announcer = a(0x5564);
  const log = (scheme: bigint) => ({
    address: announcer,
    topics: encodeEventTopics({ abi: [EVENTS.erc5564Announcement], eventName: 'Announcement', args: { schemeId: scheme, stealthAddress: S(14) as `0x${string}`, caller: X as `0x${string}` } }),
    data: encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes' }], [`0x02${'11'.repeat(32)}`, '0x99eeeeeeee']),
    transactionHash: h(90),
    blockNumber: '0x10',
    logIndex: '0x0',
  });
  const addrs = { umbra: a(1), umbraRegistry: a(2), announcer, registry6538: a(3) };
  const one = decodeLogs([log(1n)] as never, addrs);
  assert.equal(one.payments.length, 1);
  const other = decodeLogs([log(99n), log(0n)] as never, addrs);
  assert.equal(other.payments.length, 0);
  assert.equal(other.otherScheme, 2);
});
