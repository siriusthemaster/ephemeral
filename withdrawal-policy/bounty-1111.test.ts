// Bug bounty, 9 and 10 Nov. Pure, no network.
// - H5: paymentView's assetUnknown reason ('unread', 'unseen', 'nft'), passed as the README says, counts as unknown;
//   before, only `true` did and the documented composition answered "pays its own gas" (Akbar).
// - H1: registrants null (the registry could not be read) blocks, like an unknown key wallet; before, a failed read
//   reached the guard as an empty list and every registrant passed (Rusdi first, Akbar, reaper).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Hex } from 'viem';
import { paymentView } from './funding.ts';
import { blocking, withdrawChecks, type GuardInput } from './guards.ts';

const S = '0x1111111111111111111111111111111111111111' as Hex;
const KEY = '0x3333333333333333333333333333333333333333' as Hex;
const PAYER = '0x4444444444444444444444444444444444444444' as Hex;
const FRESH = '0x6666666666666666666666666666666666666666' as Hex;
const REG = '0x7777000000000000000000000000000000000077' as Hex;
const base: GuardInput = {
  destination: FRESH,
  stealthAddress: S,
  walletAddress: KEY,
  payer: PAYER,
  payers: [PAYER],
  ownStealthAddresses: [S],
  usedDestinations: [],
  historyComplete: true,
  isToken: false,
  hasGas: true,
  gasFrom: [PAYER],
  registrants: [],
  now: 10 * 3600_000,
};
const check = (id: string, g: Partial<GuardInput>) => withdrawChecks({ ...base, ...g }).find((c) => c.id === id)!;

test('Akbar 9 Nov: the view s assetUnknown, passed as it is, never lets H5 pass silently', () => {
  const view = paymentView([], undefined);
  assert.equal(view.assetUnknown, 'unread');
  assert.equal(check('H5', { assetUnknown: view.assetUnknown, hasGas: false }).level, 'block');
  assert.equal(check('H5', { assetUnknown: view.assetUnknown, hasGas: true }).level, 'warn');
  for (const reason of ['unread', 'unseen', 'nft']) {
    assert.equal(check('H5', { assetUnknown: reason, hasGas: false }).level, 'block', reason);
    // an ERC-1155 payment whose gas came from the key wallet: blocked with the linked-wallet text
    assert.match(check('H5', { assetUnknown: reason, gasFrom: [KEY] }).text, /linked wallet \(your key wallet\)/, reason);
  }
  // control: a payment whose asset was read (null) and is ETH pays its own gas
  assert.equal(check('H5', { assetUnknown: null }).level, 'ok');
  assert.equal(check('H5', { assetUnknown: false }).level, 'ok');
});

test('Rusdi 9 Nov (first), Akbar 9 Nov, reaper 10 Nov: a registry that could not be read blocks H1', () => {
  const unread = check('H1', { registrants: null });
  assert.equal(unread.level, 'block');
  assert.match(unread.text, /registry could not be read/);
  assert.equal(blocking(withdrawChecks({ ...base, registrants: null })), true);
  // controls: a read that completed decides as before
  assert.equal(check('H1', { registrants: [] }).level, 'ok');
  assert.equal(check('H1', { registrants: [REG], destination: REG }).level, 'block');
  assert.match(check('H1', { registrants: [REG], destination: REG }).text, /published your meta-address/);
  // the key wallet still blocks first, whatever the registry read
  assert.match(check('H1', { registrants: null, destination: KEY }).text, /created your stealth keys/);
});
