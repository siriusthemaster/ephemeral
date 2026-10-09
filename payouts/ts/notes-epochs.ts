// v2 across epochs (answers "Include carry across epochs too, and report payment delays alongside privacy gains").
//
// A run is a sequence of epochs: each epoch's public ledger lines with the carries filled in (withCarries), and the
// public batch the rule implies. Three questions, all from public data:
//
// 1. Without a link between epochs, does guessing success grow with more epochs? (successOverRun) No. Every note goes
//    to a fresh address from a fresh random ephemeral key, so an observer without viewing keys sees nothing that ties a
//    note of one epoch to a note of another: the epochs' assignments are independent and each note's attribution stays
//    at its own epoch's m_k / C_k. Carries and recurring patterns are functions of the public ledger, which the observer
//    already has; they tie nothing to anything by themselves.
// 2. With a link, how fast does it grow? (linkedSuccess) A link is something the holder does: sending notes of
//    several epochs to one place (an exchange deposit address, a sweep wallet). The observer then intersects the
//    candidates epoch by epoch. Three habits, from weakest to strongest signal:
//    - 'schedule'  (carry pattern): the observer uses only WHEN the destination received something. A holder owed less
//                  than one base unit per epoch is paid only in the epochs their carry crosses a unit, a public schedule.
//    - 'one-note'  (recurring denominations): every epoch they are paid, the holder sends one of their notes, picked at
//                  random, to the same destination. A holder whose debt is stable gets the same pattern every epoch.
//    - 'merge'     (H3 broken every epoch): the holder sends all of the epoch's notes, so the destination shows each
//                  epoch's total, which the public ledger names.
// 3. What do rounding down and carrying cost each holder? (paymentDelays) In epochs (how long each wei of debt waits,
//    first in first out) and in wei (what is owed but not yet paid at the end of each epoch, always < base).
//
// Pure functions, no keys, no network.
import { keccak256, toHex, type Address } from 'viem';
import { expectedBatch, withCarries, type ExpectedBatch, type LedgerEntry } from './notes.ts';
import { holderSuccess } from './notes-anonymity.ts';

export type EpochRun = { base: bigint; minCrowd: number; lines: LedgerEntry[][]; batches: ExpectedBatch[]; owners: Address[] };

/** Public: the ledger lines with carries and the batch for every epoch of a history of debts. */
export function runEpochs(history: { owner: Address; debt: bigint }[][], base: bigint, minCrowd: number): EpochRun {
  const lines = withCarries(history, base);
  const batches = lines.map((l) => expectedBatch(l, base, minCrowd));
  const owners = [...new Set(lines.flat().map((l) => l.owner))];
  return { base, minCrowd, lines, batches, owners };
}

// ---------------------------------------------------------------- 1. no link: notes attributed one epoch at a time

export type HolderOverRun = { owner: Address; notes: number; noteSuccess: number; worstEpoch: number };

/**
 * Per holder paid at least once in epochs 0..T-1: the expected share of all their notes the best observer attributes
 * correctly when it can only work epoch by epoch (sum over epochs of m_k^2 / C_k, over their note count), and their worst
 * single epoch.
 */
export function successOverRun(run: EpochRun, T = run.batches.length): HolderOverRun[] {
  if (T < 1 || T > run.batches.length) throw new Error(`T must be 1..${run.batches.length}`);
  const acc = new Map<Address, HolderOverRun>();
  for (let e = 0; e < T; e++) {
    for (const h of holderSuccess(run.batches[e])) {
      const a = acc.get(h.owner) ?? { owner: h.owner, notes: 0, noteSuccess: 0, worstEpoch: 0 };
      a.noteSuccess = (a.noteSuccess * a.notes + h.noteSuccess * h.notes) / (a.notes + h.notes);
      a.notes += h.notes;
      a.worstEpoch = Math.max(a.worstEpoch, h.noteSuccess);
      acc.set(h.owner, a);
    }
  }
  return [...acc.values()];
}

// ---------------------------------------------------------------- 2. linked: one destination across epochs

export type Habit = 'schedule' | 'one-note' | 'merge';
export type LinkedSuccess = { owner: Address; success: number; candidates: number };

/** The note a holder forwards in an epoch under 'one-note': deterministic stand-in for a random pick. */
export const defaultPick = (owner: Address, epoch: number, notes: number) =>
  Number(BigInt(keccak256(toHex(`link/${owner.toLowerCase()}/${epoch}`))) % BigInt(notes));

/**
 * One destination linked across epochs 0..T-1; the observer knows the habit and asks whose destination it is, with a
 * uniform prior over every owner of the run. Per holder paid at least once in 0..T-1: `success` is the probability the
 * observer's posterior puts on the right holder (for 'schedule' and 'merge' the posterior is uniform over the owners
 * whose public schedule or totals match, so success = 1 / candidates); `candidates` = owners with a non-zero posterior.
 * At T = 1 nothing is linked yet: that is the single-epoch number for the same habit.
 */
export function linkedSuccess(run: EpochRun, T: number, habit: Habit, pick = defaultPick): LinkedSuccess[] {
  if (T < 1 || T > run.batches.length) throw new Error(`T must be 1..${run.batches.length}`);
  // per epoch, per owner (by index): note count, notes per denomination, total paid
  const view = run.batches.slice(0, T).map((b) =>
    run.owners.map((o) => {
      const p = b.perOwner.get(o);
      const per = new Map<number, number>();
      for (const k of p?.exponents ?? []) per.set(k, (per.get(k) ?? 0) + 1);
      return { exps: p?.exponents ?? [], n: p?.exponents.length ?? 0, per, paid: p?.paid ?? 0n };
    }),
  );
  const out: LinkedSuccess[] = [];
  run.owners.forEach((i, ii) => {
    // What the destination shows in each epoch: nothing (null), or the denomination / total that arrived.
    const seen: (bigint | null)[] = view.map((v, e) => {
      const x = v[ii];
      if (x.n === 0) return null;
      if (habit === 'schedule') return 1n;
      if (habit === 'one-note') return BigInt(x.exps[pick(i, e, x.n)]);
      return x.paid;
    });
    if (seen.every((s) => s === null)) return;
    let total = 0;
    let mine = 0;
    let candidates = 0;
    run.owners.forEach((_, jj) => {
      let lk = 1;
      for (let e = 0; e < T && lk > 0; e++) {
        const x = view[e][jj];
        const s = seen[e];
        if (s === null) lk *= x.n === 0 ? 1 : 0;
        else if (x.n === 0) lk = 0;
        else if (habit === 'one-note') lk *= (x.per.get(Number(s)) ?? 0) / x.n;
        else if (habit === 'merge') lk *= x.paid === s ? 1 : 0;
      }
      if (lk > 0) candidates++;
      total += lk;
      if (jj === ii) mine = lk;
    });
    out.push({ owner: i, success: mine / total, candidates });
  });
  return out;
}

// ---------------------------------------------------------------- 3. what rounding and carry cost each holder

export type HolderDelay = {
  owner: Address;
  accruedEveryEpoch: boolean; // a ledger line in every epoch of the run
  meanDelay: number; // epochs between accrual and payment, weighted by wei, over the debt paid within the run (FIFO)
  maxDelay: number; // the longest any of its paid debt waited
  maxDelayAccruing: number; // the same, counting only waits during which it had a ledger line every epoch
  meanCarry: bigint; // owed but not yet paid at the end of each epoch from its first line on, averaged (wei)
  maxCarry: bigint; // the most it was ever owed after a settlement (< base)
  open: bigint; // still carried after the last epoch (< base)
  openSince: number; // epochs the oldest open wei has waited by then (0 if none open)
};

/**
 * Per owner: how long each wei of debt waits before a note pays it (first in, first out), and how much is owed between
 * settlements. Checks the FIFO queue against the public rule's carry at every step.
 */
export function paymentDelays(run: EpochRun): HolderDelay[] {
  const out: HolderDelay[] = [];
  const E = run.batches.length;
  for (const o of run.owners) {
    const queue: { e: number; wei: bigint }[] = [];
    const hasLine: boolean[] = [];
    let weighted = 0;
    let weights = 0;
    let maxDelay = 0;
    let maxDelayAccruing = 0;
    let carrySum = 0n;
    let carryN = 0n;
    let maxCarry = 0n;
    for (let e = 0; e < E; e++) {
      const p = run.batches[e].perOwner.get(o);
      hasLine.push(!!p);
      if (p) {
        if (p.debt > 0n) queue.push({ e, wei: p.debt });
        let pay = p.paid;
        while (pay > 0n) {
          const s = queue[0];
          const t = s.wei < pay ? s.wei : pay;
          const d = e - s.e;
          weighted += Number(t) * d;
          weights += Number(t);
          maxDelay = Math.max(maxDelay, d);
          if (hasLine.slice(s.e).every(Boolean)) maxDelayAccruing = Math.max(maxDelayAccruing, d);
          s.wei -= t;
          pay -= t;
          if (s.wei === 0n) queue.shift();
        }
        const owed = queue.reduce((a, s) => a + s.wei, 0n);
        if (owed !== p.carryOut) throw new Error(`${o} epoch ${e}: FIFO owes ${owed}, the rule carries ${p.carryOut}`);
      }
      if (hasLine.some(Boolean)) {
        const owed = queue.reduce((a, s) => a + s.wei, 0n);
        carrySum += owed;
        carryN++;
        if (owed > maxCarry) maxCarry = owed;
      }
    }
    const open = queue.reduce((a, s) => a + s.wei, 0n);
    out.push({
      owner: o,
      accruedEveryEpoch: hasLine.every(Boolean),
      meanDelay: weights === 0 ? 0 : weighted / weights,
      maxDelay,
      maxDelayAccruing,
      meanCarry: carryN === 0n ? 0n : carrySum / carryN,
      maxCarry,
      open,
      openSince: queue.length === 0 ? 0 : E - 1 - queue[0].e,
    });
  }
  return out;
}
