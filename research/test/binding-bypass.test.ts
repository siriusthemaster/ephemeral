/**
 * Bug bounty 6 Nov (Rusdi, four bypasses of the PR #9 binding): a token was bound by who "sent" it according to
 * the Transfer log (a fake token can claim any `from`), or by sharing a transaction with any ETH (a stranger's wei),
 * and any arrived ETH, from anyone, dropped unbound tokens. The payer is now the sender of the announcement's own
 * transaction, and a token or ETH counts for the binding only when its transaction was signed by that sender.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UNIQUE_FEE_MAX } from '../lib/config.ts';
import { confirmPayments, neededTxs } from '../lib/confirm.ts';
import type { TransferLite } from '../lib/data.ts';
import type { PaymentLog } from '../lib/decode.ts';
import { analyze, type Dataset, type Payment, type Withdrawal } from '../lib/heuristics.ts';
import { a, h } from './fixture.ts';

const C = 1_000_000;
const opts = { uniqueFeeMax: UNIQUE_FEE_MAX, cutoffBlock: C };
const P = a(0xa001); // the payer
const X = a(0xbad1); // a stranger
const TA = a(0x7a7a); // the real token
const TB = a(0x7b7b); // a stranger's (or fake) token
const S = (i: number): string => a(0x6000 + i);

const ann = (stealth: string, asset: PaymentLog['asset'], token: string | null, tx: number, block: number): PaymentLog => ({
  source: 'erc5564',
  txHash: h(tx),
  blockNumber: block,
  logIndex: 0,
  blockTimestamp: 1_700_000_000 + block * 12,
  stealth,
  asset,
  token,
});
/** `from` is what the log or transfer says; `signer` is who signed the transaction (what eth_getTransactionByHash says) */
const arrive = (to: string, tx: number, block: number, token: string | null, from: string): TransferLite => ({
  hash: h(tx),
  block,
  from,
  to,
  category: token === null ? 'external' : 'erc20',
  token,
});
const run = (logs: PaymentLog[], transfers: TransferLite[], signers: Record<number, string>) =>
  confirmPayments(
    logs,
    (s) => transfers.filter((t) => t.to === s),
    (hash) => signers[Number(BigInt(hash))],
  );
const out = (stealth: string, to: string, kind: Withdrawal['kind'], token: string | null, tx: number, block: number): Withdrawal => ({
  stealth, txHash: h(tx), block, to, kind, token, txFrom: stealth, txType: 2, priorityFee: '1000000000',
});
const metrics = (r: ReturnType<typeof run>, senders: Record<string, string>, w: Withdrawal[]) => {
  const payments: Payment[] = r.payments.map((p) => ({
    source: p.source, stealth: p.stealth, sender: senders[p.txHash] ?? '', block: p.blockNumber,
    timestamp: p.blockTimestamp ?? 0, asset: p.asset, token: p.token, txHash: p.txHash,
  }));
  const ds: Dataset = { payments, withdrawals: w, fundings: [], registrations: [], contracts: new Set(), delegated: new Set(), preUsed: new Set() };
  return analyze(ds, opts).all;
};

test('Rusdi R1 (6 Nov): a stranger\'s 1 wei of ETH in one transaction with dust binds nothing', () => {
  const at = C + 1_000;
  for (const asset of ['ETH', 'UNKNOWN', 'TOKEN'] as const) {
    const logs = [ann(S(1), asset, null, 100, at)];
    const real = arrive(S(1), 101, at + 1, null, P);
    const bundle = [arrive(S(1), 102, at + 3, null, X), arrive(S(1), 102, at + 3, TB, X)]; // 1 wei + dust, one transaction
    const r = run(logs, [real, ...bundle], { 100: P, 101: P, 102: X });
    assert.ok(r.payments.some((p) => p.txHash === h(101) && p.asset === 'ETH'), `${asset}: the real ETH payment stays`);
    assert.ok(!r.payments.some((p) => p.asset === 'TOKEN'), `${asset}: no token row from the stranger`);
    assert.equal(r.tokenDust, 1, asset);
    const m = metrics(r, { [h(101)]: P, [h(102)]: X }, [out(S(1), P, 'eth', null, 201, at + 50)]);
    assert.equal(m.withdrawn, 1, asset);
    assert.equal(m.h2Any, 1, asset);
  }
});

test('Rusdi R1 control: the payer\'s own transaction with gas ETH and the token is still the token payment', () => {
  const at = C + 2_000;
  const r = run([ann(S(2), 'ETH', null, 110, at)], [arrive(S(2), 111, at + 1, null, P), arrive(S(2), 111, at + 1, TA, P)], { 110: P, 111: P });
  assert.deepEqual(r.payments.map((p) => [p.asset, p.token]), [['TOKEN', TA]]);
  assert.equal(r.tokenDust, 0);
});

test('Rusdi R3 (6 Nov): a stranger\'s 1 wei of ETH does not erase a real token-only payment', () => {
  const at = C + 3_000;
  const logs = [ann(S(3), 'TOKEN', null, 120, at)]; // names a token selector, no token
  const r = run(logs, [arrive(S(3), 121, at + 1, TA, P), arrive(S(3), 122, at + 2, null, X)], { 120: P, 121: P, 122: X });
  assert.ok(r.payments.some((p) => p.asset === 'TOKEN' && p.token === TA), 'the token payment stays');
  const m = metrics(r, { [h(121)]: P, [h(122)]: X }, [out(S(3), P, 'token', TA, 220, at + 50)]);
  assert.equal(m.withdrawn, 1);
  assert.equal(m.h2Any, 1);
  // Shape A: UNKNOWN metadata, real ETH from the payer; the stranger sponsors his dust with his own ETH
  const a2 = run([ann(S(4), 'UNKNOWN', null, 123, at)], [arrive(S(4), 124, at + 1, null, P), arrive(S(4), 125, at + 2, null, X), arrive(S(4), 125, at + 2, TB, X)], { 123: P, 124: P, 125: X });
  assert.ok(a2.payments.some((p) => p.txHash === h(124) && p.asset === 'ETH'));
  assert.ok(!a2.payments.some((p) => p.asset === 'TOKEN'));
});

test('Rusdi R4 (6 Nov): a fake token that claims the payer as `from` in its Transfer log binds nothing', () => {
  const at = C + 4_000;
  for (const asset of ['UNKNOWN', 'TOKEN'] as const) {
    const logs = [ann(S(5), asset, null, 130, at)];
    const spoof = arrive(S(5), 132, at + 2, TB, P); // log says from = payer; the transaction was signed by the stranger
    const r = run(logs, [arrive(S(5), 131, at + 1, null, P), spoof], { 130: P, 131: P, 132: X });
    assert.deepEqual(r.payments.map((p) => [p.asset, p.txHash]), [['ETH', h(131)]], asset);
    assert.equal(r.tokenDust, 1, asset);
  }
  // control: the same token sent in a transaction the payer signed still binds (one payer sent token and gas)
  const ok = run([ann(S(6), 'UNKNOWN', null, 133, at)], [arrive(S(6), 134, at + 1, null, P), arrive(S(6), 135, at + 2, TA, P)], { 133: P, 134: P, 135: P });
  assert.deepEqual(ok.payments.map((p) => p.asset), ['TOKEN']);
});

test('without the signer of the announcement only its own transaction binds, and any ETH decides, as before (no signer lookup)', () => {
  const at = C + 5_000;
  const r = confirmPayments([ann(S(7), 'UNKNOWN', null, 140, at)], (s) => [arrive(S(7), 141, at + 1, null, P), arrive(S(7), 142, at + 1, TA, P)].filter((t) => t.to === s));
  assert.deepEqual(r.payments.map((p) => p.asset), ['ETH']);
  assert.equal(r.tokenDust, 1);
});

test('neededTxs lists the announcement transactions and the arrivals the binding needs a signer for', () => {
  const at = C + 6_000;
  const logs = [ann(S(8), 'ETH', null, 150, at)];
  const transfers = [arrive(S(8), 151, at + 1, null, P), arrive(S(8), 152, at + 1, TA, P)];
  const need = neededTxs(logs, (s) => transfers.filter((t) => t.to === s));
  assert.deepEqual([...need].sort(), [h(150), h(151), h(152)].sort());
  assert.deepEqual(neededTxs([ann(S(9), 'ETH', null, 153, at)], () => []), [h(153)]);
});
