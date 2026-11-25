// Copied from ephemeral-client test/n15-h5-history.test.ts at commit 2d12269 (client 0.2.19-beta), the version guards.ts matches.
// Only the import path changed. Run with the rest: node --experimental-strip-types --test *.test.ts
// Bug bounty N15 (client 0.2.12-beta), reported by Rusdi on 3 Nov 2026, severity Low.
// H5 answered "pays its own gas" for a token (or unknown asset) payment while the history of past withdrawals was
// incomplete (a loader failure, or a scan of 7, 30 or 90 days): the destinations your payments went to are one of the
// linked sources it compares the gas against, so a short list made a clean answer a guess. H3 already said "history
// incomplete". Since 0.2.12 H5 warns the same way, for token-like payments only. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Hex } from 'viem';
import { H5_OWN_GAS, withdrawChecks, type GuardInput } from './guards.ts';

const S = '0x1111111111111111111111111111111111111111' as Hex;
const KEY = '0x3333333333333333333333333333333333333333' as Hex;
const PAYER = '0x4444444444444444444444444444444444444444' as Hex;
const TOKEN = '0x9999999999999999999999999999999999999999' as Hex;
const FRESH = '0x6666666666666666666666666666666666666666' as Hex;
const base: GuardInput = {
  destination: FRESH,
  stealthAddress: S,
  walletAddress: KEY,
  payer: PAYER,
  payers: [PAYER],
  payerKnown: true,
  ownStealthAddresses: [S],
  usedDestinations: [],
  historyComplete: true,
  receivedAt: 0,
  isToken: true,
  token: { hasCode: true, standardTransfer: true },
  tokenAddress: TOKEN,
  hasGas: true,
  gasFrom: [PAYER],
  now: 10 * 3600_000,
};
const h5 = (g: Partial<GuardInput>) => withdrawChecks({ ...base, ...g }).find((c) => c.id === 'H5')!;

test('N15: history incomplete (not loaded, left out, or a limited scan range) makes H5 warn, like H3', () => {
  assert.equal(h5({}).text, H5_OWN_GAS, 'control: complete history');
  for (const g of [{ historyComplete: false }, { historyComplete: undefined }, { ownPartial: true }] as Partial<GuardInput>[]) {
    const c = h5(g);
    assert.equal(c.level, 'warn', JSON.stringify(g));
    assert.match(c.text, /^H5: history incomplete\./);
    const h3 = withdrawChecks({ ...base, ...g }).find((x) => x.id === 'H3')!;
    assert.match(h3.text, /history incomplete/);
  }
});

test('N15: an unknown asset with ETH on it warns too; an ETH payment is not judged by it; a block stays a block', () => {
  assert.equal(h5({ isToken: false, token: undefined, tokenAddress: undefined, historyComplete: false }).text, H5_OWN_GAS);
  assert.equal(h5({ historyComplete: false, gasFrom: [KEY] }).level, 'block');
  assert.equal(h5({ historyComplete: false, hasGas: false }).level, 'block');
});
