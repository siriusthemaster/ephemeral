// Deterministic toy worlds for v2 (unequal debts), shared by the TypeScript tests and the Solidity tests.
//   node --experimental-strip-types notes-fixture.ts small > ../test/fixtures/notes8.json
//   node --experimental-strip-types notes-fixture.ts world > ../test/fixtures/notes200.json
//   node --experimental-strip-types notes-fixture.ts report     (the base-unit trade-off table in PAYOUTS.md)
// Keys and addresses here come from fixed labels: test data only.
//
// Reward model ("my rewards follow holding time, including previous owners"): each epoch the payer splits a reward pool
// over the NFTs by weight = min(holding days, 180), where holding days count from the NFT's first mint and do not reset
// on a sale (previous owners' time counts). An NFT sold during the epoch splits its reward between the seller (the
// share of the day before the sale) and the buyer. A holder's debt is the sum over their NFTs. All of it is public.
import { getAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { pathToFileURL } from 'node:url';
import { metaAddressOf, metadataForETH, type StealthKeys } from './stealth.ts';
import { testKeys, testOwners, type Owner } from './fixture.ts';
import { expectedBatch, planNotesEpoch, withCarries, type LedgerEntry, type NoteHolder, type NotesPlan } from './notes.ts';
import { analyzeBatch, analyzeExactAmounts } from './notes-anonymity.ts';

export const WEIGHT_CAP_DAYS = 180n;

export type Nft = { id: number; ageDays: number };
export type Sale = { nftId: number; from: Address; to: Address; at: number /* fraction of the epoch before the sale, in 1/100 */ };

/** Debts for one epoch. Integer wei; rounding dust (< 1 wei per NFT) stays with the payer. */
export function epochDebts(pool: bigint, nfts: Nft[], ownerOf: Map<number, Address>, sales: Sale[]): { owner: Address; debt: bigint }[] {
  const w = (n: Nft) => (BigInt(n.ageDays) < WEIGHT_CAP_DAYS ? BigInt(n.ageDays) : WEIGHT_CAP_DAYS);
  const total = nfts.reduce((s, n) => s + w(n), 0n);
  const debts = new Map<Address, bigint>();
  const add = (o: Address, d: bigint) => d > 0n && debts.set(o, (debts.get(o) ?? 0n) + d);
  const saleOf = new Map(sales.map((s) => [s.nftId, s]));
  for (const n of nfts) {
    const reward = (pool * w(n)) / total;
    const s = saleOf.get(n.id);
    if (!s) {
      add(ownerOf.get(n.id)!, reward);
      continue;
    }
    const seller = (reward * BigInt(s.at)) / 100n;
    add(s.from, seller);
    add(s.to, reward - seller);
  }
  return [...debts].map(([owner, debt]) => ({ owner, debt }));
}

// ---------------------------------------------------------------- deterministic randomness

const rnd = (label: string) => Number(BigInt(keccak256(toHex(label))) >> 200n) / 2 ** 56; // [0, 1)
const pick = <T>(xs: T[], label: string) => xs[Math.floor(rnd(label) * xs.length)];
export const labelAddress = (label: string): Address => getAddress(`0x${keccak256(toHex(label)).slice(26)}`);

// ---------------------------------------------------------------- the 200-holder world

export const WORLD_POOL = 2n * 10n ** 17n; // 0.2 ETH per epoch
export const WORLD_BASE = 10n ** 14n; // 0.0001 ETH base unit
export const WORLD_MIN_CROWD = 20;

/**
 * 190 current owners of 306 NFTs (one whale with 16, a few with 4 to 8, many with 1 to 2) plus 10 previous owners who
 * each sold their only NFT during the epoch: 200 owners with a debt. Ages follow four mint waves.
 */
export function world(epochOffset = 0) {
  const nfts: Nft[] = [];
  const waves: [number, number, number][] = [
    [96, 300, 400], // [count, minAge, maxAge]
    [80, 120, 220],
    [70, 30, 100],
    [60, 1, 25],
  ];
  for (const [count, lo, hi] of waves) {
    for (let i = 0; i < count; i++) {
      const id = nfts.length + 1;
      nfts.push({ id, ageDays: lo + Math.floor(rnd(`age/${id}`) * (hi - lo)) + epochOffset });
    }
  }
  const holdings = [16, 8, 7, 6, 5, 5, 4, 4, 4, 3, 3, 3, 3, 3, 3, 3, 3, ...Array(40).fill(2)];
  while (holdings.length < 190) holdings.push(1);
  const owners: Address[] = holdings.map((_, i) => labelAddress(`world/owner/${i}`));
  const ids = nfts.map((n) => n.id).sort((a, b) => rnd(`shuffle/${a}`) - rnd(`shuffle/${b}`));
  const totalHeld = holdings.reduce((a, b) => a + b, 0);
  if (totalHeld + 10 !== nfts.length) throw new Error(`world: ${totalHeld} held + 10 sold != ${nfts.length} NFTs`);
  const ownerOf = new Map<number, Address>();
  let next = 0;
  holdings.forEach((h, i) => {
    for (let j = 0; j < h; j++) ownerOf.set(ids[next++], owners[i]);
  });
  // The last 10 NFTs changed hands today: a previous owner held each for part of the day, a current owner bought it.
  const sales: Sale[] = [];
  for (let j = 0; j < 10; j++) {
    const nftId = ids[next++];
    const to = pick(owners, `sale/to/${j}`);
    ownerOf.set(nftId, to);
    sales.push({ nftId, from: labelAddress(`world/seller/${j}`), to, at: 5 + Math.floor(rnd(`sale/at/${j}`) * 90) });
  }
  return { nfts, ownerOf, owners, sales, debts: epochDebts(WORLD_POOL, nfts, ownerOf, sales) };
}

/** 30 epochs of the world: ages grow by one day per epoch, a few NFTs change hands each day to new or existing owners. */
export function worldHistory(epochs = 30): { owner: Address; debt: bigint }[][] {
  const w0 = world();
  const ownerOf = new Map(w0.ownerOf);
  const known: Address[] = [...new Set(ownerOf.values())];
  const history: { owner: Address; debt: bigint }[][] = [w0.debts];
  for (let e = 1; e < epochs; e++) {
    const nfts = w0.nfts.map((n) => ({ ...n, ageDays: n.ageDays + e }));
    const sales: Sale[] = [];
    const sold = new Set<number>();
    const nSales = 2 + Math.floor(rnd(`hist/${e}/n`) * 5);
    for (let j = 0; j < nSales; j++) {
      const nftId = pick(nfts, `hist/${e}/nft/${j}`).id;
      if (sold.has(nftId)) continue;
      sold.add(nftId);
      const fresh = rnd(`hist/${e}/fresh/${j}`) < 0.4;
      const to = fresh ? labelAddress(`hist/${e}/buyer/${j}`) : pick(known, `hist/${e}/to/${j}`);
      if (fresh) known.push(to);
      sales.push({ nftId, from: ownerOf.get(nftId)!, to, at: 5 + Math.floor(rnd(`hist/${e}/at/${j}`) * 90) });
    }
    history.push(epochDebts(WORLD_POOL, nfts, ownerOf, sales));
    for (const s of sales) ownerOf.set(s.nftId, s.to);
  }
  return history;
}

/** Public: the world's ledger lines for epoch 0 (no carry yet), its expected batch and the anonymity report. */
export function worldBatch(base = WORLD_BASE, minCrowd = WORLD_MIN_CROWD) {
  const lines: LedgerEntry[] = world().debts.map((d) => ({ ...d, carryIn: 0n }));
  return { lines, batch: expectedBatch(lines, base, minCrowd) };
}

/** test/fixtures/notes200.json: what the Solidity gas test settles (group sizes and amounts; addresses are synthetic). */
export function buildWorldFixture() {
  const { lines, batch } = worldBatch();
  const r = analyzeBatch(batch);
  return {
    holders: lines.length,
    base: batch.base.toString(),
    minCrowd: batch.minCrowd,
    kmax: batch.kmax,
    declaredTotal: batch.declaredTotal.toString(),
    notes: batch.notes,
    amounts: batch.groups.map((g) => g.amountEach.toString()),
    counts: batch.groups.map((g) => g.count),
    distinctHolders: batch.groups.map((g) => g.holders),
    anonymity: {
      crowdMin: r.crowd.min,
      crowdMedian: r.crowd.median,
      bitsMin: Math.round(r.bits.min * 10) / 10,
      bitsMedian: Math.round(r.bits.median * 10) / 10,
      bestGuessRate: Math.round(r.bestGuessRate * 1000) / 1000,
      exactAmountsAlone: analyzeExactAmounts(lines.map((l) => l.debt)).alone,
      mergedUnique: r.mergedUnique,
    },
  };
}

// ---------------------------------------------------------------- the small world (real keys, settled on chain)

export const SMALL_EPOCH = 8n;
export const SMALL_BASE = 10n ** 14n;
export const SMALL_MIN_CROWD = 3;
export const SMALL_POOL = 12n * 10n ** 15n; // 0.012 ETH for 12 NFTs

export type SmallOwner = Owner & { owner: Address };

/** The six v1 owners (NFTs 1..12) plus gina, who sold NFT 12 to frank 40% into the epoch: 7 owners, unequal debts. */
export function smallWorld(): { owners: SmallOwner[]; lines: LedgerEntry[]; holders: NoteHolder[] } {
  const base = testOwners();
  const gina: Owner = { name: 'gina', keys: testKeys('gina'), metaAddress: metaAddressOf(testKeys('gina')), nftIds: [], walletKey: keccak256(toHex('gina/wallet')) };
  const owners: SmallOwner[] = [...base, gina].map((o) => ({ ...o, owner: privateKeyToAccount(o.walletKey).address }));
  const ages = [400, 12, 250, 90, 365, 30, 180, 5, 300, 220, 60, 150];
  const nfts: Nft[] = ages.map((ageDays, i) => ({ id: i + 1, ageDays }));
  const ownerOf = new Map<number, Address>();
  for (const o of owners) for (const id of o.nftIds) ownerOf.set(Number(id), o.owner);
  const frank = owners.find((o) => o.name === 'frank')!;
  const ginaO = owners.find((o) => o.name === 'gina')!;
  const debts = epochDebts(SMALL_POOL, nfts, ownerOf, [{ nftId: 12, from: ginaO.owner, to: frank.owner, at: 40 }]);
  // a carry from the previous epoch, below the base unit, for two owners
  const carry = new Map<Address, bigint>([
    [owners[0].owner, 7_000_000_000_000n],
    [owners[3].owner, 123_456_789n],
  ]);
  const lines = debts.map((d) => ({ ...d, carryIn: carry.get(d.owner) ?? 0n }));
  const holders = lines.map((l) => ({ ...l, metaAddress: owners.find((o) => o.owner === l.owner)!.metaAddress }));
  return { owners, lines, holders };
}

const label = (s: string): Hex => `0x${((BigInt(keccak256(toHex(s))) % (2n ** 255n)) + 1n).toString(16).padStart(64, '0')}` as Hex;

export function smallPlan(): { owners: SmallOwner[]; lines: LedgerEntry[]; plan: NotesPlan } {
  const { owners, lines, holders } = smallWorld();
  const plan = planNotesEpoch({ epoch: SMALL_EPOCH, base: SMALL_BASE, minCrowd: SMALL_MIN_CROWD, holders, ephemeralKey: (i) => label(`note-eph/${SMALL_EPOCH}/${i}`) });
  return { owners, lines, plan };
}

/** test/fixtures/notes8.json: the small plan, settled on chain by test/StealthPayout.t.sol, plus dave's private receipts. */
export function buildSmallFixture() {
  const { owners, plan } = smallPlan();
  const dave = owners.find((o) => o.name === 'dave')!;
  const mine = plan.receipts.filter((r) => r.owner === dave.owner);
  return {
    epoch: plan.epoch.toString(),
    base: plan.base.toString(),
    declaredTotal: plan.declaredTotal.toString(),
    commitmentsRoot: plan.commitmentsRoot,
    amounts: plan.groups.map((g) => g.amountEach.toString()),
    counts: plan.groups.map((g) => g.recipients.length),
    stealthAddresses: plan.groups.flatMap((g) => g.recipients.map((r) => r.stealthAddress)),
    ephemeralPubKeys: plan.groups.flatMap((g) => g.recipients.map((r) => r.ephemeralPubKey)),
    viewTags: plan.groups.flatMap((g) => g.recipients.map((r) => parseInt(r.viewTag.slice(2), 16))),
    metadata: plan.groups.flatMap((g) => g.recipients.map((r) => metadataForETH(parseInt(r.viewTag.slice(2), 16), g.amountEach))),
    receipt: {
      owner: dave.owner,
      debt: mine[0].debt.toString(),
      carryIn: mine[0].carryIn.toString(),
      stealthAddresses: mine.map((r) => r.stealthAddress),
      denominations: mine.map((r) => r.denomination.toString()),
      salts: mine.map((r) => r.salt),
      leaves: mine.map((r) => r.leaf),
      proofs: mine.map((r) => r.merkleProof),
    },
  };
}

/** The trade-off table in PAYOUTS.md (node --experimental-strip-types notes-fixture.ts report). Gas: about 45,000 per note. */
export function notesReport(bases = [10n ** 12n, 10n ** 13n, 10n ** 14n], minCrowd = WORLD_MIN_CROWD) {
  const lines: LedgerEntry[] = world().debts.map((d) => ({ ...d, carryIn: 0n }));
  const rows = bases.map((base) => {
    const b = expectedBatch(lines, base, minCrowd);
    const r = analyzeBatch(b);
    const noCap = analyzeBatch(expectedBatch(lines, base, minCrowd, { kmax: 64 }));
    return {
      base: base.toString(),
      kmax: b.kmax,
      paidHolders: r.holdersPaid,
      notes: b.notes,
      estGas: b.notes * 45_000,
      crowd: `${r.crowd.min} / ${r.crowd.median}`,
      bits: `${r.bits.min.toFixed(1)} / ${r.bits.median.toFixed(1)}`,
      subsetBits: `${r.subsetBits.min.toFixed(1)} / ${r.subsetBits.median.toFixed(1)}`,
      bestGuess: `${(r.bestGuessRate * 100).toFixed(1)}%`,
      topGroupTopHolder: `${(r.groups[r.groups.length - 1].topHolderShare * 100).toFixed(0)}%`,
      mergedUnique: r.mergedUnique,
      mergedCrowdMedian: r.mergedCrowd.median,
      noCapMinCrowd: noCap.crowd.min,
      noCapBelowMinCrowd: noCap.perHolder.filter((h) => h.crowd < minCrowd).length,
    };
  });
  return { holders: lines.length, exactAmountsAlone: analyzeExactAmounts(lines.map((l) => l.debt)).alone, minCrowd, rows };
}

export type { StealthKeys, NotesPlan };
export { withCarries };

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const which = process.argv[2];
  const out = which === 'world' ? buildWorldFixture() : which === 'small' ? buildSmallFixture() : which === 'report' ? notesReport() : null;
  if (!out) throw new Error('usage: notes-fixture.ts small|world|report');
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}
