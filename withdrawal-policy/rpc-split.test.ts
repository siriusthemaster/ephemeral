// 31 Oct, bug bounty (RPC): some public endpoints (the client's default, publicnode) refuse eth_getLogs without an
// address, or with a list of addresses in a topic. The ephemeral client then fell back to the wallet's own RPC with the
// list of payment addresses in it (fixed in the client: those reads never go to the wallet). Here, in the reader: a
// refused list is asked again one address at a time, and an address whose logs still cannot be read gets the gap
// `logs`, whose text says to set an RPC in Settings. payersKnown stays false for it, so H2 blocks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Hex } from 'viem';
import { FUNDING_GAP, readFunding, type FundingReader } from './funding.ts';

const A = '0x1111111111111111111111111111111111111111' as Hex;
const B = '0x2222222222222222222222222222222222222222' as Hex;
const PAYER = '0x3333333333333333333333333333333333333333' as Hex;
const pad = (a: string) => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}`;
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;

function reader(refuse: 'lists' | 'all'): FundingReader & { asked: unknown[][] } {
  const asked: unknown[][] = [];
  return {
    asked,
    head: async () => 1_000n,
    balance: async () => 5n,
    nonce: async () => 0,
    getLogs: async ({ topics }) => {
      asked.push(topics);
      const list = topics.some((t) => Array.isArray(t) && t.length > 1 && t.every((x) => /^0x0{24}/.test(x)));
      if (refuse === 'all' || list) throw new Error('Please specify an address in your request');
      return [];
    },
    tx: async (hash) => (hash === h(1) ? { from: PAYER, to: A, value: 5n, blockNumber: 100n } : hash === h(2) ? { from: PAYER, to: B, value: 5n, blockNumber: 100n } : null),
    succeeded: async () => true,
    blockTxs: async () => [],
    tokenBalance: async () => 0n,
    explorer: async (address) => [{ tx: address === A ? h(1) : h(2), from: PAYER, value: 5n, internal: false }],
  };
}
const queries = [
  { address: A, announcements: [{ txHash: h(1), caller: PAYER, blockNumber: 100n }] },
  { address: B, announcements: [{ txHash: h(2), caller: PAYER, blockNumber: 100n }] },
];

test('an endpoint that refuses lists of addresses is asked one address at a time, and the pass completes', async () => {
  const r = reader('lists');
  const f = await readFunding(r, queries, { startBlock: 0n });
  for (const a of [A, B]) assert.equal(f[a.toLowerCase()]?.payersKnown, true, String(f[a.toLowerCase()]?.gap));
  assert.ok(r.asked.some((t) => t[2] === pad(A)) && r.asked.some((t) => t[2] === pad(B)), 'each address alone');
});

test('an endpoint that refuses every query without an address: gap logs for each address, with the Settings hint', async () => {
  const f = await readFunding(reader('all'), queries, { startBlock: 0n });
  for (const a of [A, B]) {
    assert.equal(f[a.toLowerCase()]?.gap, 'logs');
    assert.equal(f[a.toLowerCase()]?.payersKnown, false);
  }
  assert.match(FUNDING_GAP.logs, /Set an RPC in Settings/);
});
