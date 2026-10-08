import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buy, sell, transfer, totalTagged, totalBalance, type Ledger } from './unbroken.ts';

// Small deterministic PRNG so failures can be replayed from the seed.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const E = 10n ** 18n;

test('Claus probe: tiny buy in a fresh wallet, then tokens from a wallet that sold arrive untagged', () => {
  const l: Ledger = new Map();
  buy(l, 'A', 1_000_000n * E);
  sell(l, 'A', 1n * E); // any sell clears A's tag
  buy(l, 'B', 1n * E); // tiny buy, tagged
  transfer(l, 'A', 'B', 900_000n * E);
  assert.equal(l.get('b')!.tagged, 1n * E, 'only the tiny buy keeps Unbroken');
});

test('moving to a safer wallet costs nothing', () => {
  const l: Ledger = new Map();
  buy(l, 'A', 5_000_000n * E);
  transfer(l, 'A', 'Safe', 5_000_000n * E);
  assert.equal(l.get('safe')!.tagged, 5_000_000n * E);
  assert.equal(totalTagged(l), 5_000_000n * E);
});

test('sell, rebuy, move: only the rebought tokens keep the tag', () => {
  const l: Ledger = new Map();
  buy(l, 'A', 100n * E);
  sell(l, 'A', 50n * E);
  buy(l, 'A', 50n * E);
  transfer(l, 'A', 'Fresh', 100n * E);
  assert.equal(l.get('fresh')!.tagged, 50n * E);
});

test('property: lots of tiny transfers between mixed tagged/untagged balances never grow the tagged total', () => {
  for (let seed = 1; seed <= 200; seed++) {
    const r = rng(seed);
    const l: Ledger = new Map();
    const wallets = Array.from({ length: 8 }, (_, i) => `w${i}`);
    // mixed start: some buys (tagged), some sells (untagged leftovers)
    for (const w of wallets) {
      buy(l, w, BigInt(Math.floor(r() * 1e6) + 1) * E);
      if (r() < 0.4) sell(l, w, 1n);
    }
    let before = totalTagged(l);
    const supply = totalBalance(l);
    for (let step = 0; step < 2000; step++) {
      const from = wallets[Math.floor(r() * wallets.length)];
      const to = wallets[Math.floor(r() * wallets.length)];
      const bal = l.get(from)?.balance ?? 0n;
      if (bal === 0n) continue;
      // tiny amounts most of the time, sometimes 1 wei, sometimes everything
      const pick = r();
      const amount = pick < 0.1 ? 1n : pick < 0.15 ? bal : (bal * BigInt(Math.floor(r() * 1000))) / 100000n;
      transfer(l, from, to, amount);
      const after = totalTagged(l);
      assert.ok(after <= before, `seed ${seed} step ${step}: tagged grew from ${before} to ${after}`);
      for (const [w, v] of l) assert.ok(v.tagged <= v.balance && v.tagged >= 0n, `seed ${seed}: ${w} tagged > balance`);
      before = after;
    }
    assert.equal(totalBalance(l), supply, 'transfers never create or destroy tokens');
  }
});

test('property: splitting a wallet in many pieces and merging back never gains tags', () => {
  const r = rng(7);
  const l: Ledger = new Map();
  buy(l, 'A', 1_000_000n * E);
  sell(l, 'A', 1n); // untag A
  buy(l, 'A', 123_456n * E); // partly tagged again
  const start = totalTagged(l);
  for (let i = 0; i < 500; i++) transfer(l, 'A', `p${i % 37}`, BigInt(Math.floor(r() * 1000) + 1) * E);
  for (let i = 0; i < 37; i++) transfer(l, `p${i}`, 'A', l.get(`p${i}`)!.balance);
  assert.ok(totalTagged(l) <= start);
});
