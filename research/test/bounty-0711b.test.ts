/**
 * Bug bounty, scanner reports of 3 and 4 Nov (fixed 7 Nov): an asset moved before its own payment, a self-transfer,
 * the H2-any rule for Umbra tokens, ETH arriving inside the address's own transaction, H3 sinks, zero-amount Umbra
 * announcements, a malformed log envelope, and a token named by an announcement that never arrived or came from a
 * stranger.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encodeAbiParameters, type Hex } from 'viem';
import { TOPICS, UNIQUE_FEE_MAX } from '../lib/config.ts';
import { confirmPayments } from '../lib/confirm.ts';
import type { TransferLite } from '../lib/data.ts';
import { decodeLogs, type PaymentLog } from '../lib/decode.ts';
import { analyze, type Dataset, type Funding, type Payment, type Withdrawal } from '../lib/heuristics.ts';
import type { RawLog } from '../lib/logs.ts';
import { a, h } from './fixture.ts';

const C = 1_000_000;
const opts = { uniqueFeeMax: UNIQUE_FEE_MAX, cutoffBlock: C };
const P = a(0xa001); // payer
const R = a(0xa002); // registrant
const D = a(0xd001); // a fresh destination
const TA = a(0x7a7a);
const TB = a(0x7b7b);
const S = a(0x5001);
const S2 = a(0x5002);
const STRANGER = a(0xbad1);

const pay = (stealth: string, asset: Payment['asset'], token: string | null, block: number, tx: number, source: Payment['source'] = 'erc5564', sender = P): Payment => ({
  source,
  stealth,
  sender,
  block,
  timestamp: 1_700_000_000 + block * 12,
  asset,
  token,
  txHash: h(tx),
});
const out = (stealth: string, kind: Withdrawal['kind'], token: string | null, to: string, tx: number, block: number, txFrom = stealth): Withdrawal => ({
  stealth,
  txHash: h(tx),
  block,
  to,
  kind,
  token,
  txFrom,
  txType: 2,
  priorityFee: '1000000000',
});
const world = (payments: Payment[], withdrawals: Withdrawal[], fundings: Funding[] = []): Dataset => ({
  payments,
  withdrawals,
  fundings,
  registrations: [{ registrant: R, block: 1, registry: 'erc6538' }],
  contracts: new Set(),
  delegated: new Set(),
  preUsed: new Set(),
});

test('an asset relayed out before its own payment arrived is not that payment leaving', () => {
  // TA paid at C+10 and never moves; TB relayed out at C+20, before TB's own payment at C+30
  const ds = world(
    [pay(S, 'TOKEN', TA, C + 10, 1), pay(S, 'TOKEN', TB, C + 30, 2)],
    [out(S, 'token', TB, P, 3, C + 20, a(0x6001))],
  );
  assert.equal(analyze(ds, opts).all.withdrawn, 0);
  // control: the same move after TB's payment is its withdrawal, and a round trip to the payer
  const after = world([pay(S, 'TOKEN', TA, C + 10, 1), pay(S, 'TOKEN', TB, C + 30, 2)], [out(S, 'token', TB, P, 3, C + 40, a(0x6001))]);
  const m = analyze(after, opts).all;
  assert.equal(m.withdrawn, 1);
  assert.equal(m.h2Single, 1);
});

test('a transfer to itself is no withdrawal and no round trip, even for a self-funded address', () => {
  const ds = world([pay(S, 'ETH', null, C + 10, 1, 'erc5564', S)], [out(S, 'eth', null, S, 2, C + 20)]);
  const m = analyze(ds, opts).all;
  assert.equal(m.withdrawn, 0);
  assert.equal(m.h2Any, 0);
  // control: the same address sending to the payer is a withdrawal
  assert.equal(analyze(world([pay(S, 'ETH', null, C + 10, 1)], [out(S, 'eth', null, P, 2, C + 20)]), opts).all.withdrawn, 1);
});

test('H2-any: a direct transfer of an Umbra-paid token to the payer is no round trip (same rule as single)', () => {
  const ds = world(
    [pay(S, 'TOKEN', TA, C + 10, 1, 'umbra')],
    [out(S, 'umbra-token', TA, D, 2, C + 20, a(0x6001)), out(S, 'token', TA, P, 3, C + 30)],
  );
  const m = analyze(ds, opts).all;
  assert.equal(m.withdrawn, 1);
  assert.equal(m.h2Any, 0);
  assert.equal(m.identityLinked, 0);
  // control: an ERC-5564 token payment sent back to the payer directly is a round trip
  const direct = world([pay(S, 'TOKEN', TA, C + 10, 1)], [out(S, 'token', TA, P, 3, C + 30)]);
  assert.equal(analyze(direct, opts).all.h2Any, 1);
});

test('H5: ETH that arrives inside the address own transaction did not pay for it', () => {
  const ds = world(
    [pay(S, 'TOKEN', TA, C + 10, 1)],
    [out(S, 'token', TA, D, 5, C + 20)],
    [{ stealth: S, txHash: h(5), block: C + 20, from: R }],
  );
  assert.equal(analyze(ds, opts).all.h5, 0);
  // control: the registrant funding it a block earlier, in its own transaction, is H5
  const before = world([pay(S, 'TOKEN', TA, C + 10, 1)], [out(S, 'token', TA, D, 5, C + 20)], [{ stealth: S, txHash: h(4), block: C + 19, from: R }]);
  assert.equal(analyze(before, opts).all.h5, 1);
});

test('H3: two addresses emptied to the burn address are not a collector cluster', () => {
  const burn = '0x000000000000000000000000000000000000dead';
  const ds = world(
    [pay(S, 'ETH', null, C + 10, 1), pay(S2, 'ETH', null, C + 11, 2)],
    [out(S, 'eth', null, burn, 3, C + 20), out(S2, 'eth', null, burn, 4, C + 21)],
  );
  assert.equal(analyze(ds, opts).h3.clusters, 0);
  // control: two addresses emptied to one ordinary address are a cluster
  const ds2 = world(
    [pay(S, 'ETH', null, C + 10, 1), pay(S2, 'ETH', null, C + 11, 2)],
    [out(S, 'eth', null, D, 3, C + 20), out(S2, 'eth', null, D, 4, C + 21)],
  );
  assert.equal(analyze(ds2, opts).h3.clusters, 1);
});

const UMBRA = a(0x0b1a);
const addrs = { umbra: UMBRA, umbraRegistry: a(0x0b1b), announcer: a(0x0b1c), registry6538: a(0x0b1d) };
const pad = (x: string) => ('0x' + x.slice(2).padStart(64, '0')) as Hex;
const umbraLog = (amount: bigint, tx: number, extra: Partial<RawLog> = {}): RawLog =>
  ({
    address: UMBRA,
    topics: [TOPICS.umbraAnnouncement, pad(S), pad(TA)],
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'bytes32' }, { type: 'bytes32' }], [amount, pad('0x01'), pad('0x02')]),
    transactionHash: h(tx),
    blockNumber: '0x' + (C + tx).toString(16),
    logIndex: '0x0',
    ...extra,
  }) as RawLog;

test('an Umbra announcement of zero is not a payment', () => {
  const d = decodeLogs([umbraLog(0n, 1), umbraLog(5n, 2)], addrs);
  assert.equal(d.payments.length, 1);
  assert.equal(d.zeroAmount, 1);
});

test('one malformed log envelope is skipped, the rest still decodes', () => {
  const d = decodeLogs([umbraLog(5n, 1, { blockNumber: 'not-a-number' } as Partial<RawLog>), umbraLog(5n, 2)], addrs);
  assert.equal(d.payments.length, 1);
  assert.equal(d.skipped, 1);
});

const ann = (asset: PaymentLog['asset'], token: string | null, tx: number, block = C + 1_000): PaymentLog => ({
  source: 'erc5564',
  txHash: h(tx),
  blockNumber: block,
  logIndex: 0,
  stealth: S,
  asset,
  token,
});
const arrive = (tx: number, token: string | null, from = P, block = C + 1_000): TransferLite =>
  ({ hash: h(tx), from, to: S, block, token, category: token === null ? 'external' : 'erc20' }) as TransferLite;

test('a token named by the announcement that never arrived: a stranger token next to it is not the payment', () => {
  const signers: Record<string, string> = { [h(1)]: P, [h(2)]: STRANGER };
  const r = confirmPayments([ann('TOKEN', TA, 1)], () => [arrive(2, TB, STRANGER)], (x) => signers[x]);
  assert.equal(r.payments.length, 0);
  assert.equal(r.unfunded, 1);
  assert.equal(r.tokenDust, 1);
  // control: the named token arriving (relayed, another signer) is the payment
  const ok = confirmPayments([ann('TOKEN', TA, 1)], () => [arrive(3, TA, a(0x6001))], (x) => (x === h(1) ? P : a(0x6001)));
  assert.deepEqual(ok.payments.map((p) => [p.asset, p.token]), [['TOKEN', TA]]);
});

test('the named token from a stranger next to the payer own transfer of it is not a second payment', () => {
  const signers: Record<string, string> = { [h(1)]: P, [h(2)]: P, [h(3)]: STRANGER };
  const r = confirmPayments([ann('TOKEN', TA, 1)], () => [arrive(2, TA), arrive(3, TA, STRANGER)], (x) => signers[x]);
  assert.deepEqual(r.payments.map((p) => p.txHash), [h(2)]);
  assert.equal(r.tokenDust, 1);
});
