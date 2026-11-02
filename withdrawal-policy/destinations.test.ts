// 31 Oct, bug bounty (Low): the destinations nothing comes back from were only the zero address, 0x...dEaD, the
// Announcer and the Registry. The precompiles 0x...01 to 0x...11 are blocked too, and for a token withdrawal the token
// contract itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, type Hex } from 'viem';
import { isUnspendable, withdrawChecks, type GuardInput } from './guards.ts';

const TOKEN = '0x9999999999999999999999999999999999999999' as Hex;
const base: GuardInput = {
  destination: '0x6666666666666666666666666666666666666666',
  stealthAddress: '0x1111111111111111111111111111111111111111',
  walletAddress: '0x2222222222222222222222222222222222222222',
  payer: '0x3333333333333333333333333333333333333333',
  ownStealthAddresses: ['0x1111111111111111111111111111111111111111'],
  usedDestinations: [],
  historyComplete: true,
  isToken: false,
  hasGas: true,
  now: 10 * 3600_000,
};
const precompile = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

test('every precompile 0x...01 to 0x...11 is blocked before any other check, lowercase and checksummed', () => {
  for (let n = 1; n <= 0x11; n++)
    for (const d of [precompile(n), getAddress(precompile(n))]) {
      const c = withdrawChecks({ ...base, destination: d });
      assert.deepEqual(c.map((x) => `${x.id}:${x.level}`), ['burn:block'], d);
      assert.equal(isUnspendable(d), true);
    }
});

test('control: 0x...12 is a normal destination', () => {
  assert.ok(!withdrawChecks({ ...base, destination: precompile(0x12) }).some((c) => c.id === 'burn'));
});

test('a token withdrawal to the token contract itself is blocked; an ETH withdrawal there is not judged by this rule', () => {
  for (const d of [TOKEN, getAddress(TOKEN)]) {
    const c = withdrawChecks({ ...base, isToken: true, tokenAddress: TOKEN, destination: d });
    assert.deepEqual(c.map((x) => `${x.id}:${x.level}`), ['burn:block']);
    assert.equal(c[0]?.text, 'That is the token contract itself. Tokens sent there are lost for good.');
  }
  assert.ok(!withdrawChecks({ ...base, isToken: true, tokenAddress: TOKEN }).some((c) => c.id === 'burn'));
  assert.ok(!withdrawChecks({ ...base, tokenAddress: TOKEN, destination: TOKEN }).some((c) => c.id === 'burn'));
});
