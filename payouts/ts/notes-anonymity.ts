// What an observer with ALL public data can learn about who got which note.
//
// The observer knows every holder's exact debt (public ledger + NFT ownership history), every carry (a function of the
// ledger), the base unit, minCrowd and therefore the public rule: they know exactly which denominations each holder got.
// What they do not know is which of the equal-amount notes of a denomination is whose: the notes of one denomination
// went to fresh, unrelated addresses, sorted by address, in the same transaction. So:
//
// - crowd: a note of denomination k could belong to any of the H_k distinct holders who got a note of that denomination.
//   For a holder, the smallest crowd among their notes is the weakest point (k-anonymity of their most exposed note).
// - bits: log2 of the number of note sets the observer has to choose from for a holder, given the holder's (public)
//   pattern: prod_k C(C_k, m_ik), with C_k notes of denomination k in the batch and m_ik of them the holder's.
// - subsetBits: log2 of the number of subsets of the whole batch whose amounts add up to the holder's payout, i.e. what an
//   observer who did NOT know the rule would face. Reported because it was asked for; it overstates the protection,
//   since the rule is public. `crowd` and `bits` are the defensible numbers.
// - bestGuessRate: the share of notes an optimal observer attributes to the right holder by always guessing the holder
//   with the most notes of that denomination.
// - mergedCrowd: if a holder merges all their notes into one address (H3), the total is their payout; this many holders
//   have that same payout. 1 means the merge names them.
import type { Address } from 'viem';
import type { ExpectedBatch } from './notes.ts';

export type HolderAnonymity = { owner: Address; units: bigint; notes: number; crowd: number; bits: number; subsetBits: number; mergedCrowd: number };

export type AnonymityReport = {
  holdersPaid: number;
  notes: number;
  groups: { amountEach: bigint; count: number; holders: number; topHolderShare: number }[];
  perHolder: HolderAnonymity[];
  crowd: { min: number; median: number };
  bits: { min: number; median: number };
  subsetBits: { min: number; median: number };
  bestGuessRate: number;
  mergedUnique: number; // holders whose merged total is unique among holders
  mergedCrowd: { min: number; median: number };
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : (s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2;
};

// log2 of n! and of binomials, for n up to a few thousand
const lf: number[] = [0];
const log2Fact = (n: number) => {
  for (let i = lf.length; i <= n; i++) lf.push(lf[i - 1] + Math.log2(i));
  return lf[n];
};
export const log2Binom = (n: number, k: number) => (k < 0 || k > n ? -Infinity : log2Fact(n) - log2Fact(k) - log2Fact(n - k));

const log2Add = (a: number, b: number) => {
  if (a === -Infinity) return b;
  if (b === -Infinity) return a;
  const m = Math.max(a, b);
  return m + Math.log2(2 ** (a - m) + 2 ** (b - m));
};

/**
 * log2 of the number of subsets of a batch with counts[k] notes of 2^k units whose sum is `target` units. Digit DP over
 * the binary digits with a carry; each choice of n_k notes of level k counts C(counts[k], n_k) ways (distinct addresses).
 */
export function log2SubsetsSumming(counts: number[], target: number): number {
  let dp = new Map<number, number>([[0, 0]]); // carry -> log2(ways)
  for (let k = 0; k < counts.length; k++) {
    const bit = Math.floor(target / 2 ** k) % 2;
    const next = new Map<number, number>();
    for (const [c, w] of dp) {
      for (let n = (bit - c) & 1; n <= counts[k]; n += 2) {
        const nc = (c + n - bit) / 2;
        next.set(nc, log2Add(next.get(nc) ?? -Infinity, w + log2Binom(counts[k], n)));
      }
    }
    dp = next;
  }
  return dp.get(Math.floor(target / 2 ** counts.length)) ?? -Infinity;
}

export function analyzeBatch(batch: ExpectedBatch): AnonymityReport {
  const paidOwners = [...batch.perOwner].filter(([, p]) => p.exponents.length > 0);
  const levels = batch.kmax + 1;
  const C = Array.from({ length: levels }, () => 0); // notes per denomination
  const H = Array.from({ length: levels }, () => 0); // distinct holders per denomination
  const maxPerHolder = Array.from({ length: levels }, () => 0);
  const unitsCount = new Map<bigint, number>();
  for (const [, p] of paidOwners) {
    const m = new Map<number, number>();
    for (const k of p.exponents) m.set(k, (m.get(k) ?? 0) + 1);
    for (const [k, c] of m) {
      C[k] += c;
      H[k] += 1;
      maxPerHolder[k] = Math.max(maxPerHolder[k], c);
    }
    unitsCount.set(p.units, (unitsCount.get(p.units) ?? 0) + 1);
  }
  const notes = C.reduce((a, b) => a + b, 0);

  const perHolder: HolderAnonymity[] = paidOwners.map(([owner, p]) => {
    const m = new Map<number, number>();
    for (const k of p.exponents) m.set(k, (m.get(k) ?? 0) + 1);
    let crowd = Infinity;
    let bits = 0;
    for (const [k, c] of m) {
      crowd = Math.min(crowd, H[k]);
      bits += log2Binom(C[k], c);
    }
    return {
      owner,
      units: p.units,
      notes: p.exponents.length,
      crowd,
      bits,
      subsetBits: log2SubsetsSumming(C, Number(p.units)),
      mergedCrowd: unitsCount.get(p.units)!,
    };
  });

  return {
    holdersPaid: paidOwners.length,
    notes,
    groups: C.map((count, k) => ({ amountEach: batch.base << BigInt(k), count, holders: H[k], topHolderShare: count ? maxPerHolder[k] / count : 0 })).filter((g) => g.count > 0),
    perHolder,
    crowd: { min: Math.min(...perHolder.map((h) => h.crowd)), median: median(perHolder.map((h) => h.crowd)) },
    bits: { min: Math.min(...perHolder.map((h) => h.bits)), median: median(perHolder.map((h) => h.bits)) },
    subsetBits: { min: Math.min(...perHolder.map((h) => h.subsetBits)), median: median(perHolder.map((h) => h.subsetBits)) },
    bestGuessRate: maxPerHolder.reduce((a, b) => a + b, 0) / notes,
    mergedUnique: perHolder.filter((h) => h.mergedCrowd === 1).length,
    mergedCrowd: { min: Math.min(...perHolder.map((h) => h.mergedCrowd)), median: median(perHolder.map((h) => h.mergedCrowd)) },
  };
}

/** The naive alternative: one equal-amount group per exact amount (v1's "one batch per amount class"). */
export function analyzeExactAmounts(amounts: bigint[]): { holders: number; alone: number; crowd: { min: number; median: number } } {
  const paid = amounts.filter((a) => a > 0n);
  const n = new Map<bigint, number>();
  for (const a of paid) n.set(a, (n.get(a) ?? 0) + 1);
  const crowds = paid.map((a) => n.get(a)!);
  return { holders: paid.length, alone: crowds.filter((c) => c === 1).length, crowd: { min: Math.min(...crowds), median: median(crowds) } };
}

// ---------------------------------------------------------------- per holder (answers "show guessing success per holder, not just the average")
//
// The average above (bestGuessRate) hides who carries the risk. Per holder, against the best observer that targets
// THAT holder (knows the holder's public pattern m_k = how many notes of denomination k they got, and C_k = how many
// notes of k the batch has):
// - noteSuccess: the expected share of the holder's notes the observer attributes correctly. Within a denomination the
//   notes are interchangeable to anyone without the holder's viewing key (fresh addresses from fresh random ephemeral
//   keys, sorted by address), so every note of k is the holder's with probability m_k / C_k and no strategy does better:
//   sum_k m_k * (m_k / C_k) / n.
// - exposedNote: the holder's most exposed note, max_k m_k / C_k.
// - setSuccess: the probability of recovering the holder's whole note set for the epoch, prod_k 1 / C(C_k, m_k) = 2^-bits.
// Both are exact (checked against enumeration of every assignment in notes-epochs.test.ts).

export type Spread = { min: number; p10: number; median: number; p90: number; max: number };

/** min / p10 / median / p90 / max, linear interpolation between order statistics (the median of an even count is the mean of the two middle values). */
export function spread(xs: number[]): Spread {
  if (xs.length === 0) throw new Error('spread of nothing');
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => {
    const h = (s.length - 1) * p;
    const lo = Math.floor(h);
    const hi = Math.ceil(h);
    return s[lo] + (s[hi] - s[lo]) * (h - lo);
  };
  return { min: s[0], p10: q(0.1), median: q(0.5), p90: q(0.9), max: s[s.length - 1] };
}

export type HolderSuccess = {
  owner: Address;
  units: bigint;
  notes: number;
  pattern: { exponent: number; mine: number; groupNotes: number; groupHolders: number }[]; // ascending exponent
  noteSuccess: number;
  exposedNote: { exponent: number; share: number };
  setSuccess: number;
  bits: number;
};

/** Per-holder guessing success for one epoch (paid holders only; a holder owed less than one base unit has no note). */
export function holderSuccess(batch: ExpectedBatch): HolderSuccess[] {
  const C = new Map(batch.groups.map((g) => [g.exponent, g]));
  const out: HolderSuccess[] = [];
  for (const [owner, p] of batch.perOwner) {
    if (p.exponents.length === 0) continue;
    const m = new Map<number, number>();
    for (const k of p.exponents) m.set(k, (m.get(k) ?? 0) + 1);
    const pattern = [...m]
      .sort((a, b) => a[0] - b[0])
      .map(([exponent, mine]) => ({ exponent, mine, groupNotes: C.get(exponent)!.count, groupHolders: C.get(exponent)!.holders }));
    let hits = 0;
    let bits = 0;
    let exposedNote = { exponent: -1, share: 0 };
    for (const g of pattern) {
      const share = g.mine / g.groupNotes;
      hits += g.mine * share;
      bits += log2Binom(g.groupNotes, g.mine);
      if (share > exposedNote.share) exposedNote = { exponent: g.exponent, share };
    }
    out.push({ owner, units: p.units, notes: p.exponents.length, pattern, noteSuccess: hits / p.exponents.length, exposedNote, setSuccess: 2 ** -bits, bits });
  }
  return out;
}

/** Why a holder is exposed, in words (for the worst-holders list). */
export function whyExposed(h: HolderSuccess, kmax: number): string {
  const units = (k: number) => `${2 ** k}u`;
  const parts = h.pattern.map((g) => `${g.mine}x${units(g.exponent)}`).join(' + ');
  const worst = h.pattern.find((g) => g.exponent === h.exposedNote.exponent)!;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const where =
    worst.mine > 1 && worst.exponent === kmax
      ? `above the cap: ${worst.mine} of the ${worst.groupNotes} top (${units(kmax)}) notes, a group only ${worst.groupHolders} holders share`
      : worst.exponent === kmax
        ? `its ${units(kmax)} note is 1 of ${worst.groupNotes} in the top group (${worst.groupHolders} holders), the smallest crowd`
        : `its ${units(worst.exponent)} note is 1 of ${worst.groupNotes}`;
  return `${h.units} units = ${parts}; ${where} (${pct(h.exposedNote.share)} per such note)`;
}
