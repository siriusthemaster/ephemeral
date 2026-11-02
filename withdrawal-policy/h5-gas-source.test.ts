// 31 Oct, bug bounty (H5): for a token payment the gas check passed as soon as the stealth address held any ETH
// ("H5: pays its own gas."), even when that ETH had been sent by the key wallet or another address linked to the user.
// The senders of that ETH are now read from the chain (funding.ts gasSenders) and compared with every linked wallet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Hex } from 'viem';
import { gasSenders, readFunding, type FundingReader, type FundLog } from './funding.ts';
import { blocking, withdrawChecks, type GuardInput } from './guards.ts';

const S = '0x1111111111111111111111111111111111111111' as Hex;
const OTHER = '0x2222222222222222222222222222222222222222' as Hex;
const KEY = '0x3333333333333333333333333333333333333333' as Hex;
const PAYER = '0x4444444444444444444444444444444444444444' as Hex;
const USED = '0x5555555555555555555555555555555555555555' as Hex;
const FRESH = '0x6666666666666666666666666666666666666666' as Hex;
const OTHER_PAYER = '0x7777777777777777777777777777777777777777' as Hex;
const TOKEN = '0x9999999999999999999999999999999999999999' as Hex;
const SB = '0xabababababababababababababababababababab' as Hex;
const OWN_GAS = 'H5: pays its own gas.';
const base: GuardInput = {
  destination: FRESH,
  stealthAddress: S,
  walletAddress: KEY,
  payer: PAYER,
  payers: [PAYER],
  ownStealthAddresses: [S, OTHER],
  usedDestinations: [USED],
  historyComplete: true,
  isToken: true,
  hasGas: true,
  gasFrom: [PAYER],
  otherPayers: [OTHER_PAYER],
  tokenAddress: TOKEN,
  now: 10 * 3600_000,
};
const h5 = (g: Partial<GuardInput>) => withdrawChecks({ ...base, ...g }).find((c) => c.id === 'H5')!;

test('control: gas from the payer (or only with the payment) passes', () => {
  assert.equal(h5({}).text, OWN_GAS);
  assert.equal(h5({ gasFrom: [] }).text, OWN_GAS);
});

test('the report: gas from the key wallet, another stealth address of yours or a past destination blocks', () => {
  assert.match(h5({ gasFrom: [KEY] }).text, /^H5: the ETH for gas on this payment came from a linked wallet \(your key wallet\)/);
  assert.match(h5({ gasFrom: [OTHER] }).text, /\(another of your payment addresses\)/);
  assert.match(h5({ gasFrom: [USED] }).text, /\(an address your payments were withdrawn to\)/);
  for (const g of [KEY, OTHER, USED]) {
    assert.equal(h5({ gasFrom: [PAYER, g] }).level, 'block');
    assert.equal(blocking(withdrawChecks({ ...base, gasFrom: [g] })), true);
  }
});

test('gas from the payer of another payment warns, unless it also paid this one; a source not read warns', () => {
  assert.equal(h5({ gasFrom: [OTHER_PAYER] }).level, 'warn');
  assert.equal(h5({ gasFrom: [OTHER_PAYER], payers: [PAYER, OTHER_PAYER] }).text, OWN_GAS);
  for (const gasFrom of [undefined, null]) assert.match(h5({ gasFrom }).text, /could not be read from the chain/);
});

test('asset unknown counts as a token payment; an ETH payment is not judged by gas sources', () => {
  assert.equal(h5({ isToken: false, assetUnknown: true, gasFrom: [KEY] }).level, 'block');
  assert.equal(h5({ isToken: false, gasFrom: [KEY] }).text, OWN_GAS);
});

const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const pad = (a: string) => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}`;
const h = (n: number) => `0x${n.toString(16).padStart(64, '0')}` as Hex;
type Tx = { from: Hex; to: Hex | null; value: bigint; block: bigint };
function chain(txs: Record<string, Tx>, eth: { tx: Hex; from: Hex; value: bigint; internal: boolean }[], logs: FundLog[]): FundingReader {
  const balance = eth.reduce((s, e) => s + e.value, 0n);
  return {
    head: async () => 1_000n,
    balance: async () => balance,
    nonce: async () => 0,
    getLogs: async ({ topics }) => (topics[0] === TRANSFER ? logs : []),
    tx: async (hash) => {
      const t = txs[hash];
      return t ? { from: t.from, to: t.to, value: t.value, blockNumber: t.block } : null;
    },
    succeeded: async (hash) => (txs[hash] ? true : null),
    blockTxs: async () => [],
    tokenBalance: async () => 5n,
    explorer: async () => eth.map((e) => ({ ...e })),
  };
}

test('gasSenders: a gas tip in the token payment transaction is part of the payment; a separate top-up is not', async () => {
  const BUY = h(1);
  const TOPUP = h(2);
  const txs: Record<string, Tx> = {
    [BUY]: { from: KEY, to: SB, value: 1_000n, block: 100n },
    [h(9)]: { from: KEY, to: SB, value: 0n, block: 100n },
    [TOPUP]: { from: KEY, to: S, value: 7n, block: 200n },
  };
  const log: FundLog = { address: TOKEN, topics: [TRANSFER, pad(SB), pad(S)], data: `0x${(5n).toString(16).padStart(64, '0')}`, blockNumber: 100n, transactionHash: BUY, logIndex: 1 };
  const q = { address: S, announcements: [{ txHash: h(9), caller: SB, blockNumber: 100n }] };
  const tip = { tx: BUY, from: SB, value: 3n, internal: true };
  const f1 = (await readFunding(chain(txs, [tip], [log]), [q], { startBlock: 0n }))[S.toLowerCase()]!;
  assert.equal(f1.payersKnown, true, String(f1.gap));
  assert.deepEqual(gasSenders(f1), []);
  const f2 = (await readFunding(chain(txs, [tip, { tx: TOPUP, from: KEY, value: 7n, internal: false }], [log]), [q], { startBlock: 0n }))[S.toLowerCase()]!;
  assert.deepEqual(gasSenders(f2), [KEY.toLowerCase()]);
  assert.equal(h5({ payers: f2.payers, gasFrom: gasSenders(f2), otherPayers: [] }).level, 'block');
  assert.equal(gasSenders(undefined), null);
});
