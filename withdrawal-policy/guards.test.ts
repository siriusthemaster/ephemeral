import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, type Hex } from 'viem';
import { withdrawChecks, blocking, warnings, destinationsFromHistory, type GuardInput } from './guards.ts';

const base = {
  stealthAddress: '0x1111111111111111111111111111111111111111',
  walletAddress: '0x2222222222222222222222222222222222222222',
  payer: '0x3333333333333333333333333333333333333333',
  ownStealthAddresses: ['0x1111111111111111111111111111111111111111', '0x4444444444444444444444444444444444444444'],
  usedDestinations: ['0x5555555555555555555555555555555555555555'],
  historyComplete: true,
  receivedAt: Date.now() - 2 * 3600_000,
  isToken: false,
  hasGas: true,
  now: Date.now(),
} as const;

test('H1 blocks the key wallet', () => {
  const c = withdrawChecks({ ...base, destination: base.walletAddress, ownStealthAddresses: [...base.ownStealthAddresses], usedDestinations: [...base.usedDestinations] });
  assert.equal(blocking(c), true);
});
test('H2 warns on the payer', () => {
  const c = withdrawChecks({ ...base, destination: base.payer, ownStealthAddresses: [...base.ownStealthAddresses], usedDestinations: [...base.usedDestinations] });
  assert.equal(blocking(c), false);
  assert.equal(warnings(c)[0].id, 'H2');
});
test('H3 warns on another stealth address and on a reused destination', () => {
  for (const d of ['0x4444444444444444444444444444444444444444', '0x5555555555555555555555555555555555555555']) {
    const c = withdrawChecks({ ...base, destination: d, ownStealthAddresses: [...base.ownStealthAddresses], usedDestinations: [...base.usedDestinations] });
    assert.equal(warnings(c)[0].id, 'H3');
  }
});
test('H5 blocks a token-only payment without gas', () => {
  const c = withdrawChecks({ ...base, destination: '0x6666666666666666666666666666666666666666', isToken: true, hasGas: false, ownStealthAddresses: [...base.ownStealthAddresses], usedDestinations: [...base.usedDestinations] });
  assert.equal(blocking(c), true);
});
test('a fresh destination after an hour passes clean', () => {
  const c = withdrawChecks({ ...base, destination: '0x6666666666666666666666666666666666666666', ownStealthAddresses: [...base.ownStealthAddresses], usedDestinations: [...base.usedDestinations] });
  assert.equal(blocking(c), false);
  assert.equal(warnings(c).length, 0);
});
test('timing warns within the first hour', () => {
  const c = withdrawChecks({ ...base, destination: '0x6666666666666666666666666666666666666666', receivedAt: Date.now() - 60_000, ownStealthAddresses: [...base.ownStealthAddresses], usedDestinations: [...base.usedDestinations] });
  assert.equal(warnings(c)[0].id, 'time');
});

// ------------------------------------------------------------------ H3 across reloads (rebuilt from chain history)

const S1 = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hex; // payment A
const S2 = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hex; // payment B
const X = '0xcccccccccccccccccccccccccccccccccccccccc' as Hex; // the collector
const Y = '0xdddddddddddddddddddddddddddddddddddddddd' as Hex;
const h3 = (c: ReturnType<typeof withdrawChecks>) => c.find((x) => x.id === 'H3')!.level;
const checksFor = (stealthAddress: Hex, destination: string, usedDestinations: Hex[]) =>
  withdrawChecks({ ...base, stealthAddress, destination, ownStealthAddresses: [S1, S2], usedDestinations });

test('a reused collector stays flagged after reopening the wallet', () => {
  // session 1: payment A (S1) goes to X, which is fine the first time; the session remembers X
  let session: Hex[] = [];
  assert.equal(h3(checksFor(S1, X, session)), 'ok');
  session = [...session, X];
  assert.equal(h3(checksFor(S2, X, session)), 'warn');
  // reopen: session state is gone; without history H3 would wrongly pass
  session = [];
  assert.equal(h3(checksFor(S2, X, session)), 'ok');
  // with history rebuilt from the chain, payment B (S2) to X is flagged again
  const used = [...destinationsFromHistory([S1, S2], [{ from: S1, to: X }]), ...session];
  assert.equal(h3(checksFor(S2, X, used)), 'warn');
  assert.equal(h3(checksFor(S2, Y, used)), 'ok');
});
test('history: transfers from addresses that are not ours are ignored', () => {
  assert.deepEqual(destinationsFromHistory([S1], [{ from: base.payer, to: X }, { from: Y, to: S1 }]), []);
});
test('history: case-insensitive', () => {
  const got = destinationsFromHistory([getAddress(S1)], [
    { from: S1.toUpperCase().replace('0X', '0x'), to: getAddress(X) },
    { from: getAddress(S1), to: X },
  ]);
  assert.deepEqual(got, [X]);
  assert.equal(h3(checksFor(S2, getAddress(X), got)), 'warn');
});
test('history: transfers between our own addresses are left out', () => {
  assert.deepEqual(destinationsFromHistory([S1, S2], [{ from: S1, to: S2 }, { from: S2, to: getAddress(S1) }]), []);
});
test('history: duplicates collapse', () => {
  const got = destinationsFromHistory([S1, S2], [
    { from: S1, to: X },
    { from: S2, to: X },
    { from: S1, to: X },
    { from: S2, to: Y },
  ]);
  assert.deepEqual([...got].sort(), [X, Y]);
});
test('history incomplete: a destination is never called unused while history is loading or failed', () => {
  const fresh = { ...base, destination: Y as string, stealthAddress: S2, ownStealthAddresses: [S1, S2], usedDestinations: [] as Hex[] };
  const incomplete = withdrawChecks({ ...fresh, historyComplete: false }).find((c) => c.id === 'H3');
  assert.equal(incomplete?.level, 'warn');
  assert.match(incomplete?.text ?? '', /history incomplete/);
  // a known reuse still says so, even with incomplete history
  assert.equal(h3(withdrawChecks({ ...fresh, destination: X, usedDestinations: [X], historyComplete: false })), 'warn');
  assert.match(withdrawChecks({ ...fresh, destination: X, usedDestinations: [X], historyComplete: false }).find((c) => c.id === 'H3')!.text, /already sent/);
  // complete history keeps the clean result for a fresh destination
  assert.equal(h3(withdrawChecks({ ...fresh, historyComplete: true })), 'ok');
});
test('history completeness omitted: counts as incomplete (fail safe), H3 warns', () => {
  // the type requires historyComplete; a caller that leaves it out anyway (plain JS, a loose cast) must not get "unused"
  const { historyComplete: _, ...omitted } = { ...base, destination: Y as string, stealthAddress: S2, ownStealthAddresses: [S1, S2], usedDestinations: [] as Hex[] };
  for (const g of [omitted, { ...omitted, historyComplete: undefined }]) {
    const c = withdrawChecks(g as unknown as GuardInput);
    const h = c.find((x) => x.id === 'H3')!;
    assert.equal(h.level, 'warn');
    assert.match(h.text, /history incomplete/);
    assert.deepEqual(warnings(c).map((x) => x.id), ['H3'], 'the only warning');
    assert.equal(blocking(c), false);
  }
});

// ------------------------------------------------------------------ unspendable destinations (Toshit, C-01)

const UNSPENDABLE = [
  '0x0000000000000000000000000000000000000000', // zero address
  '0x000000000000000000000000000000000000dEaD', // burn address
  '0x55649E01B5Df198D18D95b5cc5051630cfD45564', // ERC-5564 Announcer
  '0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538', // ERC-6538 Registry
];
const fresh = { ...base, ownStealthAddresses: [...base.ownStealthAddresses], usedDestinations: [...base.usedDestinations] };

test('burn and protocol addresses are blocked, in any case, and nothing else is reported for them', () => {
  for (const addr of UNSPENDABLE) {
    for (const destination of [addr, addr.toLowerCase(), '0x' + addr.slice(2).toUpperCase(), getAddress(addr)]) {
      for (const isToken of [false, true]) {
        const c = withdrawChecks({ ...fresh, destination, isToken });
        assert.equal(blocking(c), true, destination);
        assert.deepEqual(c.map((x) => [x.id, x.level]), [['burn', 'block']], destination);
        assert.match(c[0]!.text, /lost/);
      }
    }
  }
});
test('the block message names the address', () => {
  const text = (d: string) => withdrawChecks({ ...fresh, destination: d })[0]!.text;
  assert.match(text(UNSPENDABLE[0]!), /zero address/);
  assert.match(text(UNSPENDABLE[1]!), /burn address/);
  assert.match(text(UNSPENDABLE[2]!), /ERC-5564 Announcer/);
  assert.match(text(UNSPENDABLE[3]!), /ERC-6538 Registry/);
});
test('control: addresses next to the blocked ones pass clean', () => {
  for (const d of ['0x0000000000000000000000000000000000000001', '0x000000000000000000000000000000000000deae', '0x6666666666666666666666666666666666666666']) {
    const c = withdrawChecks({ ...fresh, destination: d });
    assert.equal(blocking(c), false, d);
    assert.equal(warnings(c).length, 0, d);
  }
});

// ------------------------------------------------------------------ fail closed when the key wallet or the payer is missing

const clean = { ...fresh, destination: '0x6666666666666666666666666666666666666666' };

test('H1 fail closed: a missing key wallet blocks every destination', () => {
  for (const walletAddress of [undefined, '' as Hex, '0x2222' as Hex, 'not an address' as Hex]) {
    for (const isToken of [false, true]) {
      const c = withdrawChecks({ ...clean, walletAddress, isToken });
      const h1 = c.find((x) => x.id === 'H1')!;
      assert.equal(h1.level, 'block', String(walletAddress));
      assert.match(h1.text, /cannot check, key wallet unknown/);
      assert.equal(blocking(c), true);
    }
  }
  // left out entirely by a loose caller (plain JS, a cast): same
  const { walletAddress: _w, ...omitted } = clean;
  const c = withdrawChecks(omitted as unknown as GuardInput);
  assert.equal(c.find((x) => x.id === 'H1')!.level, 'block');
  assert.equal(blocking(c), true);
});
test('H2 fail closed: a missing payer blocks every destination, and Withdraw stays locked', () => {
  for (const payer of [undefined, '' as Hex, '0x3333' as Hex, 'not an address' as Hex]) {
    for (const isToken of [false, true]) {
      const c = withdrawChecks({ ...clean, payer, isToken });
      const h2 = c.find((x) => x.id === 'H2')!;
      assert.equal(h2.level, 'block', String(payer));
      assert.match(h2.text, /cannot check, payer unknown. Withdraw stays locked until the payer is known/);
      assert.equal(blocking(c), true);
    }
  }
  const { payer: _p, ...omitted } = clean;
  const c = withdrawChecks(omitted as unknown as GuardInput);
  assert.equal(c.find((x) => x.id === 'H2')!.level, 'block');
  assert.equal(blocking(c), true);
});
test('control: with the key wallet and the payer known, H1 and H2 behave as before', () => {
  const c = withdrawChecks(clean);
  assert.deepEqual(c.map((x) => `${x.id}:${x.level}`), ['H1:ok', 'H2:ok', 'H3:ok', 'H4:ok', 'H5:ok']);
  // any letter case of a known input counts as known
  assert.equal(blocking(withdrawChecks({ ...clean, walletAddress: getAddress(base.walletAddress), payer: base.payer.toUpperCase().replace('0X', '0x') as Hex })), false);
  // the payer itself still only warns (H2 level unchanged), the key wallet still blocks
  const back = withdrawChecks({ ...clean, destination: base.payer });
  assert.equal(back.find((x) => x.id === 'H2')!.level, 'warn');
  assert.equal(blocking(back), false);
  assert.equal(withdrawChecks({ ...clean, destination: base.walletAddress }).find((x) => x.id === 'H1')!.level, 'block');
});
