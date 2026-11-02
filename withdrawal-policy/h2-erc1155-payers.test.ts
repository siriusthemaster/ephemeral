// 31 Oct, bug bounty (H2): the funding pass read only ERC-20 and ERC-721 Transfer logs to a stealth address. An ERC-1155
// TransferSingle or TransferBatch has another topic, with operator, from and to in topics 1 to 3, so its sender never
// became a payer and H2 could say "not the payer" for it. readFunding now also asks for both events with `to` = the
// address; the operator, the sender and the sender of the transaction are payers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toEventSelector, type Hex } from 'viem';
import { TRANSFER_BATCH_TOPIC, TRANSFER_SINGLE_TOPIC, paymentView, readFunding, type FundingReader, type FundLog } from './funding.ts';
import { blocking, withdrawChecks, type GuardInput } from './guards.ts';

const S = '0x1111111111111111111111111111111111111111' as Hex;
const S2 = '0x2222222222222222222222222222222222222222' as Hex;
const SENDER = '0x3333333333333333333333333333333333333333' as Hex;
const OPERATOR = '0x4444444444444444444444444444444444444444' as Hex;
const RELAYER = '0x5555555555555555555555555555555555555555' as Hex;
const NFT = '0x6666666666666666666666666666666666666666' as Hex;
const CALLER = '0x7777777777777777777777777777777777777777' as Hex;
const KEY = '0x8888888888888888888888888888888888888888' as Hex;
const FRESH = '0x9999999999999999999999999999999999999999' as Hex;
const pad = (a: string) => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}` as Hex;
const word = (n: bigint) => n.toString(16).padStart(64, '0');
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const low = (a: string) => a.toLowerCase();

/** A node that answers eth_getLogs filters like a real one: null = any, a list = any of them. */
function reader(logs: FundLog[], txs: Record<string, { from: Hex; to: Hex | null; value: bigint; block: bigint }>): FundingReader {
  const match = (want: Hex | Hex[] | null | undefined, got: string) =>
    want === null || want === undefined || (Array.isArray(want) ? want.map(low).includes(got) : low(want) === got);
  return {
    head: async () => 1_000n,
    balance: async () => 0n,
    nonce: async () => 0,
    getLogs: async ({ fromBlock, toBlock, topics }) =>
      logs.filter((l) => {
        const b = BigInt(l.blockNumber as bigint);
        const t = (l.topics ?? []).map((x) => low(x ?? ''));
        return b >= fromBlock && b <= toBlock && topics.every((want, i) => match(want, t[i] ?? ''));
      }),
    tx: async (hash) => {
      const t = txs[hash];
      return t ? { from: t.from, to: t.to, value: t.value, blockNumber: t.block } : null;
    },
    succeeded: async (hash) => (txs[hash] ? true : null),
    blockTxs: async () => [],
    tokenBalance: async () => Promise.reject(new Error('not an ERC-20')),
  };
}
const guard = (g: Partial<GuardInput>): GuardInput => ({
  destination: FRESH,
  stealthAddress: S,
  walletAddress: KEY,
  payer: CALLER,
  ownStealthAddresses: [S, S2],
  usedDestinations: [],
  historyComplete: true,
  isToken: false,
  hasGas: true,
  now: 10 * 3600_000,
  ...g,
});

test('the ERC-1155 event topics are the standard ones', () => {
  assert.equal(TRANSFER_SINGLE_TOPIC, toEventSelector('TransferSingle(address,address,address,uint256,uint256)'));
  assert.equal(TRANSFER_BATCH_TOPIC, toEventSelector('TransferBatch(address,address,address,uint256[],uint256[])'));
});

for (const [name, topic0, data] of [
  ['TransferSingle', TRANSFER_SINGLE_TOPIC, `0x${word(7n)}${word(1n)}`],
  ['TransferBatch', TRANSFER_BATCH_TOPIC, `0x${word(64n)}${word(160n)}${word(1n)}${word(7n)}${word(1n)}${word(1n)}`],
] as const)
  test(`an ERC-1155 ${name} to the stealth address: operator, sender and transaction sender are payers, and H2 blocks them`, async () => {
    const PAY = h(1);
    const ANN = h(2);
    const log: FundLog = { address: NFT, topics: [topic0, pad(OPERATOR), pad(SENDER), pad(S)], data, blockNumber: 100n, transactionHash: PAY, logIndex: 4 };
    const r = reader([log], { [PAY]: { from: RELAYER, to: NFT, value: 0n, block: 100n }, [ANN]: { from: CALLER, to: null, value: 0n, block: 100n } });
    const f = (await readFunding(r, [{ address: S, announcements: [{ txHash: ANN, caller: CALLER, blockNumber: 100n }] }], { startBlock: 0n }))[low(S)]!;
    assert.equal(f.tokens[0]?.kind, 'erc1155');
    assert.equal(f.tokens[0]?.operator, low(OPERATOR));
    for (const p of [SENDER, OPERATOR, RELAYER, CALLER]) assert.ok(f.payers.includes(low(p) as Hex), p);
    assert.equal(f.payersKnown, true, String(f.gap));
    assert.equal(paymentView([], f).assetUnknown, 'nft');
    for (const p of [SENDER, OPERATOR, RELAYER]) {
      const c = withdrawChecks(guard({ destination: p, payers: f.payers }));
      assert.equal(c.find((x) => x.id === 'H2')?.level, 'block', p);
      assert.equal(blocking(c), true);
    }
    assert.equal(withdrawChecks(guard({ payers: f.payers })).find((x) => x.id === 'H2')?.level, 'ok');
  });

test('an ERC-1155 log to another address adds no payer', async () => {
  const PAY = h(1);
  const log: FundLog = { address: NFT, topics: [TRANSFER_SINGLE_TOPIC, pad(OPERATOR), pad(SENDER), pad(S2)], data: `0x${word(7n)}${word(1n)}`, blockNumber: 100n, transactionHash: PAY, logIndex: 4 };
  const f = (await readFunding(reader([log], { [PAY]: { from: RELAYER, to: NFT, value: 0n, block: 100n } }), [{ address: S, announcements: [] }], { startBlock: 0n }))[low(S)]!;
  assert.equal(f.tokens.length, 0);
  assert.ok(!f.payers.includes(low(OPERATOR) as Hex));
});
