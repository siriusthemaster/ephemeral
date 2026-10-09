// v2: unequal debts as denomination notes (answers "my rewards follow holding time, including previous owners. Grouping
// exact amounts can leave one holder identifiable").
//
// Each holder's exact debt for the epoch (wei, from the public ledger) plus the sub-unit remainder carried from the last
// epoch is rounded DOWN to a public base unit; the new remainder is carried to the next epoch, so cumulative payouts stay
// exact. The rounded amount is split into notes of base * 2^k. Every note goes to its own fresh stealth address of that
// holder, and settleNotes() pays one equal-amount group per denomination. An observer sees only how many notes of each
// denomination were paid, and that multiset is already implied by the public ledger.
//
// The denominations stop at a cap 2^kmax (the "top" denomination) chosen by a public rule so that every denomination is
// shared by at least `minCrowd` distinct holders: without the cap, the largest debts get high notes nobody else gets, and
// such a note names its holder. Above the cap a holder gets several notes of the top denomination.
//
// Pure functions; nothing here touches a network or stores a key.
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, concat, encodeAbiParameters, encodeFunctionData, getAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import { generateStealthAddress, parseMetaAddress, stealthAddressFor, viewTagMatch, type StealthKeys } from './stealth.ts';
import { buildTree, merkleProof } from './proof.ts';
import { hashedSecretFor, type Recipient } from './payout-plan.ts';

// ---------------------------------------------------------------- the public rule (anyone can run it on the ledger)

/** One ledger line for an epoch: what the payer owes `owner` (current or previous NFT owner), and the carry it brings. */
export type LedgerEntry = { owner: Address; debt: bigint; carryIn: bigint };

/** Round (debt + carryIn) down to the base unit. paid + carryOut == debt + carryIn, and 0 <= carryOut < base. */
export function roundDown(debt: bigint, carryIn: bigint, base: bigint) {
  if (base <= 0n) throw new Error('Base unit must be positive');
  if (debt < 0n || carryIn < 0n) throw new Error('Negative debt or carry');
  const total = debt + carryIn;
  const units = total / base;
  return { units, paid: units * base, carryOut: total - units * base };
}

const bitLength = (u: bigint) => (u === 0n ? 0 : u.toString(2).length);

/**
 * The top exponent kmax: the largest k such that at least `minCrowd` holders get a note of base * 2^k (everyone with
 * units >= 2^k does), and every lower denomination that is used at all is used by at least `minCrowd` holders.
 * Deterministic from public data, so it leaks nothing and anyone can check it.
 */
export function topExponent(units: bigint[], minCrowd: number): number {
  const paid = units.filter((u) => u > 0n);
  if (paid.length === 0) throw new Error('Nothing to pay this epoch');
  if (paid.length < minCrowd) throw new Error(`Only ${paid.length} holders are paid: no denomination can be shared by ${minCrowd}`);
  const bits = Math.max(...paid.map(bitLength));
  const bitCrowd = Array.from({ length: bits }, (_, j) => paid.filter((u) => (u >> BigInt(j)) & 1n).length);
  for (let k = bits - 1; k > 0; k--) {
    if (paid.filter((u) => u >> BigInt(k) > 0n).length < minCrowd) continue;
    if (bitCrowd.slice(0, k).every((c) => c === 0 || c >= minCrowd)) return k;
  }
  return 0; // everything in base units: the crowd is every paid holder
}

/** Exponents of a holder's notes: the binary digits below kmax, then (units >> kmax) notes of the top denomination. */
export function decompose(units: bigint, kmax: number): number[] {
  if (units < 0n || kmax < 0) throw new Error('Bad decomposition input');
  const exps: number[] = [];
  for (let j = 0; j < kmax; j++) if ((units >> BigInt(j)) & 1n) exps.push(j);
  for (let i = 0n, top = units >> BigInt(kmax); i < top; i++) exps.push(kmax);
  return exps;
}

export type ExpectedGroup = { exponent: number; amountEach: bigint; count: number; holders: number };
export type ExpectedBatch = {
  base: bigint;
  minCrowd: number;
  kmax: number;
  declaredTotal: bigint; // what settleNotes must be declared with and pay in total
  notes: number;
  groups: ExpectedGroup[]; // ascending amountEach, as settleNotes requires
  perOwner: Map<Address, { debt: bigint; carryIn: bigint; units: bigint; paid: bigint; carryOut: bigint; exponents: number[] }>;
};

/**
 * Public: the exact multiset of notes the ledger implies for this epoch (and each owner's carry for the next one).
 * `kmax` can be forced for analysis (e.g. Infinity-like 255 = plain binary with no cap).
 */
export function expectedBatch(entries: LedgerEntry[], base: bigint, minCrowd: number, opts: { kmax?: number } = {}): ExpectedBatch {
  const seen = new Set<string>();
  for (const e of entries) {
    const k = getAddress(e.owner);
    if (seen.has(k)) throw new Error(`Owner ${k} listed twice: one ledger line per owner per epoch`);
    seen.add(k);
    if (e.carryIn >= base) throw new Error(`Carry of ${k} is not below the base unit`);
  }
  const rounded = entries.map((e) => ({ e, ...roundDown(e.debt, e.carryIn, base) }));
  const kmax = opts.kmax ?? topExponent(rounded.map((r) => r.units), minCrowd);
  const perOwner: ExpectedBatch['perOwner'] = new Map();
  const count = new Map<number, number>();
  const holders = new Map<number, number>();
  let declaredTotal = 0n;
  let notes = 0;
  for (const r of rounded) {
    const exponents = decompose(r.units, kmax);
    perOwner.set(getAddress(r.e.owner), { debt: r.e.debt, carryIn: r.e.carryIn, units: r.units, paid: r.paid, carryOut: r.carryOut, exponents });
    for (const k of exponents) count.set(k, (count.get(k) ?? 0) + 1);
    for (const k of new Set(exponents)) holders.set(k, (holders.get(k) ?? 0) + 1);
    declaredTotal += r.paid;
    notes += exponents.length;
  }
  const groups = [...count.keys()]
    .sort((a, b) => a - b)
    .map((k) => ({ exponent: k, amountEach: base << BigInt(k), count: count.get(k)!, holders: holders.get(k)! }));
  return { base, minCrowd, kmax, declaredTotal, notes, groups, perOwner };
}

/**
 * Public: the ledger lines for a run of epochs with each owner's carry filled in. Carries are a deterministic function of
 * the public debts, so anyone can recompute them. An owner with a carry but no new debt keeps it (it is < base) until
 * they accrue again.
 */
export function withCarries(history: { owner: Address; debt: bigint }[][], base: bigint): LedgerEntry[][] {
  const carry = new Map<Address, bigint>();
  return history.map((epoch) => {
    const debts = new Map<Address, bigint>();
    for (const d of epoch) debts.set(getAddress(d.owner), (debts.get(getAddress(d.owner)) ?? 0n) + d.debt);
    const lines: LedgerEntry[] = [...debts].map(([owner, debt]) => ({ owner, debt, carryIn: carry.get(owner) ?? 0n }));
    for (const l of lines) carry.set(l.owner, roundDown(l.debt, l.carryIn, base).carryOut);
    return lines;
  });
}

// ---------------------------------------------------------------- commitments

/**
 * Leaf for one note: keccak256(keccak256(abi.encode(uint256 epoch, address owner, uint256 debt, uint256 carryIn,
 * address stealthAddress, uint256 denomination, bytes32 salt))). Every note of a holder commits the same (owner, debt,
 * carryIn), so a holder can open all of them and show the denominations add up to exactly what that debt pays. Seven
 * words, so it can never equal a v1 leaf (four words).
 */
export function noteLeafHash(epoch: bigint, owner: Address, debt: bigint, carryIn: bigint, stealthAddress: Address, denomination: bigint, salt: Hex): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) throw new Error('Salt must be 32 bytes');
  return keccak256(
    keccak256(
      encodeAbiParameters(
        [{ type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }],
        [epoch, getAddress(owner), debt, carryIn, getAddress(stealthAddress), denomination, salt],
      ),
    ),
  );
}

/** Default note salt: from the ERC-5564 shared secret, so the holder rebuilds every leaf from public data. */
export const noteSalt = (hashedSecret: Hex): Hex => keccak256(concat([toHex('StealthPayout.note.v2'), hashedSecret]));

// ---------------------------------------------------------------- operator side

export type NoteHolder = { owner: Address; metaAddress: string; debt: bigint; carryIn: bigint };

/** PRIVATE. One per note. The holder can rebuild it (findMyNotes); never publish it. */
export type NoteReceipt = {
  epoch: bigint;
  owner: Address;
  debt: bigint;
  carryIn: bigint;
  denomination: bigint;
  stealthAddress: Address;
  ephemeralPubKey: Hex;
  viewTag: number;
  salt: Hex;
  leaf: Hex;
  merkleProof: Hex[];
  commitmentsRoot: Hex;
};

export type NoteGroup = { amountEach: bigint; recipients: Recipient[] };

export type NotesPlan = {
  epoch: bigint;
  base: bigint;
  minCrowd: number;
  kmax: number;
  declaredTotal: bigint;
  groups: NoteGroup[]; // public: ascending amountEach, each ascending by stealth address
  commitmentsRoot: Hex; // public
  leaves: Hex[]; // public, sorted; each hides its owner, debt and note behind a secret salt
  receipts: NoteReceipt[]; // PRIVATE: the operator's owner -> note mapping
  carryOut: Map<Address, bigint>; // next epoch's carryIn per owner (derivable from the public ledger)
};

const cmpAddr = (a: Address, b: Address) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

/**
 * Operator side. Throws on a duplicate owner, a bad meta-address, a carry not below base, or a repeated stealth address
 * or ephemeral key anywhere in the epoch (the contract also rejects a repeated address within one transaction).
 */
export function planNotesEpoch(opts: {
  epoch: bigint;
  base: bigint;
  minCrowd: number;
  holders: NoteHolder[];
  ephemeralKey?: (index: number) => Hex; // tests only; default: a fresh random key per note
}): NotesPlan {
  const { epoch, base, minCrowd, holders } = opts;
  if (holders.length === 0) throw new Error('Nothing to pay');
  if (epoch < 0n) throw new Error('Bad epoch');
  const batch = expectedBatch(holders, base, minCrowd);

  let i = 0;
  const rows: Omit<NoteReceipt, 'merkleProof' | 'commitmentsRoot'>[] = [];
  for (const h of holders) {
    const owner = getAddress(h.owner);
    const { exponents } = batch.perOwner.get(owner)!;
    if (exponents.length === 0) continue; // owes less than one base unit this epoch: all of it carries
    const meta = parseMetaAddress(h.metaAddress);
    for (const k of exponents) {
      const eph = opts.ephemeralKey ? opts.ephemeralKey(i++) : bytesToHex(secp256k1.utils.randomPrivateKey());
      const g = generateStealthAddress(meta, eph);
      const hashedSecret = hashedSecretFor(eph, meta.viewingPublicKey);
      const stealthAddress = getAddress(g.stealthAddress);
      const denomination = base << BigInt(k);
      const salt = noteSalt(hashedSecret);
      rows.push({
        epoch, owner, debt: h.debt, carryIn: h.carryIn, denomination, stealthAddress, ephemeralPubKey: g.ephemeralPublicKey, viewTag: g.viewTag, salt,
        leaf: noteLeafHash(epoch, owner, h.debt, h.carryIn, stealthAddress, denomination, salt),
      });
    }
  }
  if (new Set(rows.map((r) => r.stealthAddress)).size !== rows.length) throw new Error('Same stealth address twice (reused ephemeral key)');
  if (new Set(rows.map((r) => r.ephemeralPubKey.toLowerCase())).size !== rows.length) throw new Error('Ephemeral key reused: every note needs a fresh one');

  const tree = buildTree(rows.map((r) => r.leaf));
  const byAmount = new Map<bigint, typeof rows>();
  for (const r of rows) byAmount.set(r.denomination, [...(byAmount.get(r.denomination) ?? []), r]);
  const groups: NoteGroup[] = [...byAmount.keys()]
    .sort((a, b) => (a < b ? -1 : 1))
    .map((amountEach) => ({
      amountEach,
      recipients: byAmount
        .get(amountEach)!
        .sort((a, b) => cmpAddr(a.stealthAddress, b.stealthAddress))
        .map((r) => ({ stealthAddress: r.stealthAddress, ephemeralPubKey: r.ephemeralPubKey, viewTag: toHex(r.viewTag, { size: 1 }) })),
    }));

  const paid = groups.reduce((s, g) => s + g.amountEach * BigInt(g.recipients.length), 0n);
  if (paid !== batch.declaredTotal) throw new Error('Notes do not add up to the declared total'); // sanity
  return {
    epoch,
    base,
    minCrowd,
    kmax: batch.kmax,
    declaredTotal: batch.declaredTotal,
    groups,
    commitmentsRoot: tree.root,
    leaves: tree.leaves,
    receipts: rows.map((r) => ({ ...r, merkleProof: merkleProof(tree, r.leaf), commitmentsRoot: tree.root })),
    carryOut: new Map([...batch.perOwner].map(([o, p]) => [o, p.carryOut])),
  };
}

/**
 * Notes per settleNotes call that fit EIP-7825's 2^24 gas per transaction even if every recipient is a contract that burns
 * its gas and parks (about 54,700 gas per note in test_gas_notes200; an ordinary fresh address costs about 45,000).
 */
export const MAX_NOTES_PER_TX = 300;

export type NotesPart = { groups: NoteGroup[]; value: bigint; notes: number };

/**
 * Splits an epoch into parts of at most `maxNotes` notes, for a chain that caps gas per transaction (EIP-7825: 2^24).
 * Each part keeps groups ascending by amount and recipients ascending within a group; every part carries the same root
 * and declared total, and the contract checks they add up.
 */
export function splitParts(plan: Pick<NotesPlan, 'groups'>, maxNotes: number): NotesPart[] {
  if (maxNotes < 1) throw new Error('maxNotes must be at least 1');
  const parts: NotesPart[] = [];
  let cur: NoteGroup[] = [];
  let room = maxNotes;
  const flush = () => {
    if (cur.length === 0) return;
    parts.push({ groups: cur, value: cur.reduce((s, g) => s + g.amountEach * BigInt(g.recipients.length), 0n), notes: maxNotes - room });
    cur = [];
    room = maxNotes;
  };
  for (const g of plan.groups) {
    let rest = g.recipients;
    while (rest.length > 0) {
      const take = rest.slice(0, room);
      cur.push({ amountEach: g.amountEach, recipients: take });
      room -= take.length;
      rest = rest.slice(take.length);
      if (room === 0) flush();
    }
  }
  flush();
  return parts;
}

export const STEALTH_PAYOUT_V2_ABI = [
  {
    type: 'function',
    name: 'settleNotes',
    stateMutability: 'payable',
    inputs: [
      { name: 'epoch', type: 'uint256' },
      { name: 'commitmentsRoot', type: 'bytes32' },
      { name: 'declaredTotal', type: 'uint256' },
      {
        name: 'groups',
        type: 'tuple[]',
        components: [
          { name: 'amountEach', type: 'uint256' },
          {
            name: 'rs',
            type: 'tuple[]',
            components: [
              { name: 'stealthAddress', type: 'address' },
              { name: 'ephemeralPubKey', type: 'bytes' },
              { name: 'viewTag', type: 'bytes1' },
            ],
          },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'NotesSettled',
    inputs: [
      { name: 'payer', type: 'address', indexed: true },
      { name: 'epoch', type: 'uint256', indexed: true },
      { name: 'commitmentsRoot', type: 'bytes32', indexed: false },
      { name: 'declaredTotal', type: 'uint256', indexed: false },
      { name: 'paid', type: 'uint256', indexed: false },
      { name: 'notes', type: 'uint256', indexed: false },
      { name: 'outstanding', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'NoteGroup',
    inputs: [
      { name: 'payer', type: 'address', indexed: true },
      { name: 'epoch', type: 'uint256', indexed: true },
      { name: 'amountEach', type: 'uint256', indexed: false },
      { name: 'count', type: 'uint256', indexed: false },
    ],
  },
] as const;

/** Calldata for settleNotes(); send it with value = part.value (or plan.declaredTotal for the whole epoch at once). */
export function settleNotesCalldata(plan: Pick<NotesPlan, 'epoch' | 'commitmentsRoot' | 'declaredTotal'>, groups: NoteGroup[]): Hex {
  return encodeFunctionData({
    abi: STEALTH_PAYOUT_V2_ABI,
    functionName: 'settleNotes',
    args: [plan.epoch, plan.commitmentsRoot, plan.declaredTotal, groups.map((g) => ({ amountEach: g.amountEach, rs: g.recipients }))],
  });
}

// ---------------------------------------------------------------- holder side

/** One announcement of the epoch as read from chain; `amount` is the metadata amount (== the ETH the address got). */
export type SeenNote = { stealthAddress: Address; ephemeralPubKey: Hex; viewTag: number; amount: bigint };

export const notesOf = (plan: Pick<NotesPlan, 'groups'>): SeenNote[] =>
  plan.groups.flatMap((g) =>
    g.recipients.map((r) => ({ stealthAddress: r.stealthAddress, ephemeralPubKey: r.ephemeralPubKey, viewTag: parseInt(r.viewTag.slice(2), 16), amount: g.amountEach })),
  );

/**
 * Holder side, public data only: the epoch's announcements, the published leaves, the public ledger line (debt and carry,
 * both recomputable from the ledger) and your own keys.
 * - receipts: your notes whose leaf commits exactly your ledger line
 * - unmatched: notes paid to you whose leaf commits something else (a misstated debt or carry, another owner)
 * - complete: the receipts add up to exactly what your ledger line pays this epoch
 */
export function findMyNotes(
  keys: Pick<StealthKeys, 'viewingPrivateKey' | 'spendingPublicKey'>,
  opts: { epoch: bigint; base: bigint; owner: Address; debt: bigint; carryIn: bigint; notes: SeenNote[]; leaves: Hex[] },
): { receipts: NoteReceipt[]; unmatched: Address[]; paid: bigint; expected: bigint; complete: boolean } {
  const tree = buildTree(opts.leaves);
  const published = new Set(tree.leaves);
  const owner = getAddress(opts.owner);
  const receipts: NoteReceipt[] = [];
  const unmatched: Address[] = [];
  for (const n of opts.notes) {
    const h = viewTagMatch(keys.viewingPrivateKey, n.ephemeralPubKey, n.viewTag);
    if (!h) continue;
    if (stealthAddressFor(keys.spendingPublicKey, h).toLowerCase() !== n.stealthAddress.toLowerCase()) continue;
    const stealthAddress = getAddress(n.stealthAddress);
    const salt = noteSalt(h);
    const leaf = noteLeafHash(opts.epoch, owner, opts.debt, opts.carryIn, stealthAddress, n.amount, salt);
    if (!published.has(leaf.toLowerCase() as Hex)) {
      unmatched.push(stealthAddress);
      continue;
    }
    receipts.push({
      epoch: opts.epoch, owner, debt: opts.debt, carryIn: opts.carryIn, denomination: n.amount, stealthAddress, ephemeralPubKey: n.ephemeralPubKey,
      viewTag: n.viewTag, salt, leaf, merkleProof: merkleProof(tree, leaf), commitmentsRoot: tree.root,
    });
  }
  const paid = receipts.reduce((s, r) => s + r.denomination, 0n);
  const expected = roundDown(opts.debt, opts.carryIn, opts.base).paid;
  return { receipts, unmatched, paid, expected, complete: paid === expected };
}

// ---------------------------------------------------------------- public audit (no ZK, no private data)

export type OnchainNotesSummary = { declaredTotal: bigint; outstanding: bigint; groups: { amountEach: bigint; count: number }[] };

/** Sums the NoteGroup events of every part of an epoch into one table. */
export function summarizeParts(declaredTotal: bigint, parts: { amountEach: bigint; count: number }[][]): OnchainNotesSummary {
  const m = new Map<bigint, number>();
  let paid = 0n;
  for (const p of parts) for (const g of p) {
    m.set(g.amountEach, (m.get(g.amountEach) ?? 0) + g.count);
    paid += g.amountEach * BigInt(g.count);
  }
  return {
    declaredTotal,
    outstanding: declaredTotal - paid,
    groups: [...m].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([amountEach, count]) => ({ amountEach, count })),
  };
}

/**
 * Anyone, from public data only: the declared total equals what the public ledger implies, the epoch is complete, and the
 * multiset of notes paid (amount -> count) is exactly the one the public rule gives for the ledger. This catches a wrong
 * total, a skipped or extra note and a wrong denomination. It cannot catch a note sent to the wrong person with the
 * multiset unchanged: only that holder notices (findMyNotes). Binding notes to ledger lines publicly needs a ZK proof.
 */
export function auditNotesEpoch(expected: ExpectedBatch, onchain: OnchainNotesSummary): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (onchain.declaredTotal !== expected.declaredTotal) problems.push(`declared total ${onchain.declaredTotal} != ledger ${expected.declaredTotal}`);
  if (onchain.outstanding !== 0n) problems.push(`epoch incomplete: ${onchain.outstanding} outstanding`);
  const want = new Map(expected.groups.map((g) => [g.amountEach, g.count]));
  const got = new Map(onchain.groups.map((g) => [g.amountEach, g.count]));
  for (const [a, c] of want) if (got.get(a) !== c) problems.push(`denomination ${a}: ledger implies ${c} notes, chain shows ${got.get(a) ?? 0}`);
  for (const [a, c] of got) if (!want.has(a)) problems.push(`denomination ${a}: ${c} notes the ledger does not imply`);
  return { ok: problems.length === 0, problems };
}
