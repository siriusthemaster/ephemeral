import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buy, sell, transfer, seasoned, unbrokenBoost, balanceOf, totalSeasoned, totalWeight7, totalBalance, firstLightTokens, totalFirstLight, type Ledger } from './unbroken.ts';

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

test('Claus Lab finding (v2 split-before-sale): moving 1,000 out and selling there = selling 1,000 directly', () => {
  const direct: Ledger = new Map();
  buy(direct, 'A', 100_000n * E, 0);
  sell(direct, 'A', 1_000n * E);

  const split: Ledger = new Map();
  buy(split, 'A', 100_000n * E, 0);
  transfer(split, 'A', 'side', 1_000n * E);
  sell(split, 'side', 1_000n * E);

  for (const day of [3, 10]) {
    assert.equal(seasoned(split, 'A', day), seasoned(direct, 'A', day), `day ${day}`);
    assert.equal(totalSeasoned(split, day), totalSeasoned(direct, day));
  }
  assert.equal(unbrokenBoost(split, 'A', 10), 1); // 99,000 aged 10 days: full boost, same as a direct sale
});

test('moving to a safer wallet keeps the age of every token', () => {
  const l: Ledger = new Map();
  buy(l, 'A', 5_000n * E, 0);
  transfer(l, 'A', 'safe', 5_000n * E);
  assert.equal(seasoned(l, 'safe', 7), 5_000n * E);
  assert.equal(unbrokenBoost(l, 'safe', 7), 1);
});

test('sell then rebuy: the rebought tokens start again at day 0', () => {
  const l: Ledger = new Map();
  buy(l, 'A', 100n * E, 0);
  sell(l, 'A', 50n * E, );
  buy(l, 'A', 50n * E, 10);
  assert.equal(seasoned(l, 'A', 10), 50n * E, 'only the 50 kept since day 0 are seasoned');
  assert.equal(unbrokenBoost(l, 'A', 10), 0.5);
  assert.equal(seasoned(l, 'A', 17), 100n * E, 'the rebought half catches up after 7 days');
});

test('Claus probe: tiny buy in a fresh wallet, then tokens in from a wallet that sold: each token keeps its own age', () => {
  const l: Ledger = new Map();
  buy(l, 'A', 1_000_000n * E, 0);
  sell(l, 'A', 1n * E);
  buy(l, 'B', 1n * E, 9);
  transfer(l, 'A', 'B', 900_000n * E);
  // the moved tokens were never sold and are 9 days old; the tiny buy is new. Nothing gained from the move:
  const before = 999_999n * E + 0n; // A's seasoned total on day 9 had nothing moved
  assert.equal(totalSeasoned(l, 9), before, 'seasoned tokens neither appear nor disappear by moving them');
});

test('property: thousands of tiny transfers between mixed-age balances keep the Unbroken weight and the supply exactly', () => {
  for (let seed = 1; seed <= 150; seed++) {
    const r = rng(seed);
    const l: Ledger = new Map();
    const ws = Array.from({ length: 8 }, (_, i) => `w${i}`);
    for (const w of ws) {
      buy(l, w, BigInt(Math.floor(r() * 1e6) + 1) * E, Math.floor(r() * 10));
      if (r() < 0.5) buy(l, w, BigInt(Math.floor(r() * 1e5) + 1) * E, 10 + Math.floor(r() * 5));
      if (r() < 0.3) sell(l, w, 1n);
    }
    const today = 16;
    const supply = totalBalance(l);
    const start = totalWeight7(l, today);
    for (let step = 0; step < 1500; step++) {
      const from = ws[Math.floor(r() * ws.length)];
      const to = ws[Math.floor(r() * ws.length)];
      const bal = balanceOf(l, from);
      if (bal === 0n) continue;
      const p = r();
      const amount = p < 0.1 ? 1n : p < 0.15 ? bal : (bal * BigInt(Math.floor(r() * 1000))) / 100000n;
      transfer(l, from, to, amount);
      assert.equal(totalWeight7(l, today), start, `seed ${seed} step ${step}: moving tokens changed the Unbroken weight`);
    }
    assert.equal(totalBalance(l), supply, 'transfers never create or destroy tokens');
  }
});

test('property: splitting before a sale never beats selling directly (random amounts and ages)', () => {
  const r = rng(42);
  for (let i = 0; i < 300; i++) {
    const amt = BigInt(Math.floor(r() * 1e6) + 10) * E;
    const old = Math.floor(r() * 7);
    const sellAmt = (amt * BigInt(Math.floor(r() * 100) + 1)) / 1000n;
    const today = 7 + Math.floor(r() * 7);
    const d: Ledger = new Map();
    buy(d, 'A', amt, old);
    buy(d, 'A', amt / 3n, today - 1);
    sell(d, 'A', sellAmt);
    const s: Ledger = new Map();
    buy(s, 'A', amt, old);
    buy(s, 'A', amt / 3n, today - 1);
    transfer(s, 'A', 'x', sellAmt);
    sell(s, 'x', sellAmt);
    assert.ok(totalWeight7(s, today) <= totalWeight7(d, today), `case ${i}`);
  }
});

test('First Light follows the tokens: moving to a safer wallet keeps it, a sale removes it pro rata', () => {
  const l: Ledger = new Map();
  buy(l, 'A', 100_000n * E, 0, true); // launch hour
  buy(l, 'A', 100_000n * E, 2);
  transfer(l, 'A', 'safe', 100_000n * E); // half of each kind moves
  assert.equal(firstLightTokens(l, 'safe'), 50_000n * E);
  assert.equal(totalFirstLight(l), 100_000n * E, 'moving never creates or destroys First Light tokens');
  sell(l, 'safe', 10_000n * E);
  assert.equal(firstLightTokens(l, 'safe'), 45_000n * E);
});

test('property: random transfers never change the First Light total', () => {
  const r = rng(99);
  const l: Ledger = new Map();
  const ws = ['a', 'b', 'c', 'd'];
  for (const w of ws) {
    buy(l, w, BigInt(Math.floor(r() * 1e6) + 1) * E, 0, r() < 0.5);
    buy(l, w, BigInt(Math.floor(r() * 1e6) + 1) * E, 3);
  }
  const fl = totalFirstLight(l);
  for (let i = 0; i < 3000; i++) {
    const from = ws[Math.floor(r() * 4)];
    const bal = balanceOf(l, from);
    if (bal === 0n) continue;
    transfer(l, from, ws[Math.floor(r() * 4)], r() < 0.1 ? 1n : (bal * BigInt(Math.floor(r() * 1000))) / 1000n);
    assert.equal(totalFirstLight(l), fl);
  }
});
