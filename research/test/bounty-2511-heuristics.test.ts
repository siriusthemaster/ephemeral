/**
 * Bug bounty, 24 and 25 Nov (scanner, heuristics.ts). Each test names the report it covers.
 * (2) A router deployed after a stranger's spam payment to its predictable address stays a foreign contract (H3, H5).
 * (5) An ERC-5564 row of a token that was paid through Umbra does not make direct transfers of it withdrawals.
 * (9) The sinceCutoff scope does not count a pre-cutoff stealth contract's gas funding as H5.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyze, type Dataset, type Payment, type Withdrawal } from '../lib/heuristics.ts';
import { UNIQUE_FEE_MAX } from '../lib/config.ts';
import { a, h, CUTOFF_BLOCK as C } from './fixture.ts';

const P = a(0xa001); // the payer
const X = a(0xbad1); // a stranger
const G = a(0xbad2); // a griefer
const RL = a(0x1e1); // a relayer
const R = a(0x101); // a registrant
const D = a(0xd001); // a destination
const TA = a(0x7a7a);
const S = (i: number): string => a(0x5200 + i);
const opts = { uniqueFeeMax: UNIQUE_FEE_MAX, cutoffBlock: C };

const own = (stealth: string, tx: number, to: string, kind: Withdrawal['kind'], token: string | null, block: number): Withdrawal => ({
  stealth, txHash: h(tx), block, to, kind, token, txFrom: stealth, txType: 2, priorityFee: '1000000000',
});
const dataset = (payments: Payment[], withdrawals: Withdrawal[], over: Partial<Dataset> = {}): Dataset => ({
  payments, withdrawals, fundings: [], registrations: [], contracts: new Set(), delegated: new Set(), preUsed: new Set(), ...over,
});

// ------------------------------------------------------------------ (2) a router deployed after the spam payment
test('whitelistsol 25 Nov: a router deployed after a spam payment to its address stays out of H3 and H5', () => {
  const B = C + 8_000;
  const ROUTER = a(0x7009);
  const [S1, S2, S3] = [S(11), S(12), S(13)];
  const ethPay = (st: string, tx: number): Payment => ({ source: 'erc5564', stealth: st, sender: P, block: B, timestamp: 0, asset: 'ETH', token: null, txHash: h(tx) });
  const base = dataset(
    [ethPay(S1, 60), ethPay(S2, 61), { source: 'erc5564', stealth: S3, sender: P, block: B, timestamp: 0, asset: 'TOKEN', token: TA, txHash: h(62) }],
    [own(S1, 63, ROUTER, 'eth', null, B + 50), own(S2, 64, ROUTER, 'eth', null, B + 50), own(S3, 65, D, 'token', TA, B + 60)],
    {
      fundings: [{ stealth: S3, txHash: h(66), block: B + 10, from: ROUTER }],
      registrations: [{ registrant: ROUTER, block: C - 10, registry: 'erc6538' }],
      contracts: new Set([ROUTER]),
    },
  );
  // the spam row lands before the router exists: its nonce was 0 then, so it is not preUsed
  const spam: Dataset = {
    ...base,
    payments: [...base.payments, { source: 'erc5564', stealth: ROUTER, sender: X, block: B - 5, timestamp: 0, asset: 'TOKEN', token: a(0xfa4e), txHash: h(67) }],
  };
  for (const ds of [base, spam]) {
    const r = analyze(ds, opts);
    assert.deepEqual([r.h3.clusters, r.h3.clusteredStealth], [0, 0]);
    assert.equal(r.all.h5, 0);
  }
  // an EIP-7702 delegated address is no contract: two stealth addresses withdrawing to it are still a cluster
  const delegatedDest = dataset([ethPay(S1, 60), ethPay(S2, 61)], [own(S1, 63, D, 'eth', null, B + 50), own(S2, 64, D, 'eth', null, B + 50)], { delegated: new Set([D]) });
  assert.equal(analyze(delegatedDest, opts).h3.clusters, 1);
});

// ------------------------------------------------------------------ (5) the Umbra token guard on a mixed address
test('whitelistsol 25 Nov: a stranger s ERC-5564 row of an Umbra-paid token does not make a direct transfer of it a withdrawal', () => {
  const B = C + 5_000;
  const st = S(41);
  const umbra: Payment = { source: 'umbra', stealth: st, sender: P, block: B, timestamp: 0, asset: 'TOKEN', token: TA, txHash: h(50) };
  const fake: Payment = { source: 'erc5564', stealth: st, sender: G, block: B + 10, timestamp: 0, asset: 'TOKEN', token: TA, txHash: h(51) };
  const regs = { registrations: [{ registrant: R, block: C - 10, registry: 'erc6538' as const }] };
  for (const to of [R, G]) {
    const direct = own(st, 52, to, 'token', TA, B + 50);
    const clean = analyze(dataset([umbra], [direct], regs), opts).all;
    const mixed = analyze(dataset([umbra, fake], [direct], regs), opts).all;
    assert.deepEqual([clean.withdrawn, mixed.withdrawn], [0, 0], to);
    assert.deepEqual([mixed.h1Single, mixed.h2Single, mixed.paperLinked], [0, 0, 0], to);
  }
  // the Umbra TokenWithdrawal still counts
  const tw: Withdrawal = { ...own(st, 53, R, 'umbra-token', TA, B + 60), txFrom: RL };
  const m = analyze(dataset([umbra, fake], [tw], regs), opts).all;
  assert.deepEqual([m.withdrawn, m.h1Single], [1, 1]);
  // and a token paid only directly still leaves by a direct transfer
  const d = analyze(dataset([{ ...fake, sender: P }], [own(st, 52, R, 'token', TA, B + 50)], regs), opts).all;
  assert.deepEqual([d.withdrawn, d.h1Single], [1, 1]);
});

// ------------------------------------------------------------------ (9) foreign contracts in the sinceCutoff scope
test('0xasuma 24 Nov: a stealth contract paid before the cutoff is no H5 funder of ours in the sinceCutoff scope', () => {
  const K = a(0x7c01); // a contract that a payment row before the cutoff names
  const st = S(81);
  const ds = dataset(
    [
      { source: 'erc5564', stealth: K, sender: X, block: C - 100, timestamp: 0, asset: 'ETH', token: null, txHash: h(90) },
      { source: 'erc5564', stealth: st, sender: P, block: C + 100, timestamp: 0, asset: 'TOKEN', token: TA, txHash: h(91) },
    ],
    [own(st, 92, D, 'token', TA, C + 300)],
    {
      fundings: [{ stealth: st, txHash: h(93), block: C + 200, from: K }],
      registrations: [{ registrant: K, block: C - 1_000, registry: 'erc6538' }],
      contracts: new Set([K]),
    },
  );
  const r = analyze(ds, opts);
  assert.equal(r.sinceCutoff.needingOwnGas, 1);
  assert.deepEqual([r.sinceCutoff.h5, r.all.h5], [0, 0]);
});
