import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { run, type Deps } from '../collect.ts';
import { loadCheckpoint, newState, saveCheckpoint, skipHash } from '../checkpoint.ts';
import { buildTvu, sanityCheck, type Tvu } from '../output.ts';
import { fetchPrices } from '../prices.ts';
import { FallbackRpc, RpcError } from '../rpc.ts';
import { applyLog } from '../scan.ts';
import { annLog, addr, ETH, MockChain, ROUTER, testChain, umbraLog } from './mock.ts';

const PRICES = { eth: 2000, pol: 0.5 };
const deps = (m: MockChain, over: Partial<Deps> = {}): Deps => ({
  makeRpc: async () => m,
  prices: async () => PRICES,
  sector: async () => ({ chains: { ethereum: { umbra: 2, erc5564: 1 } } }),
  now: () => Date.now(),
  log: () => {},
  ...over,
});
const dir = (): string => mkdtempSync(join(tmpdir(), 'tvu-'));
const opts = (d: string, extra = {}) => ({ dataDir: d, budgetMs: 60_000, publish: true, chains: [testChain], ...extra });

function world(): MockChain {
  const m = new MockChain();
  m.head = 500;
  const A = addr(0xa1), B = addr(0xa2), C = addr(0xa3), D = addr(0xa4), W = addr(0xa5), E = addr(0xe1), F = addr(0xe2);
  m.logs.push(umbraLog(A, 120), umbraLog(B, 250), annLog(C, addr(0x77), 300), annLog(D, addr(0x78), 310), annLog(W, addr(0x79), 320));
  // ephemeral router announcement for E, then a stranger announces E again: E counts (bug bounty 8 Nov: a router
  // announcement no longer erases an address someone else announced). F is announced by the router only: never counted.
  m.logs.push(annLog(E, ROUTER, 330), annLog(E, addr(0x99), 340), annLog(F, ROUTER, 345));
  m.eth.set(A, 1n * ETH); // 2000 USD
  m.usdc.set(B, 500_000_000n); // 500 USD
  m.eth.set(C, 1n * ETH); // contract, excluded
  m.codes.set(C, '0x6080');
  m.eth.set(D, 1n * ETH); // nonce too high, excluded
  m.nonces.set(D, 1001);
  m.eth.set(W, 300n * ETH); // whale, excluded
  m.eth.set(E, 1n * ETH); // 2000 USD: announced by someone else too, counted
  m.eth.set(F, 50n * ETH); // router only, never counted
  m.umbraUsdc = 70_000_000n; // 70 USD pending
  return m;
}

test('router-only addresses stay out, filters drop contracts, nonce and whales', async () => {
  const d = dir();
  const r = await run(opts(d), deps(world()));
  assert.ok(r.published);
  const t = r.tvu!;
  assert.equal(t.parts.stealthNative, 4000);
  assert.equal(t.parts.stealthTokens, 500);
  assert.equal(t.parts.umbraPendingTokens, 70);
  assert.equal(t.totalUsd, 4570);
  assert.equal(t.excludedOutliers.count, 3);
  assert.equal(t.excludedOutliers.usd, 2000 + 2000 + 600_000);
  // F (50 ETH) is nowhere: not in the total and not among the outliers
  assert.equal(t.byChain.ethereum!.addresses, 6);
  assert.equal(t.label, 'all protocols combined');
  const text = readFileSync(join(d, 'tvu.json'), 'utf8');
  assert.ok(!/0xeed50c|0x231191/i.test(text));
  assert.ok(!/[\u2013\u2014]/.test(text));
});

test('excluded caller counts are never kept', () => {
  const s = newState();
  applyLog(s, annLog(addr(1), ROUTER, 5));
  applyLog(s, annLog(addr(2), addr(9), 5));
  assert.equal(s.erc5564, 1);
  assert.equal(s.addresses.size, 1);
  assert.ok(s.skip.has(skipHash(addr(1))));
});

test('multicall batches stay at or below 500 calls', async () => {
  const m = new MockChain();
  m.head = 500;
  for (let i = 0; i < 700; i++) m.logs.push(umbraLog(addr(0x1000 + i), 150));
  await run(opts(dir()), deps(m));
  assert.ok(m.stats.ethCalls >= 3);
  assert.ok(m.stats.maxSubcalls <= 500);
});

test('range errors shrink the range and the scan still completes', async () => {
  const m = world();
  m.maxRange = 40;
  const r = await run(opts(dir()), deps(m));
  assert.ok(r.published);
  assert.ok(m.stats.rangeErrors > 0);
  assert.equal(r.tvu!.totalUsd, 4570);
});

test('budget end saves progress and publishes nothing, next run resumes', async () => {
  const d = dir();
  const m = world();
  m.maxRange = 50;
  const first = await run(opts(d), deps(m, { now: () => (m.stats.logCalls - m.stats.rangeErrors >= 3 ? Date.now() + 10 ** 9 : Date.now()) }));
  assert.equal(first.complete, false);
  assert.equal(first.published, false);
  assert.ok(!existsSync(join(d, 'tvu.json')));
  const mid = loadCheckpoint(d, ['ethereum']).ethereum!;
  assert.ok(mid.lastBlock > 0 && mid.lastBlock < 500);
  const second = await run(opts(d), deps(m));
  assert.ok(second.published);
  const fresh = await run(opts(dir()), deps(world()));
  assert.equal(second.tvu!.totalUsd, fresh.tvu!.totalUsd);
  assert.equal(loadCheckpoint(d, ['ethereum']).ethereum!.lastBlock, 488);
});

test('checkpoint round trip', () => {
  const d = dir();
  const s = newState();
  s.lastBlock = 42;
  s.addresses.add(addr(3));
  s.addresses.add(addr(1));
  s.skip.add(skipHash(addr(9)));
  saveCheckpoint(d, { ethereum: s }, { ethereum: false });
  const l = loadCheckpoint(d, ['ethereum']).ethereum!;
  assert.equal(l.lastBlock, 42);
  assert.deepEqual([...l.addresses].sort(), [addr(1), addr(3)]);
  assert.ok(l.skip.has(skipHash(addr(9))));
});

test('price failure means no publish', async () => {
  const d = dir();
  await assert.rejects(run(opts(d), deps(world(), { prices: () => fetchPrices((async () => { throw new Error('down'); }) as never) })));
  assert.ok(!existsSync(join(d, 'tvu.json')));
});

test('price falls back to the second source', async () => {
  const f = (async (url: string) => {
    if (url.includes('coinbase')) throw new Error('down');
    const pair = url.includes('ETHUSD') ? 'XETHZUSD' : 'POLUSD';
    return { ok: true, json: async () => ({ error: [], result: { [pair]: { c: [pair === 'POLUSD' ? '0.2' : '3000'] } } }) };
  }) as never;
  assert.deepEqual(await fetchPrices(f), { eth: 3000, pol: 0.2 });
});

const base = (usd: number): Tvu =>
  buildTvu([{ key: 'ethereum', native: usd, tokens: 0, umbraPending: 0, umbraNative: 0, addresses: 3 }], { count: 0, usd: 0 }, PRICES, 1_800_000_000);

test('sanity asserts', () => {
  sanityCheck(base(10_000), null);
  sanityCheck(base(20_000), base(10_000));
  assert.throws(() => sanityCheck(base(60_000), base(10_000)), /5x/);
  assert.throws(() => sanityCheck(base(1_000), base(10_000)), /5x/);
  const nan = base(5);
  nan.parts.stealthNative = NaN;
  assert.throws(() => sanityCheck(nan, null), /NaN/);
  const off = base(5000);
  off.totalUsd = 1;
  assert.throws(() => sanityCheck(off, null), /add up/);
});

test('rpc falls over to the next url and reports range errors', async () => {
  const hits: string[] = [];
  const f = (async (url: string, init: { body: string }) => {
    hits.push(url);
    const id = JSON.parse(init.body).id;
    if (url === 'a') return { status: 500, text: async () => '' };
    if (url === 'c') return { status: 200, text: async () => JSON.stringify({ id, error: { code: -32005, message: 'too many results' } }) };
    return { status: 200, text: async () => JSON.stringify({ id, result: '0x1' }) };
  }) as never;
  const sleep = async () => {};
  const r = new FallbackRpc(['a', 'b'], { fetchImpl: f, sleep });
  assert.equal(await r.call('eth_blockNumber', []), '0x1');
  assert.ok(hits.includes('a') && hits.includes('b'));
  const r2 = new FallbackRpc(['c'], { fetchImpl: f, sleep });
  await assert.rejects(r2.call('eth_getLogs', []), (e: unknown) => e instanceof RpcError && e.code === -32005);
});

test('rpc: a url with a small range limit falls through to the next one, all limited means a range error', async () => {
  const hits: string[] = [];
  const f = (async (url: string, init: { body: string }) => {
    hits.push(url);
    const id = JSON.parse(init.body).id;
    if (url === 'small' || url === 'small2') return { status: 200, text: async () => JSON.stringify({ id, error: { code: -32000, message: 'ranges over 10000 blocks are not supported' } }) };
    return { status: 200, text: async () => JSON.stringify({ id, result: 'big' }) };
  }) as never;
  const sleep = async () => {};
  const r = new FallbackRpc(['small', 'big'], { fetchImpl: f, sleep });
  assert.equal(await r.call('eth_getLogs', []), 'big');
  hits.length = 0;
  assert.equal(await r.call('eth_getLogs', []), 'big');
  assert.equal(hits[0], 'big'); // the url that worked is tried first
  const all = new FallbackRpc(['small', 'small2'], { fetchImpl: f, sleep });
  await assert.rejects(all.call('eth_getLogs', []), (e: unknown) => e instanceof RpcError && /ranges over/.test(e.message));
});

test('rpc: a url that needs a key is marked dead and not tried again', async () => {
  let keyed = 0;
  const f = (async (url: string, init: { body: string }) => {
    const id = JSON.parse(init.body).id;
    if (url === 'keyed') {
      keyed++;
      return { status: 200, text: async () => JSON.stringify({ id, error: { code: -32000, message: 'Archive requests require a personal token' } }) };
    }
    return { status: 200, text: async () => JSON.stringify({ id, result: 'ok' }) };
  }) as never;
  const r = new FallbackRpc(['keyed', 'free'], { fetchImpl: f, sleep: async () => {} });
  await r.call('eth_getLogs', []);
  await r.call('eth_getLogs', []);
  assert.equal(keyed, 1);
});
