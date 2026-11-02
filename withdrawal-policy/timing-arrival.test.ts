// 31 Oct, bug bounty (timing): the timing advice should count from the block the funds arrived in, read from the chain,
// not from the announcement: a payer can announce long before paying. funding.ts arrivalBlock gives that block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Hex } from 'viem';
import { arrivalBlock, readFunding, type FundingReader } from './funding.ts';
import { withdrawChecks, type GuardInput } from './guards.ts';

const S = '0x1111111111111111111111111111111111111111' as Hex;
const PAYER = '0x2222222222222222222222222222222222222222' as Hex;
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const START = 1_790_000_000_000;
const timeOf = (n: bigint) => START + Number(n) * 12_000;
const reader: FundingReader = {
  head: async () => 10_000n,
  balance: async () => 1000n,
  nonce: async () => 0,
  getLogs: async () => [],
  tx: async (hash) => (hash === h(1) ? { from: PAYER, to: S, value: 1000n, blockNumber: 9_000n } : { from: PAYER, to: null, value: 0n, blockNumber: 100n }),
  succeeded: async () => true,
  blockTxs: async () => [],
  tokenBalance: async () => 0n,
  explorer: async () => [{ tx: h(1), from: PAYER, value: 1000n, internal: false }],
};
const timing = (receivedAt: number, now: number) =>
  withdrawChecks({
    destination: '0x6666666666666666666666666666666666666666',
    stealthAddress: S,
    walletAddress: '0x7777777777777777777777777777777777777777',
    payer: PAYER,
    ownStealthAddresses: [S],
    usedDestinations: [],
    historyComplete: true,
    receivedAt,
    isToken: false,
    hasGas: true,
    now,
  } as GuardInput).find((c) => c.id === 'time');

test('announced at block 100, paid at block 9,000: 20 minutes after the payment the timing advice shows', async () => {
  const f = (await readFunding(reader, [{ address: S, announcements: [{ txHash: h(9), caller: PAYER, blockNumber: 100n }] }], { startBlock: 0n }))[S.toLowerCase()];
  assert.equal(f?.payersKnown, true, String(f?.gap));
  assert.equal(arrivalBlock(f), 9_000n);
  const now = timeOf(9_000n) + 20 * 60_000;
  assert.equal(timing(timeOf(100n), now), undefined, 'from the announcement nothing would show');
  assert.equal(timing(timeOf(9_000n), now)?.level, 'warn');
  assert.equal(arrivalBlock(undefined), null);
});
