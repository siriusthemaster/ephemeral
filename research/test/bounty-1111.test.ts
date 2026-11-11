/**
 * Bug bounty, 9 to 11 Nov (scanner). Each test names the report it covers.
 * (1) A relayed move counts as the owner's only for a known token (relay tokens): a stranger's own token paid in as
 *     the first payment, in its block or before it, no longer makes a fabricated Transfer an owner withdrawal.
 * (2) A permit-relayed payment of the named token is the payment also when the payer's gas ETH arrives separately.
 * (3) What landed unclaimed inside a funded announcement's own window stays in reach of a later announcement.
 * (4) The cache key covers the arrivals range, and the scan version is bumped.
 * (5) A recipient or funder that gained code after its first event is not a foreign contract for H3 and H5.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmPayments, neededTxs, WINDOW_BEFORE_FIRST } from '../lib/confirm.ts';
import { atBlockKey, splitCodeKinds, type CodeKind, type TransferLite } from '../lib/data.ts';
import type { PaymentLog } from '../lib/decode.ts';
import { analyze, type Dataset, type Payment, type Withdrawal } from '../lib/heuristics.ts';
import { CHAINS, SCAN_VERSION, UNIQUE_FEE_MAX } from '../lib/config.ts';
import { cacheParams } from '../scan.ts';
import { a, h, CUTOFF_BLOCK as C } from './fixture.ts';

const S = a(0x5001);
const P = a(0xa001);
const STRANGER = a(0xbad1);
const RELAYER = a(0x1e1);
const R = a(0x101); // a registrant
const TA = a(0x7a7a); // stands for a known token (USDC, ...)
const FAKE = a(0xbad); // the stranger's own token contract

// ------------------------------------------------------------------ (1) owned withdrawals (heuristics.ts)
const opts = { uniqueFeeMax: UNIQUE_FEE_MAX, cutoffBlock: C, relayTokens: new Set([TA]) };
const pay = (token: string | null, tx: number, block: number, sender = P): Payment => ({
  source: 'erc5564', stealth: S, sender, block, timestamp: 0, asset: token === null ? 'ETH' : 'TOKEN', token, txHash: h(tx),
});
const move = (token: string, to: string, tx: number, block: number, txFrom: string): Withdrawal => ({
  stealth: S, txHash: h(tx), block, to, kind: 'token', token, txFrom, txType: 2, priorityFee: null,
});
const world = (payments: Payment[], withdrawals: Withdrawal[]): Dataset => ({
  payments, withdrawals, fundings: [],
  registrations: [{ registrant: R, block: C - 100, registry: 'erc6538' }],
  contracts: new Set(), delegated: new Set(), preUsed: new Set(),
});

test('accpoww 9 Nov (first), cx 10 Nov: a stranger s token paid as the first payment does not make a fabricated Transfer an owner move', () => {
  const B = C + 1_000;
  const forged = (to: string) => move(FAKE, to, 9, B + 100, STRANGER);
  const cases: [string, Payment[], string][] = [
    ['dust ahead of the payment, move to a registrant', [pay(FAKE, 1, B - 1, STRANGER), pay(null, 2, B)], R],
    ['dust ahead of the payment, move to the payer', [pay(FAKE, 1, B - 1, STRANGER), pay(null, 2, B)], P],
    ['dust in the payment block, move to the stranger', [pay(FAKE, 1, B, STRANGER), pay(null, 2, B)], STRANGER],
    ['dust only, move to a registrant', [pay(FAKE, 1, B, STRANGER)], R],
    ['dust after the payment (8 Nov)', [pay(null, 2, B), pay(FAKE, 1, B + 1, STRANGER)], R],
  ];
  for (const [label, payments, to] of cases) {
    const m = analyze(world(payments, [forged(to)]), opts).all;
    assert.deepEqual([m.withdrawn, m.h1Single, m.h2Single, m.h1Any, m.h2Any, m.paperLinked], [0, 0, 0, 0, 0, 0], label);
  }
});

test('cx 10 Nov: first-block dust and a forged move no longer delete a real H1 link', () => {
  const B = C + 1_000;
  const real: Withdrawal = { stealth: S, txHash: h(5), block: B + 50, to: R, kind: 'eth', token: null, txFrom: S, txType: 2, priorityFee: null };
  const honest = analyze(world([pay(null, 2, B)], [real]), opts).all;
  const attacked = analyze(world([pay(FAKE, 1, B, STRANGER), pay(null, 2, B)], [real, move(FAKE, a(0xe5e5), 9, B + 60, STRANGER)]), opts).all;
  assert.deepEqual([attacked.withdrawn, attacked.singleWithdrawal, attacked.h1Single, attacked.paperLinked], [1, 1, 1, 1]);
  assert.equal(attacked.paperLinked, honest.paperLinked);
});

test('control: a relayed move of a known token is the owner s, whenever that token was paid in', () => {
  const B = C + 1_000;
  for (const payments of [[pay(TA, 1, B)], [pay(null, 2, B), pay(TA, 1, B + 30, a(0xa002))]]) {
    const m = analyze(world(payments, [move(TA, R, 9, B + 100, RELAYER)]), opts).all;
    assert.equal(m.h1Any, 1);
  }
  // and without the relay list nothing relayed counts
  assert.equal(analyze(world([pay(TA, 1, B)], [move(TA, R, 9, B + 100, RELAYER)]), { uniqueFeeMax: UNIQUE_FEE_MAX, cutoffBlock: C }).all.withdrawn, 0);
});

// ------------------------------------------------------------------ (2) and (3) payments (confirm.ts)
const ann = (asset: PaymentLog['asset'], token: string | null, tx: number, block: number): PaymentLog => ({
  source: 'erc5564', txHash: h(tx), blockNumber: block, logIndex: 0, stealth: S, asset, token,
});
const arrive = (tx: number, token: string | null, block: number, from = P): TransferLite =>
  ({ hash: h(tx), from, to: S, block, token, category: token === null ? 'external' : 'erc20' }) as TransferLite;
/** senderOf limited to what a production run fetches: neededTxs only */
function prod(logs: PaymentLog[], arrived: TransferLite[], signers: Record<string, string>) {
  const fetched = new Set(neededTxs(logs, () => arrived));
  return confirmPayments(logs, () => arrived, (x) => (fetched.has(x) ? signers[x] : undefined));
}
const rows = (r: ReturnType<typeof prod>) => r.payments.map((p) => [p.asset, p.token, p.txHash]);

test('accpoww 9 Nov: a permit-relayed token payment with the payer s gas ETH in another transaction is the token payment', () => {
  const r = prod([ann('TOKEN', TA, 2, 1_000)], [arrive(5, null, 1_001, P), arrive(6, TA, 1_002, P)], { [h(2)]: P, [h(5)]: P, [h(6)]: RELAYER });
  assert.deepEqual(rows(r), [['TOKEN', TA, h(6)]]);
  assert.equal(r.tokenDust, 0);
  // with a stranger's dust of the same token next to it: the relayed transfer stays the payment, the dust is dust
  const d = prod(
    [ann('TOKEN', TA, 2, 1_000)],
    [arrive(5, null, 1_001, P), arrive(6, TA, 1_002, P), arrive(7, TA, 1_003, STRANGER)],
    { [h(2)]: P, [h(5)]: P, [h(6)]: RELAYER, [h(7)]: STRANGER },
  );
  assert.deepEqual(rows(d), [['TOKEN', TA, h(6)]]);
  assert.equal(d.tokenDust, 1);
});

test('control (Makino 8 Nov): a stranger s unit of the named token still loses to the payer s ETH', () => {
  const r = prod([ann('TOKEN', TA, 2, 1_000)], [arrive(5, null, 1_001, P), arrive(7, TA, 1_003, STRANGER)], { [h(2)]: P, [h(5)]: P, [h(7)]: STRANGER });
  assert.deepEqual(rows(r), [['ETH', null, h(5)]]);
});

test('Akbar (sarungt656) 9 Nov: a token landing inside a stranger s funded announcement window stays a payment', () => {
  // the stranger announces at 1999 and funds it with 1 wei in the same transaction; the payer's token lands at `at`
  const shapes: [number, number][] = [
    [2_000, 2_010],
    [1_999, 2_010], // in the funded announcement's own block
    [2_011, 2_020], // the last block of its window
  ];
  for (const [at, payerAnn] of shapes) {
    const r = prod(
      [ann('ETH', null, 2, 1_999), ann('TOKEN', TA, 3, payerAnn)],
      [arrive(2, null, 1_999, STRANGER), arrive(1, TA, at, P)],
      { [h(1)]: P, [h(2)]: STRANGER, [h(3)]: P },
    );
    assert.ok(rows(r).some(([asset, token, tx]) => asset === 'TOKEN' && token === TA && tx === h(1)), `token at ${at}`);
  }
  // the payer's own gas next to its own funded announcement stays out of a later announcement (unchanged)
  const own = prod(
    [ann('TOKEN', TA, 3, 2_000), ann('TOKEN', TA, 4, 2_100)],
    [arrive(1, TA, 2_000, P), arrive(5, null, 2_005, P)],
    { [h(1)]: P, [h(3)]: P, [h(4)]: P, [h(5)]: P },
  );
  assert.deepEqual(rows(own), [['TOKEN', TA, h(1)]]);
});

// ------------------------------------------------------------------ (4) cache key
test('accpoww 9 Nov: the cache key covers the arrivals range and the scan version moved on', () => {
  assert.ok(SCAN_VERSION >= 7, 'a cache from version 6 kept the arrivals range from before the 8 Nov fix');
  assert.notEqual(cacheParams(CHAINS.mainnet), cacheParams(CHAINS.mainnet, 0));
  assert.equal(cacheParams(CHAINS.mainnet), cacheParams(CHAINS.mainnet, WINDOW_BEFORE_FIRST));
});

// ------------------------------------------------------------------ (5) code at the first event
test('accpoww 9 Nov: a counterfactual wallet that gained code after the withdrawals is no foreign contract', () => {
  const UMBRA = CHAINS.mainnet.umbra;
  const D1 = a(0xd01);
  const F = a(0xf01);
  const now: [string, CodeKind][] = [[UMBRA, 'contract'], [D1, 'contract'], [F, 'contract'], [a(0x7702), 'delegated']];
  const firstEvent = new Map([[UMBRA, 100], [D1, 200], [F, 300]]);
  const then = new Map<string, CodeKind>([[atBlockKey(UMBRA, 100), 'contract'], [atBlockKey(D1, 200), 'eoa']]);
  const { contracts, delegated } = splitCodeKinds(now, firstEvent, (k) => then.get(k));
  assert.ok(contracts.has(UMBRA), 'a contract at its first event stays excluded');
  assert.ok(!contracts.has(D1), 'deployed after its first event: a wallet, counted');
  assert.ok(contracts.has(F), 'no reading for the old block: stays a contract, as before');
  assert.deepEqual([...delegated], [a(0x7702)]);

  // H3: two Umbra token payments withdrawn to D1 cluster when D1 is not a contract
  const S3 = a(0x5003), S4 = a(0x5004), T0 = a(0x7070);
  const ds = (contractsSet: Set<string>): Dataset => ({
    payments: [
      { source: 'umbra', stealth: S3, sender: a(0xa003), block: C + 100, timestamp: 0, asset: 'TOKEN', token: T0, txHash: h(3) },
      { source: 'umbra', stealth: S4, sender: a(0xa004), block: C + 200, timestamp: 0, asset: 'TOKEN', token: T0, txHash: h(4) },
    ],
    withdrawals: [
      { stealth: S3, txHash: h(103), block: C + 500, to: D1, kind: 'umbra-token', token: T0, txFrom: RELAYER, txType: 2, priorityFee: '2' },
      { stealth: S4, txHash: h(104), block: C + 500, to: D1, kind: 'umbra-token', token: T0, txFrom: RELAYER, txType: 2, priorityFee: '2' },
    ],
    fundings: [], registrations: [], contracts: contractsSet, delegated: new Set(), preUsed: new Set(),
  });
  assert.equal(analyze(ds(contracts), opts).h3.clusters, 1);
  assert.equal(analyze(ds(new Set([UMBRA, D1])), opts).h3.clusters, 0, 'control: a contract recipient is left out');
});
