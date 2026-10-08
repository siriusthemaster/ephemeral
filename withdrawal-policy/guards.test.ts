import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withdrawChecks, blocking, warnings } from './guards.ts';

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
