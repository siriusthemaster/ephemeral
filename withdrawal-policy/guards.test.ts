import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, type Hex } from 'viem';
import { withdrawChecks, blocking, warnings, destinationsFromHistory } from './guards.ts';

const base = {
  stealthAddress: '0x1111111111111111111111111111111111111111',
  walletAddress: '0x2222222222222222222222222222222222222222',
  payer: '0x3333333333333333333333333333333333333333',
  ownStealthAddresses: ['0x1111111111111111111111111111111111111111', '0x4444444444444444444444444444444444444444'],
  usedDestinations: ['0x5555555555555555555555555555555555555555'],
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
  // complete history (or the default) keeps the clean result for a fresh destination
  assert.equal(h3(withdrawChecks({ ...fresh, historyComplete: true })), 'ok');
  assert.equal(h3(withdrawChecks(fresh)), 'ok');
});
