import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buy, sell, transfer, move, classify, attestationValid, ownersHash, reclassify, seasoned, unbrokenBoost, balanceOf, totalSeasoned, totalWeight7, totalBalance, firstLightTokens, totalFirstLight, weight7, type AddressInfo, type Attestation, type Ledger, type Kind } from './unbroken.ts';

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

// v3.1, Claus Lab probe (9 Oct): NFT minting and redemption. A vault that holds tokens for many people is one address,
// so a plain transfer would hand out its tokens' ages pro rata: deposit fresh tokens next to aged ones, redeem, and
// walk away with aged tokens. In v3.1 a shared contract is treated like the pool.
const SHARED = new Set(['vault', 'staking', 'cex']);
const kindOf = (a: string): Kind => (SHARED.has(a) ? 'shared' : 'wallet');

test('Claus Lab probe (NFT mint and redeem through a shared vault): fresh tokens deposited next to aged ones come out fresh', () => {
  const l: Ledger = new Map();
  buy(l, 'A', 1_000_000n * E, 0, true); // launch-hour buyer
  move(l, 'A', 'vault', 1_000_000n * E, 8, kindOf); // A mints vault NFTs with aged First Light tokens
  buy(l, 'B', 100_000n * E, 8); // B buys fresh
  move(l, 'B', 'vault', 100_000n * E, 8, kindOf); // B mints...
  move(l, 'vault', 'B', 100_000n * E, 8, kindOf); // ...and redeems right away
  assert.equal(seasoned(l, 'B', 8), 0n);
  assert.equal(firstLightTokens(l, 'B'), 0n);
  assert.equal(seasoned(l, 'B', 15), 100_000n * E); // the normal 7-day ramp, nothing borrowed from A
  // the cost of shared custody: A's redeemed tokens start again at day 0 and lose First Light
  move(l, 'vault', 'A', 1_000_000n * E, 9, kindOf);
  assert.equal(seasoned(l, 'A', 9), 0n);
  assert.equal(firstLightTokens(l, 'A'), 0n);
});

test('a wallet (v3.2: an EOA, a 7702 account, or a Safe / 4337 account with a valid attestation) keeps age and First Light', () => {
  const l: Ledger = new Map();
  buy(l, 'A', 50_000n * E, 0, true);
  move(l, 'A', 'safeOfA', 50_000n * E, 5, kindOf);
  assert.equal(seasoned(l, 'safeOfA', 7), 50_000n * E);
  assert.equal(firstLightTokens(l, 'safeOfA'), 50_000n * E);
});

test('property: no sequence of moves through shared contracts raises the Unbroken weight or the First Light total', () => {
  const r = rng(91);
  const l: Ledger = new Map();
  const wallets = ['a', 'b', 'c', 'd', 'e'];
  const held = new Map<string, bigint>([...SHARED].map((s) => [s, 0n]));
  for (const w of wallets) buy(l, w, BigInt(1 + Math.floor(r() * 1e6)) * E, Math.floor(r() * 5), r() < 0.5);
  let day = 6;
  for (let i = 0; i < 4_000; i++) {
    if (r() < 0.01) day++;
    const w = wallets[Math.floor(r() * wallets.length)];
    const s = [...SHARED][Math.floor(r() * SHARED.size)];
    const w7 = totalWeight7(l, day);
    const fl = totalFirstLight(l);
    const op = r();
    if (op < 0.4) {
      const amt = (balanceOf(l, w) * BigInt(Math.floor(r() * 1000))) / 1000n;
      move(l, w, s, amt, day, kindOf);
      held.set(s, held.get(s)! + amt);
    } else if (op < 0.8) {
      const amt = (held.get(s)! * BigInt(Math.floor(r() * 1000))) / 1000n;
      move(l, s, w, amt, day, kindOf);
      held.set(s, held.get(s)! - amt);
    } else {
      const to = wallets[Math.floor(r() * wallets.length)];
      move(l, w, to, (balanceOf(l, w) * BigInt(Math.floor(r() * 1000))) / 1000n, day, kindOf);
      assert.equal(totalWeight7(l, day), w7); // wallet to wallet: exactly neutral
    }
    assert.ok(totalWeight7(l, day) <= w7, `step ${i}: weight rose`);
    assert.ok(totalFirstLight(l) <= fl, `step ${i}: First Light rose`);
  }
});

// v3.2, Claus Lab (9 Oct): "a Safe can hold customer deposits with withdrawal claims; signer control doesn't make
// those gifts." A Safe or 4337 account is shared by default; only an attestation by every owner makes it a wallet.
const attest = (owners: string[], threshold: number, signedAt: number, signedBy = owners): Attestation => ({
  owners, threshold, ownersHash: ownersHash(owners, threshold), signedBy, signedAt,
});
const safeOf = (owners: string[], threshold: number, ownersChangedAt: number, attestation?: Attestation): AddressInfo => ({
  hasCode: true, is7702: false, ownersHash: ownersHash(owners, threshold), ownersChangedAt, attestation,
});
const EOA: AddressInfo = { hasCode: false, is7702: false };

test('v3.2: a custodial Safe is shared, fresh tokens deposited next to customers\' aged ones come out fresh', () => {
  const info: Record<string, AddressInfo> = {
    custodySafe: safeOf(['operator'], 1, 0), // no attestation
    mySafe: safeOf(['bob'], 1, 0, attest(['bob'], 1, 1)),
    delegated: { hasCode: true, is7702: true },
  };
  const kind = (a: string) => classify(info[a] ?? EOA);
  assert.equal(kind('custodySafe'), 'shared');
  assert.equal(kind('mySafe'), 'wallet');
  assert.equal(kind('delegated'), 'wallet');
  assert.equal(kind('alice'), 'wallet');

  const l: Ledger = new Map();
  buy(l, 'customer', 1_000_000n * E, 0, true);
  move(l, 'customer', 'custodySafe', 1_000_000n * E, 8, kind); // customer deposits aged First Light tokens
  buy(l, 'operator', 100_000n * E, 8);
  move(l, 'operator', 'custodySafe', 100_000n * E, 8, kind);
  move(l, 'custodySafe', 'operator', 100_000n * E, 8, kind); // the signer pulls tokens back out
  assert.equal(seasoned(l, 'operator', 8), 0n);
  assert.equal(firstLightTokens(l, 'operator'), 0n);

  buy(l, 'bob', 50_000n * E, 0, true);
  move(l, 'bob', 'mySafe', 50_000n * E, 5, kind); // an attested, self-owned Safe keeps age and First Light
  assert.equal(seasoned(l, 'mySafe', 7), 50_000n * E);
  assert.equal(firstLightTokens(l, 'mySafe'), 50_000n * E);
});

// Claus Lab (9 Oct): "an attestation isn't proof of beneficial ownership; a custodian can sign it or use an EOA/7702
// too. Test false attestations and owner changes after signing."
test('v3.2 attestationValid: bound to the exact owner set and threshold at signing; any change voids it for good', () => {
  const a = attest(['bob', 'carol'], 2, 10);
  assert.equal(attestationValid(safeOf(['bob', 'carol'], 2, 3, a)), true);
  assert.equal(attestationValid(safeOf(['Carol', 'BOB'], 2, 3, a)), true, 'order and case do not matter');
  assert.equal(attestationValid(safeOf(['bob', 'carol'], 2, 3, attest(['bob', 'carol'], 2, 10, ['bob']))), false, 'every owner must sign');
  assert.equal(attestationValid(safeOf(['bob', 'carol'], 2, 3)), false, 'no attestation');
  assert.equal(attestationValid({ ...safeOf(['bob', 'carol'], 2, 3, a), ownersHash: undefined }), false, 'owner set unknown');
  assert.equal(attestationValid(safeOf(['bob', 'carol'], 2, 3, { ...a, ownersHash: ownersHash(['bob'], 1) })), false, 'claimed hash must match its own owners');
  assert.equal(attestationValid(safeOf(['bob', 'carol'], 2, 3, { ...a, threshold: 3 })), false, 'impossible threshold');
  // after signing:
  assert.equal(attestationValid(safeOf(['bob', 'carol', 'custodian'], 2, 12, a)), false, 'owner added');
  assert.equal(attestationValid(safeOf(['bob'], 1, 12, a)), false, 'owner removed');
  assert.equal(attestationValid(safeOf(['bob', 'custodian'], 2, 12, a)), false, 'owner swapped');
  assert.equal(attestationValid(safeOf(['bob', 'carol'], 1, 12, a)), false, 'threshold changed');
  assert.equal(attestationValid(safeOf(['bob', 'carol'], 2, 14, a)), false, 'changed and changed back (A -> A+custodian -> A): still void');
  assert.equal(attestationValid(safeOf(['bob', 'carol'], 2, 14, attest(['bob', 'carol'], 2, 15))), true, 'a new attestation after the change');
  for (const i of [safeOf(['bob', 'carol'], 1, 12, a), safeOf(['bob', 'carol'], 2, 14, a)]) assert.equal(classify(i), 'shared');
});

test('Claus probe (owner change after signing): the Safe is shared from that point, tokens leaving it start at day 0', () => {
  const info: Record<string, AddressInfo> = { bobSafe: safeOf(['bob'], 1, 0, attest(['bob'], 1, 1)) };
  const kind = (a: string) => classify(info[a] ?? EOA);
  const l: Ledger = new Map();
  buy(l, 'bob', 50_000n * E, 0, true); // launch hour
  move(l, 'bob', 'bobSafe', 50_000n * E, 2, kind);
  assert.equal(kind('bobSafe'), 'wallet');
  assert.equal(seasoned(l, 'bobSafe', 7), 50_000n * E, 'attested: a wallet, ages and First Light kept');
  const w7 = totalWeight7(l, 7);

  // Day 7: a custodian is added as an owner. The attestation no longer matches the owner set: shared from now on.
  info.bobSafe = safeOf(['bob', 'custodian'], 1, 7, info.bobSafe.attestation);
  assert.equal(kind('bobSafe'), 'shared');
  reclassify(l, 'bobSafe', 'wallet', 'shared', 50_000n * E, 7); // like a deposit into a shared contract
  assert.equal(balanceOf(l, 'bobSafe'), 0n);
  assert.equal(totalWeight7(l, 7), w7 - 7n * 50_000n * E, 'the ages inside end');
  assert.equal(totalFirstLight(l), 0n);

  move(l, 'bobSafe', 'bob', 20_000n * E, 7, kind); // tokens leaving: dated day 7, no First Light
  assert.equal(seasoned(l, 'bob', 7), 0n);
  assert.equal(seasoned(l, 'bob', 14), 20_000n * E, 'the normal 7-day ramp');
  assert.equal(firstLightTokens(l, 'bob'), 0n);
  move(l, 'bob', 'bobSafe', 1_000n * E, 8, kind); // going back in is a deposit into a shared contract
  assert.equal(balanceOf(l, 'bobSafe'), 0n);

  // Day 9: the custodian is removed again. Same owner set as at signing, but it changed after: still shared.
  info.bobSafe = safeOf(['bob'], 1, 9, info.bobSafe.attestation);
  assert.equal(kind('bobSafe'), 'shared');
  // Day 10: bob attests again. A wallet from now on; the 31,000 inside are dated day 10, without First Light.
  info.bobSafe = safeOf(['bob'], 1, 9, attest(['bob'], 1, 10));
  assert.equal(kind('bobSafe'), 'wallet');
  reclassify(l, 'bobSafe', 'shared', 'wallet', 31_000n * E, 10);
  assert.equal(seasoned(l, 'bobSafe', 10), 0n);
  assert.equal(seasoned(l, 'bobSafe', 17), 31_000n * E);
  assert.equal(firstLightTokens(l, 'bobSafe'), 0n);
});

// A false attestation: the custodian of a Safe that holds customer deposits signs "held only for myself". The signers
// ARE the owners, so the attestation is valid, and nothing on chain tells it apart from an honest one. The same holds for
// a custodian that simply uses an EOA or an EIP-7702 account: the indexer sees one key, a wallet. Bound, tested below:
// - no Unbroken weight and no First Light is ever created (both totals never rise);
// - every token leaving the custodian carries ages that were inside it at that moment (pro rata): it can only mix ages
//   its customers put in;
// - deposits and withdrawals leave the combined weight of the custodian and its customers unchanged, so in total the
//   ledger is exactly what it would be had the customers kept their tokens in their own wallets. What the false
//   attestation gets around is v3.1's reset, for the ages inside that custodian, and that is the whole damage.
test('property: a false attestation (or an EOA / 7702 custodian) only mixes ages already inside that custodian', () => {
  const honestSafe = safeOf(['bob'], 1, 0, attest(['bob'], 1, 1));
  const falseSafe = safeOf(['custodian'], 1, 0, attest(['custodian'], 1, 1)); // holds customers' tokens, signs anyway
  assert.deepEqual(Object.keys(falseSafe).sort(), Object.keys(honestSafe).sort());
  assert.equal(attestationValid(falseSafe), true, 'valid: the signers are the owners; beneficial ownership is not on chain');
  const custodians: [string, AddressInfo][] = [
    ['falseSafe', falseSafe],
    ['eoaCustodian', EOA],
    ['custodian7702', { hasCode: true, is7702: true }],
  ];
  const customers = ['c0', 'c1', 'c2', 'c3', 'c4'];
  const outsiders = ['o0', 'o1', 'o2'];
  const sum = (l: Ledger, ws: string[], day: number) => ws.reduce((s, w) => s + weight7(l, w, day), 0n);
  for (const [cust, info] of custodians) {
    assert.equal(classify(info), 'wallet', `${cust}: the indexer sees a wallet`);
    for (let seed = 1; seed <= 25; seed++) {
      const r = rng(seed * 7 + cust.length);
      const asSeen = (a: string): Kind => (a === cust ? classify(info) : 'wallet');
      const honest = (a: string): Kind => (a === cust ? 'shared' : 'wallet'); // what it really is
      const L: Ledger = new Map(); // what the indexer computes
      const H: Ledger = new Map(); // what an honest classification would give
      const N: Ledger = new Map(); // the customers never deposit at all
      for (const w of [...customers, ...outsiders]) {
        const amt = BigInt(1 + Math.floor(r() * 1e6)) * E;
        const d = Math.floor(r() * 6);
        const f = r() < 0.4;
        for (const x of [L, H, N]) buy(x, w, amt, d, f);
      }
      let held = 0n; // the custodian's real $EPH balance
      let day = 6;
      const inside = [cust, ...customers];
      for (let i = 0; i < 300; i++) {
        if (r() < 0.03) day++;
        const op = r();
        const w7 = totalWeight7(L, day);
        const fl0 = totalFirstLight(L);
        const group = sum(L, inside, day);
        if (op < 0.35) {
          const c = customers[Math.floor(r() * customers.length)];
          const amt = (balanceOf(L, c) * BigInt(Math.floor(r() * 1000))) / 1000n;
          move(L, c, cust, amt, day, asSeen);
          move(H, c, cust, amt, day, honest);
          held += amt;
          assert.equal(sum(L, inside, day), group, 'deposits only move weight inside the group');
        } else if (op < 0.7) {
          const c = customers[Math.floor(r() * customers.length)]; // the custodian pays out to whom it likes
          const amt = (held * BigInt(Math.floor(r() * 1000))) / 1000n;
          const before = new Map(L.get(cust.toLowerCase()) ?? []);
          move(L, cust, c, amt, day, asSeen);
          move(H, cust, c, amt, day, honest);
          held -= amt;
          const after = L.get(cust.toLowerCase()) ?? new Map<number, bigint>();
          let out = 0n;
          for (const [k, a] of before) {
            const moved = a - (after.get(k) ?? 0n);
            assert.ok(moved >= 0n, 'nothing comes out that was not inside');
            out += moved;
          }
          for (const k of after.keys()) assert.ok(before.has(k), 'no new ages appear inside');
          assert.equal(out, amt);
          assert.equal(sum(L, inside, day), group, 'withdrawals only move weight inside the group');
        } else {
          const o = outsiders[Math.floor(r() * outsiders.length)];
          const p = r();
          if (p < 0.5) {
            const to = outsiders[Math.floor(r() * outsiders.length)];
            const amt = (balanceOf(L, o) * BigInt(Math.floor(r() * 1000))) / 1000n;
            for (const x of [L, H, N]) transfer(x, o, to, amt);
          } else if (p < 0.8) {
            const amt = (balanceOf(L, o) * BigInt(Math.floor(r() * 500))) / 1000n;
            for (const x of [L, H, N]) sell(x, o, amt);
          } else {
            const amt = BigInt(1 + Math.floor(r() * 1e5)) * E;
            for (const x of [L, H, N]) buy(x, o, amt, day);
          }
        }
        assert.ok(totalWeight7(L, day) <= w7, `${cust} seed ${seed} step ${i}: Unbroken weight rose`);
        assert.ok(totalFirstLight(L) <= fl0, `${cust} seed ${seed} step ${i}: First Light rose`);
        assert.equal(totalWeight7(L, day), totalWeight7(N, day), 'in total, as if the customers had never deposited');
        assert.equal(totalFirstLight(L), totalFirstLight(N));
        assert.ok(totalWeight7(L, day) >= totalWeight7(H, day), 'the damage: ages the honest rule would have ended');
        assert.equal(balanceOf(L, cust), held, 'as a wallet, the ledger tracks the custodian like any wallet');
      }
      assert.ok(totalWeight7(L, day) > totalWeight7(H, day), 'and it is real: the false attestation keeps ages alive');
    }
  }
});
