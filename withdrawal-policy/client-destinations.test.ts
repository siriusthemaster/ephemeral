// Copied from ephemeral-client test/destinations.test.ts at commit 2d12269 (client 0.2.19-beta), the version guards.ts matches.
// Only the import path changed. Run with the rest: node --experimental-strip-types --test *.test.ts
// Bug bounty (Low): the list of destinations nothing comes back from had only the zero address, 0x...dEaD, the
// ERC-5564 Announcer and the ERC-6538 Registry. Since 0.2.10 it also blocks the precompiles 0x...01 to 0x...11
// (ecrecover, sha256, ripemd160, identity, modexp, the alt_bn128 ones, blake2f, the KZG point evaluation and the
// BLS12-381 ones: no code, no owner, ETH sent there stays there), and for a token withdrawal the token contract itself.
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
  payerKnown: true,
  ownStealthAddresses: ['0x1111111111111111111111111111111111111111'],
  usedDestinations: [],
  historyComplete: true,
  isToken: false,
  hasGas: true,
  gasFrom: [],
  now: 10 * 3600_000,
};
const precompile = (n: number) => `0x${n.toString(16).padStart(40, '0')}`;

test('every precompile 0x...01 to 0x...11 is blocked before any other check, lowercase and checksummed', () => {
  for (let n = 1; n <= 0x11; n++) {
    for (const d of [precompile(n), getAddress(precompile(n))]) {
      const c = withdrawChecks({ ...base, destination: d });
      assert.equal(c.length, 1, d);
      assert.equal(c[0].id, 'burn');
      assert.equal(c[0].level, 'block');
      assert.match(c[0].text, new RegExp(`^That is the precompile 0x…${n.toString(16).padStart(2, '0')}\\. Funds sent there are lost for good\\.$`));
      assert.equal(isUnspendable(d), true);
    }
  }
});

test('control: 0x...12 and above, and the old list, behave as before', () => {
  assert.equal(withdrawChecks({ ...base, destination: precompile(0x12) }).some((c) => c.id === 'burn'), false);
  // 0x…0100 is P256VERIFY (EIP-7951 on mainnet since Fusaka, RIP-7212 on L2s) and blocks since the bounty of 3 Nov;
  // its neighbours do not
  assert.equal(isUnspendable(precompile(0x100)), true);
  assert.equal(isUnspendable(precompile(0x101)), false);
  assert.equal(isUnspendable('0xfffffffffffffffffffffffffffffffffffffffe'), true);
  for (const d of ['0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dEaD', '0x55649E01B5Df198D18D95b5cc5051630cfD45564', '0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538'])
    assert.equal(withdrawChecks({ ...base, destination: d })[0].id, 'burn', d);
});

test('a token withdrawal to the token contract itself is blocked, in any letter case', () => {
  for (const d of [TOKEN, TOKEN.toUpperCase().replace('0X', '0x'), getAddress(TOKEN)]) {
    const c = withdrawChecks({ ...base, isToken: true, token: { hasCode: true, standardTransfer: true }, tokenAddress: TOKEN, destination: d });
    assert.deepEqual(
      c.map((x) => [x.id, x.level]),
      [['burn', 'block']],
      d,
    );
    assert.equal(c[0].text, 'That is the token contract itself. Tokens sent there are lost for good.');
  }
  // any other destination for that token passes this check
  const ok = withdrawChecks({ ...base, isToken: true, token: { hasCode: true, standardTransfer: true }, tokenAddress: TOKEN });
  assert.ok(!ok.some((c) => c.id === 'burn'));
  // an ETH withdrawal is not a token withdrawal: the token rule does not apply
  assert.ok(!withdrawChecks({ ...base, tokenAddress: TOKEN, destination: TOKEN }).some((c) => c.id === 'burn'));
});
