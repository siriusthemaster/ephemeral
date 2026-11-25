// Copied from ephemeral-client test/guards.test.ts at commit 2d12269 (client 0.2.19-beta), the version guards.ts matches.
// Only the import path changed. Run with the rest: node --experimental-strip-types --test *.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getAddress, type Hex } from 'viem';
import {
  withdrawChecks,
  blocking,
  warnings,
  destinationsFromHistory,
  DEFAULT_POLICY,
  POLICY,
  type GuardInput,
} from './guards.ts';

const WALLET = '0x2222222222222222222222222222222222222222' as Hex; // key wallet = registrant in this client
const PAYER = '0x3333333333333333333333333333333333333333' as Hex; // sender of the announcement transaction
const CALLER = '0x7777777777777777777777777777777777777777' as Hex; // announcement caller (e.g. a router), also a payer
const FRESH = '0x6666666666666666666666666666666666666666' as Hex;

const base: GuardInput = {
  destination: FRESH,
  stealthAddress: '0x1111111111111111111111111111111111111111',
  walletAddress: WALLET,
  payer: PAYER,
  payers: [CALLER],
  payerKnown: true,
  ownStealthAddresses: ['0x1111111111111111111111111111111111111111', '0x4444444444444444444444444444444444444444'],
  usedDestinations: ['0x5555555555555555555555555555555555555555'],
  historyComplete: true,
  receivedAt: Date.now() - 2 * 3600_000,
  isToken: false,
  hasGas: true,
  now: Date.now(),
};
const level = (c: ReturnType<typeof withdrawChecks>, id: string) => c.find((x) => x.id === id)?.level;
// the same address as the user might paste it: lowercase, checksummed, with spaces around
const variants = (a: Hex) => [a, a.toLowerCase(), getAddress(a), `  ${a}  `];

// ------------------------------------------------------------------ D5: closed by default (H1 and H2 block)

test('the client default policy blocks the payer (H2) and has no switch for H1', () => {
  assert.equal(DEFAULT_POLICY.H2, 'block');
  assert.deepEqual(
    POLICY.filter((p) => p.level === 'block').map((p) => p.id),
    ['H1', 'H2', 'H5'],
  );
});

test('H1 blocks the key wallet (registrant) in every spelling, and Withdraw stays locked', () => {
  for (const d of variants(WALLET)) {
    const c = withdrawChecks({ ...base, destination: d });
    assert.equal(level(c, 'H1'), 'block', d);
    assert.equal(blocking(c), true, d);
  }
});

test('H1 blocks a wallet that published this meta-address in the registry', () => {
  const REG = '0x8888888888888888888888888888888888888888' as Hex;
  const c = withdrawChecks({ ...base, destination: getAddress(REG), registrants: [REG] });
  assert.equal(level(c, 'H1'), 'block');
  assert.match(c.find((x) => x.id === 'H1')!.text, /registry/);
});

test('H1 fail safe: an unknown key wallet blocks every destination', () => {
  for (const walletAddress of [undefined, '' as Hex, '0x123' as Hex]) {
    const c = withdrawChecks({ ...base, walletAddress });
    assert.equal(level(c, 'H1'), 'block');
    assert.equal(blocking(c), true);
  }
});

test('H2 blocks the payer by default: the transaction sender and the announcement caller', () => {
  for (const d of [...variants(PAYER), ...variants(CALLER)]) {
    const c = withdrawChecks({ ...base, destination: d });
    assert.equal(level(c, 'H2'), 'block', d);
    assert.equal(blocking(c), true, d);
  }
  // older callers that only pass `payer`
  const { payers: _p, ...old } = base;
  assert.equal(level(withdrawChecks({ ...old, destination: PAYER }), 'H2'), 'block');
});

test('H2 fail safe: while the payer is unknown (loading, failed or left out), nothing can be withdrawn', () => {
  const { payerKnown: _k, ...omitted } = base;
  for (const g of [
    { ...base, payerKnown: false },
    { ...base, payer: undefined, payers: [], payerKnown: false },
    omitted as GuardInput,
  ]) {
    const c = withdrawChecks(g);
    assert.equal(level(c, 'H2'), 'block');
    assert.match(c.find((x) => x.id === 'H2')!.text, /still reading who paid/);
    assert.equal(blocking(c), true);
  }
  // a payer already known to match is named as such, even before the lookup finished
  const c = withdrawChecks({ ...base, destination: CALLER, payer: undefined, payerKnown: false });
  assert.match(c.find((x) => x.id === 'H2')!.text, /this address paid you/);
});

test('H2 has no setting since 0.2.10: a known payer blocks by default and under a relaxed policy alike', () => {
  const c = withdrawChecks({ ...base, destination: PAYER }, { H2: 'warn' });
  assert.equal(level(c, 'H2'), 'block');
  assert.equal(blocking(c), true);
  assert.equal(level(withdrawChecks({ ...base, destination: PAYER }), 'H2'), 'block');
});

test('no input combination unlocks a withdrawal to the key wallet or the payer', () => {
  const flags = [true, false];
  for (const historyComplete of flags)
    for (const isToken of flags)
      for (const hasGas of flags)
        for (const payerKnown of flags)
          for (const old of flags)
            for (const d of [WALLET, PAYER, CALLER]) {
              const g: GuardInput = {
                ...base,
                destination: d,
                historyComplete,
                isToken,
                hasGas,
                payerKnown,
                usedDestinations: [],
                receivedAt: old ? Date.now() - 86400_000 : undefined,
              };
              assert.equal(blocking(withdrawChecks(g)), true, `${d} ${JSON.stringify({ historyComplete, isToken, hasGas, payerKnown, old })}`);
            }
});

// ------------------------------------------------------------------ the other checks, as designed

test('a fresh destination after an hour passes clean: every check ok, no block, no warning', () => {
  const c = withdrawChecks(base);
  assert.equal(blocking(c), false);
  assert.equal(warnings(c).length, 0);
  assert.deepEqual(c.map((x) => `${x.id}:${x.level}`), ['H1:ok', 'H2:ok', 'H3:ok', 'H4:ok', 'H5:ok']);
});
test('invalid, zero and self destinations are blocked', () => {
  assert.equal(withdrawChecks({ ...base, destination: 'not an address' })[0].id, 'addr');
  // a mixed-case address with a wrong checksum is treated as a typo
  assert.equal(withdrawChecks({ ...base, destination: '0x6666666666666666666666666666666666666666'.replace('0x66', '0xA6').replace('66', 'aB') })[0].level, 'block');
  assert.equal(level(withdrawChecks({ ...base, destination: '0x0000000000000000000000000000000000000000' }), 'burn'), 'block');
  assert.equal(level(withdrawChecks({ ...base, destination: base.stealthAddress }), 'self'), 'block');
});
test('H3 warns on another stealth address and on a reused destination', () => {
  for (const d of ['0x4444444444444444444444444444444444444444', '0x5555555555555555555555555555555555555555']) {
    const c = withdrawChecks({ ...base, destination: d });
    assert.equal(level(c, 'H3'), 'warn');
    assert.equal(blocking(c), false);
  }
});
test('H4 is always the network standard fee', () => {
  assert.equal(level(withdrawChecks(base), 'H4'), 'ok');
});
test('H5 blocks a token-only payment without gas, and passes one that carries its gas', () => {
  assert.equal(level(withdrawChecks({ ...base, isToken: true, hasGas: false }), 'H5'), 'block');
  assert.equal(blocking(withdrawChecks({ ...base, isToken: true, hasGas: false })), true);
  // since 0.2.10 the gas must also be read as not coming from a linked wallet (here: it came with the payment only)
  assert.equal(level(withdrawChecks({ ...base, isToken: true, hasGas: true, gasFrom: [] }), 'H5'), 'ok');
  assert.equal(level(withdrawChecks({ ...base, isToken: true, hasGas: true }), 'H5'), 'warn', 'gas source not read');
});
test('timing warns within the first hour', () => {
  const c = withdrawChecks({ ...base, receivedAt: Date.now() - 60_000 });
  assert.deepEqual(warnings(c).map((x) => x.id), ['time']);
  assert.equal(blocking(c), false);
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
  let session: Hex[] = [];
  assert.equal(h3(checksFor(S1, X, session)), 'ok');
  session = [...session, X];
  assert.equal(h3(checksFor(S2, X, session)), 'warn');
  session = [];
  assert.equal(h3(checksFor(S2, X, session)), 'ok');
  const used = [...destinationsFromHistory([S1, S2], [{ from: S1, to: X }]), ...session];
  assert.equal(h3(checksFor(S2, X, used)), 'warn');
  assert.equal(h3(checksFor(S2, Y, used)), 'ok');
});
test('history: transfers from addresses that are not ours are ignored', () => {
  assert.deepEqual(destinationsFromHistory([S1], [{ from: PAYER, to: X }, { from: Y, to: S1 }]), []);
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
test('history incomplete: a destination is never called unused while history is loading, failed or left out', () => {
  const fresh = { ...base, destination: Y as string, stealthAddress: S2, ownStealthAddresses: [S1, S2], usedDestinations: [] as Hex[] };
  const incomplete = withdrawChecks({ ...fresh, historyComplete: false }).find((c) => c.id === 'H3');
  assert.equal(incomplete?.level, 'warn');
  assert.match(incomplete?.text ?? '', /history incomplete/);
  assert.equal(h3(withdrawChecks({ ...fresh, destination: X, usedDestinations: [X], historyComplete: false })), 'warn');
  assert.match(withdrawChecks({ ...fresh, destination: X, usedDestinations: [X], historyComplete: false }).find((c) => c.id === 'H3')!.text, /already sent/);
  assert.equal(h3(withdrawChecks({ ...fresh, historyComplete: true })), 'ok');
  const { historyComplete: _, ...omitted } = fresh;
  const c = withdrawChecks(omitted as unknown as GuardInput);
  assert.equal(h3(c), 'warn');
  assert.deepEqual(warnings(c).map((x) => x.id), ['H3'], 'the only warning');
  assert.equal(blocking(c), false);
});

// ------------------------------------------------------------------ unspendable destinations (Toshit, C-01)

const UNSPENDABLE = [
  '0x0000000000000000000000000000000000000000', // zero address
  '0x000000000000000000000000000000000000dEaD', // burn address
  '0x55649E01B5Df198D18D95b5cc5051630cfD45564', // ERC-5564 Announcer
  '0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538', // ERC-6538 Registry
];

test('burn and protocol addresses are blocked in any letter case, and nothing else is reported for them', () => {
  for (const addr of UNSPENDABLE) {
    for (const destination of [addr, addr.toLowerCase(), '0x' + addr.slice(2).toUpperCase(), getAddress(addr), `  ${addr}  `]) {
      for (const isToken of [false, true]) {
        // also with every other input missing or failing: the burn block comes first
        for (const g of [{ ...base, destination, isToken }, { ...base, destination, isToken, walletAddress: undefined, payerKnown: false, historyComplete: false }]) {
          const c = withdrawChecks(g);
          assert.equal(blocking(c), true, destination);
          assert.deepEqual(c.map((x) => [x.id, x.level]), [['burn', 'block']], destination);
          assert.match(c[0]!.text, /lost for good/);
        }
      }
    }
  }
});
test('the burn block message names the address', () => {
  const text = (d: string) => withdrawChecks({ ...base, destination: d })[0]!.text;
  assert.match(text(UNSPENDABLE[0]!), /zero address/);
  assert.match(text(UNSPENDABLE[1]!), /burn address/);
  assert.match(text(UNSPENDABLE[2]!), /ERC-5564 Announcer/);
  assert.match(text(UNSPENDABLE[3]!), /ERC-6538 Registry/);
});
test('control: addresses next to the blocked ones pass clean', () => {
  const near = [
    '0x0000000000000000000000000000000000000012', // just past the precompiles 0x01 to 0x11, blocked since 0.2.10
    '0x1000000000000000000000000000000000000000',
    '0x000000000000000000000000000000000000deae',
    '0x000000000000000000000000000000000000dea0',
    '0x100000000000000000000000000000000000dead',
    '0xdead000000000000000000000000000000000000',
    '0x55649e01b5df198d18d95b5cc5051630cfd45565',
    '0x55649e01b5df198d18d95b5cc5051630cfd4556',
    '0x6538e6bf4b0ebd30a8ea093027ac2422ce5d6539',
    '0x7538e6bf4b0ebd30a8ea093027ac2422ce5d6538',
  ];
  for (const a of near) {
    for (const d of a.length === 42 ? [a, getAddress(a)] : [a]) {
      const c = withdrawChecks({ ...base, destination: d });
      assert.ok(!c.some((x) => x.id === 'burn'), d);
      if (a.length !== 42) {
        // one hex digit short: not an address at all
        assert.deepEqual(c.map((x) => x.id), ['addr'], d);
        continue;
      }
      assert.equal(blocking(c), false, d);
      assert.equal(warnings(c).length, 0, d);
      assert.deepEqual(c.map((x) => `${x.id}:${x.level}`), ['H1:ok', 'H2:ok', 'H3:ok', 'H4:ok', 'H5:ok'], d);
    }
  }
});

// ------------------------------------------------------------------ fail closed when the key wallet or the payer is missing

test('H1 fail closed: a missing key wallet blocks every destination, also with registrants passed in', () => {
  const REG = '0x8888888888888888888888888888888888888888' as Hex;
  for (const walletAddress of [undefined, '' as Hex, null as unknown as Hex, '0x2222' as Hex])
    for (const registrants of [undefined, [], [REG]]) {
      const c = withdrawChecks({ ...base, walletAddress, registrants });
      const h1 = c.find((x) => x.id === 'H1')!;
      assert.equal(h1.level, 'block', String(walletAddress));
      assert.match(h1.text, /key wallet is not known/);
      assert.equal(blocking(c), true);
    }
  // left out entirely by a loose caller (plain JS, a cast): same
  const { walletAddress: _w, ...omitted } = base;
  const c = withdrawChecks(omitted as unknown as GuardInput);
  assert.equal(level(c, 'H1'), 'block');
  assert.equal(blocking(c), true);
});

test('H2 fail closed: payer marked known but no payer address passed in blocks', () => {
  for (const g of [
    { ...base, payer: undefined, payers: [] },
    { ...base, payer: undefined, payers: undefined },
    { ...base, payer: '' as Hex, payers: ['' as Hex] },
    { ...base, payer: '0x3333' as Hex, payers: [] },
  ]) {
    const c = withdrawChecks(g);
    const h2 = c.find((x) => x.id === 'H2')!;
    assert.equal(h2.level, 'block', JSON.stringify([g.payer, g.payers]));
    assert.match(h2.text, /payer is not known/);
    assert.equal(blocking(c), true);
  }
  // one valid payer address, from either field, is enough
  assert.equal(level(withdrawChecks({ ...base, payer: undefined, payers: [CALLER] }), 'H2'), 'ok');
  assert.equal(level(withdrawChecks({ ...base, payers: [] }), 'H2'), 'ok');
});

test('H2 fail closed: an unknown payer blocks under the relaxed integrator policy too; a known payer match blocks there too (0.2.10)', () => {
  for (const g of [{ ...base, payerKnown: false }, { ...base, payer: undefined, payers: [] }]) {
    const c = withdrawChecks(g, { H2: 'warn' });
    assert.equal(level(c, 'H2'), 'block');
    assert.equal(blocking(c), true);
  }
  assert.equal(level(withdrawChecks({ ...base, destination: PAYER }, { H2: 'warn' }), 'H2'), 'block');
  assert.equal(blocking(withdrawChecks({ ...base, destination: PAYER }, { H2: 'warn' })), true);
  assert.equal(level(withdrawChecks({ ...base, destination: PAYER }), 'H2'), 'block');
});
