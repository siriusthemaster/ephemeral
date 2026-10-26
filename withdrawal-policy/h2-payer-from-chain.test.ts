// H2 payers and the asset come from the chain, not from the announcement (mirror of the ephemeral client 0.2.9 fix).
// 1. The payer was taken from the announcement (its caller). When a relayer or anyone else announced, the address that
//    funded the stealth address was not a payer, and H2 said "not the payer" for it.
// 2. Metadata shorter than 57 bytes names no asset, so H5 never fired for such a token payment.
// 3. and 4. A later announcement for the same address could set the amount and asset shown and the payer.
// All chain and explorer data is mocked: no network.
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Hex } from 'viem';
import {
  blockscoutIncoming,
  orderTokens,
  parseMetadata,
  paymentView,
  pickAnnouncement,
  readFunding,
  MULTI_ANNOUNCEMENT,
  type ExplorerIn,
  type FundLog,
  type Funding,
  type FundingReader,
  type Hit,
} from './funding.ts';
import { blocking, warnings, withdrawChecks, type GuardInput } from './guards.ts';

const S = '0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a' as Hex;
const PAYER = '0x3333333333333333333333333333333333333333' as Hex;
const RELAYER = '0x7777777777777777777777777777777777777777' as Hex;
const ATTACKER = '0xabababababababababababababababababababab' as Hex;
const BUYER = '0xb0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0' as Hex;
const POOL = '0xc0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0' as Hex;
const ROUTER = '0xd1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1d1' as Hex;
const TOKEN = '0x9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a9a' as Hex;
const KEY = '0x2222222222222222222222222222222222222222' as Hex;
const FRESH = '0x6666666666666666666666666666666666666666' as Hex;
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const ETH = 10n ** 18n;
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
const word = (v: bigint | string) => (typeof v === 'bigint' ? v.toString(16) : v.replace(/^0x/, '').toLowerCase()).padStart(64, '0');
const topic = (a: string) => `0x${word(a)}` as Hex;
const low = (a: string) => a.toLowerCase() as Hex;
const ethMeta = (amount: bigint) => `0x2aeeeeeeee${'ee'.repeat(20)}${word(amount)}` as Hex;

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Tx = { from: Hex; to: Hex | null; value: bigint; block: bigint };
type Chain = { balance?: bigint; nonce?: number; txs?: Record<string, Tx>; logs?: FundLog[]; tokens?: Record<string, bigint>; explorer?: ExplorerIn[]; logsDown?: boolean };

function reader(c: Chain): FundingReader {
  const txs = c.txs ?? {};
  const r: FundingReader = {
    head: async () => 1_000n,
    balance: async () => c.balance ?? 0n,
    nonce: async () => c.nonce ?? 0,
    getLogs: async ({ fromBlock, toBlock, topics }) => {
      if (c.logsDown) throw new Error('refused');
      const want = topics[2];
      const list = Array.isArray(want) ? want.map(low) : null;
      return (c.logs ?? []).filter((l) => {
        const b = BigInt(l.blockNumber as bigint);
        return b >= fromBlock && b <= toBlock && (!list || list.includes(low(l.topics?.[2] ?? '')));
      });
    },
    tx: async (hash) => {
      const t = txs[hash];
      return t ? { from: t.from, to: t.to, value: t.value, blockNumber: t.block } : null;
    },
    succeeded: async (hash) => (txs[hash] ? true : null),
    blockTxs: async (n) =>
      Object.entries(txs)
        .filter(([, t]) => t.block === n)
        .map(([hash, t]) => ({ hash, from: t.from, to: t.to, value: t.value })),
    tokenBalance: async (token) => {
      const v = (c.tokens ?? {})[low(token)];
      if (v === undefined) throw new Error('no such token');
      return v;
    },
  };
  if (c.explorer) r.explorer = async () => c.explorer as ExplorerIn[];
  return r;
}
async function fund(c: Chain, anns: { txHash: Hex; caller: Hex; blockNumber: bigint }[], claimedTokens: Hex[] = []): Promise<Funding> {
  const f = (await readFunding(reader(c), [{ address: S, announcements: anns, claimedTokens }], { startBlock: 0n }))[low(S)];
  assert.ok(f);
  return f;
}
const hit = (tx: Hex, caller: Hex, block: bigint, metadata: Hex): Hit => ({
  schemeId: 1n,
  stealthAddress: S,
  caller,
  ephemeralPubKey: '0x02',
  metadata,
  txHash: tx,
  blockNumber: block,
  metaParsed: parseMetadata(metadata),
});
/** How a wallet feeds the evidence into the guard: payer = a payer read from the chain only while all of them are known. */
const guardFor = (f: Funding, over: Partial<GuardInput> = {}): GuardInput => ({
  destination: FRESH,
  stealthAddress: S,
  walletAddress: KEY,
  payer: f.payersKnown ? f.payers[0] : undefined,
  payers: f.payers,
  ownStealthAddresses: [S],
  usedDestinations: [],
  historyComplete: true,
  isToken: false,
  hasGas: true,
  now: Date.now(),
  ...over,
});
const h2 = (g: GuardInput) => withdrawChecks(g).find((c) => c.id === 'H2')!;

test('relayed announcement: the address that sent the ETH is a payer, the announcement caller stays one', async () => {
  const f = await fund(
    { balance: ETH / 2n, txs: { [h(1)]: { from: RELAYER, to: null, value: 0n, block: 100n }, [h(2)]: { from: PAYER, to: S, value: ETH / 2n, block: 101n } } },
    [{ txHash: h(1), caller: RELAYER, blockNumber: 100n }],
  );
  assert.equal(f.payersKnown, true);
  // before: only the announcement was read, so the real payer passed
  assert.equal(h2(guardFor(f, { destination: PAYER, payer: RELAYER, payers: [] })).text, 'H2: not the payer.');
  for (const d of [PAYER, RELAYER]) assert.equal(h2(guardFor(f, { destination: d })).level, 'warn', d);
  assert.equal(h2(guardFor(f)).level, 'ok');
});

test('token payment: the Transfer log sender and its transaction sender are payers; internal ETH from the explorer', async () => {
  const tip = ETH / 2000n;
  const f = await fund(
    {
      balance: tip,
      txs: { [h(1)]: { from: RELAYER, to: null, value: 0n, block: 200n }, [h(3)]: { from: BUYER, to: POOL, value: ETH / 10n, block: 200n } },
      logs: [{ address: TOKEN, topics: [TRANSFER, topic(POOL), topic(S)], data: `0x${word(ETH)}`, blockNumber: 200n, transactionHash: h(3), logIndex: 0 }],
      tokens: { [low(TOKEN)]: ETH },
      explorer: [{ tx: h(3), from: ROUTER, value: tip, internal: true }],
    },
    [{ txHash: h(1), caller: RELAYER, blockNumber: 200n }],
  );
  assert.equal(f.payersKnown, true, String(f.gap));
  for (const p of [POOL, BUYER, ROUTER, RELAYER]) assert.equal(h2(guardFor(f, { destination: p, isToken: true })).level, 'warn', p);
});

test('fail closed: while any funding sender cannot be read, the wallet passes no payer and H2 blocks', async () => {
  const txs = { [h(1)]: { from: PAYER, to: null, value: 0n, block: 100n }, [h(2)]: { from: PAYER, to: S, value: ETH / 2n, block: 101n } };
  for (const [name, c, gap] of [
    ['ETH not accounted for', { balance: (ETH * 6n) / 10n, txs }, 'eth'],
    ['logs refused', { balance: ETH / 2n, txs, logsDown: true }, 'unread'],
    ['already sent, no explorer', { balance: ETH / 10n, nonce: 1, txs }, 'spent'],
    ['token held without a Transfer log', { balance: ETH / 2n, txs, tokens: { [low(TOKEN)]: 5n } }, 'token'],
  ] as [string, Chain, string][]) {
    const f = await fund(c, [{ txHash: h(1), caller: PAYER, blockNumber: 100n }], gap === 'token' ? [TOKEN] : []);
    assert.equal(f.payersKnown, false, name);
    assert.equal(f.gap, gap, name);
    const g = guardFor(f);
    assert.equal(h2(g).level, 'block', name);
    assert.equal(blocking(withdrawChecks(g)), true, name);
  }
});

test('short metadata: the token comes from the chain, so H5 fires; an unreadable asset is never a silent pass', async () => {
  assert.equal(parseMetadata('0x2a').amount, undefined);
  const f = await fund(
    {
      balance: 0n,
      txs: { [h(1)]: { from: PAYER, to: null, value: 0n, block: 300n }, [h(5)]: { from: PAYER, to: TOKEN, value: 0n, block: 300n } },
      logs: [{ address: TOKEN, topics: [TRANSFER, topic(PAYER), topic(S)], data: `0x${word(7n * ETH)}`, blockNumber: 300n, transactionHash: h(5), logIndex: 0 }],
      tokens: { [low(TOKEN)]: 7n * ETH },
    },
    [{ txHash: h(1), caller: PAYER, blockNumber: 300n }],
  );
  const v = paymentView([hit(h(1), PAYER, 300n, '0x2a')], f);
  assert.equal(v.assetUnknown, null);
  const tokens = orderTokens([{ address: TOKEN, balance: 7n * ETH }], f, null);
  const g = withdrawChecks(guardFor(f, { isToken: tokens.length > 0, hasGas: false }));
  assert.equal(g.find((c) => c.id === 'H5')!.level, 'block');
  // nothing readable arrived: a possible token payment
  const none = await fund({ balance: 0n, txs: { [h(1)]: { from: PAYER, to: null, value: 0n, block: 300n } } }, [{ txHash: h(1), caller: PAYER, blockNumber: 300n }]);
  assert.equal(paymentView([hit(h(1), PAYER, 300n, '0x2a')], none).assetUnknown, 'unseen');
  assert.equal(withdrawChecks(guardFor(f, { assetUnknown: true, hasGas: false })).find((c) => c.id === 'H5')!.level, 'block');
  assert.deepEqual(warnings(withdrawChecks(guardFor(f, { assetUnknown: true, hasGas: true }))).map((c) => c.id), ['H5']);
});

test('a later announcement claiming 5 ETH on a 0.5 ETH payment decides nothing', async () => {
  const f = await fund(
    {
      balance: ETH / 2n,
      txs: { [h(1)]: { from: PAYER, to: null, value: 0n, block: 100n }, [h(2)]: { from: ATTACKER, to: null, value: 0n, block: 180n }, [h(9)]: { from: PAYER, to: S, value: ETH / 2n, block: 101n } },
    },
    [{ txHash: h(2), caller: ATTACKER, blockNumber: 180n }, { txHash: h(1), caller: PAYER, blockNumber: 100n }],
  );
  const hits = [hit(h(2), ATTACKER, 180n, ethMeta(5n * ETH)), hit(h(1), PAYER, 100n, ethMeta(ETH / 2n))];
  const v = paymentView(hits, f);
  assert.equal(hits[v.primary]!.txHash, h(1));
  assert.equal(pickAnnouncement(hits, f).matched, true);
  assert.equal(v.sentWei, ETH / 2n);
  assert.equal(v.receiptTx, h(9));
  assert.equal(v.multi, true);
  assert.match(MULTI_ANNOUNCEMENT, /more than one announcement points to this address/i);
  assert.equal(h2(guardFor(f, { destination: PAYER })).level, 'warn');
});

test('Blockscout incoming: plain and internal transfers to the address, filter=to', async () => {
  const seen: string[] = [];
  globalThis.fetch = (async (u: string) => {
    seen.push(u);
    const body = new URL(u).pathname.endsWith('/internal-transactions')
      ? { items: [{ transaction_hash: h(3), from: { hash: ROUTER }, to: { hash: S }, value: '500', success: true }], next_page_params: null }
      : { items: [{ hash: h(2), from: { hash: PAYER }, to: { hash: S }, value: '1000', status: 'ok' }, { hash: h(5), from: { hash: S }, to: { hash: FRESH }, value: '1', status: 'ok' }], next_page_params: null };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  assert.deepEqual(await blockscoutIncoming('https://bs.invalid/api/v2')(S), [
    { tx: h(2), from: PAYER, value: 1000n, internal: false },
    { tx: h(3), from: ROUTER, value: 500n, internal: true },
  ]);
  assert.ok(seen.every((u) => new URL(u).searchParams.get('filter') === 'to'));
});
