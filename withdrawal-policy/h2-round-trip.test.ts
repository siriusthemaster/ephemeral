// 26 Oct, bug bounty (H2): the docs say an H2 round trip is "Blocked: the payer is never a destination", but the check
// only warned when the destination was a known payer. Every known payer (payer or any of payers) now blocks, like H1.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Hex } from 'viem';
import { blocking, warnings, withdrawChecks, type GuardInput } from './guards.ts';

const PAYER = '0x3333333333333333333333333333333333333333' as Hex;
const FUNDER = '0x4444444444444444444444444444444444444444' as Hex;
const CALLER = '0x5555555555555555555555555555555555555555' as Hex;
const base: GuardInput = {
  destination: '0x6666666666666666666666666666666666666666',
  stealthAddress: '0x1111111111111111111111111111111111111111',
  walletAddress: '0x2222222222222222222222222222222222222222',
  payer: PAYER,
  payers: [CALLER, FUNDER],
  ownStealthAddresses: ['0x1111111111111111111111111111111111111111'],
  usedDestinations: [],
  historyComplete: true,
  isToken: false,
  hasGas: true,
  now: 10 * 3600_000,
};
const h2 = (g: GuardInput) => withdrawChecks(g).find((c) => c.id === 'H2')!;

test('every known payer is blocked as a destination, in any letter case, never only warned', () => {
  for (const d of [PAYER, FUNDER, CALLER, FUNDER.toUpperCase().replace('0X', '0x')]) {
    const c = withdrawChecks({ ...base, destination: d });
    assert.equal(h2({ ...base, destination: d }).level, 'block', d);
    assert.equal(blocking(c), true);
    assert.ok(!warnings(c).some((x) => x.id === 'H2'));
  }
});

test('a payer among `payers` blocks with the round trip text even while `payer` itself is unknown', () => {
  const c = h2({ ...base, payer: undefined, destination: FUNDER });
  assert.equal(c.level, 'block');
  assert.equal(c.text, 'H2: this address sent you the payment. Sending it back links both ends.');
  assert.match(h2({ ...base, payer: undefined }).text, /cannot check, payer unknown/);
});

test('control: a destination that paid nothing passes H2', () => {
  assert.equal(h2(base).level, 'ok');
});
