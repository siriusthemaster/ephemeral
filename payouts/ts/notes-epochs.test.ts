// v2, follow-up from @contractclaus: "Show guessing success per holder, not just the 3.1% average. Include carry across
// epochs too, and report payment delays alongside privacy gains."
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Address } from 'viem';
import { expectedBatch, type ExpectedBatch } from './notes.ts';
import { analyzeBatch, holderSuccess, spread } from './notes-anonymity.ts';
import { defaultPick, linkedSuccess, paymentDelays, runEpochs, successOverRun, type EpochRun } from './notes-epochs.ts';
import { epochsReport, holdersReport, labelAddress, worldBatch, worldHistory, RUN_EPOCHS, WORLD_BASE, WORLD_MIN_CROWD } from './notes-fixture.ts';

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
const history = worldHistory(RUN_EPOCHS);
const runs = new Map<bigint, EpochRun>();
const runAt = (base: bigint) => runs.get(base) ?? (runs.set(base, runEpochs(history, base, WORLD_MIN_CROWD)), runs.get(base)!);
let epochs: ReturnType<typeof epochsReport> | undefined;
const report = () => (epochs ??= epochsReport()); // the tables in PAYOUTS.md

// ---------------------------------------------------------------- 1. per holder, one epoch

/** Every distinct ordering of a multiset (the owners of a group's notes, in address order). */
function* orderings(xs: number[]): Generator<number[]> {
  if (xs.length === 0) return yield [];
  for (const v of new Set(xs)) {
    const rest = [...xs];
    rest.splice(rest.indexOf(v), 1);
    for (const r of orderings(rest)) yield [v, ...r];
  }
}

/** Exact: enumerate every assignment of a batch's notes to its holders, and score a targeted observer's every choice. */
function enumerate(batch: ExpectedBatch, owners: Address[]) {
  const groups = batch.groups.map((g) => ({
    k: g.exponent,
    members: owners.flatMap((o, i) => batch.perOwner.get(o)!.exponents.filter((e) => e === g.exponent).map(() => i)),
  }));
  // all joint assignments: one ordering per group, all equally likely (fresh random addresses, sorted)
  let joint: number[][][] = [[]];
  for (const g of groups) joint = joint.flatMap((j) => [...orderings(g.members)].map((o) => [...j, o]));
  return owners.map((_, i) => {
    // The observer targeting holder i picks, per group, as many positions as i has notes there: every choice of
    // positions, scored over every assignment.
    const choices: number[][][] = [[]];
    let all = choices;
    groups.forEach((g) => {
      const m = g.members.filter((x) => x === i).length;
      const subsets: number[][] = [];
      const rec = (start: number, cur: number[]) => {
        if (cur.length === m) return void subsets.push(cur);
        for (let p = start; p < g.members.length; p++) rec(p + 1, [...cur, p]);
      };
      rec(0, []);
      all = all.flatMap((c) => subsets.map((s) => [...c, s]));
    });
    const n = groups.reduce((s, g) => s + g.members.filter((x) => x === i).length, 0);
    const scores = all.map((choice) => {
      let hits = 0;
      let whole = 0;
      for (const a of joint) {
        let h = 0;
        choice.forEach((pos, gi) => pos.forEach((p) => (h += a[gi][p] === i ? 1 : 0)));
        hits += h;
        whole += h === n ? 1 : 0;
      }
      return { note: hits / (n * joint.length), set: whole / joint.length };
    });
    return { n, best: { note: Math.max(...scores.map((s) => s.note)), set: Math.max(...scores.map((s) => s.set)) }, worst: { note: Math.min(...scores.map((s) => s.note)) } };
  });
}

test('per-holder guessing success is exact: it matches an enumeration of every assignment and every observer choice', () => {
  // units 3, 4, 1, 2, 5 with minCrowd 3 -> cap at 2 units: 3 = 1+2, 4 = 2+2, 1 = 1, 2 = 2, 5 = 1+2+2
  const owners = [0, 1, 2, 3, 4].map((i) => labelAddress(`enum/${i}`));
  const units = [3n, 4n, 1n, 2n, 5n];
  const batch = expectedBatch(owners.map((o, i) => ({ owner: o, debt: units[i] * 10n, carryIn: 0n })), 10n, 3);
  assert.equal(batch.kmax, 1);
  const exact = enumerate(batch, owners);
  const hs = holderSuccess(batch);
  owners.forEach((o, i) => {
    const h = hs.find((x) => x.owner === o)!;
    assert.ok(Math.abs(h.noteSuccess - exact[i].best.note) < 1e-12, `holder ${i}: per note ${h.noteSuccess} vs ${exact[i].best.note}`);
    assert.ok(Math.abs(exact[i].worst.note - exact[i].best.note) < 1e-12, 'every choice scores the same: no strategy beats m_k / C_k');
    assert.ok(Math.abs(h.setSuccess - exact[i].best.set) < 1e-12, `holder ${i}: whole set ${h.setSuccess} vs ${exact[i].best.set}`);
  });
  // holder 1 (two of the six 2u notes): per note 2/6, whole set 1 / C(6, 2)
  const h1 = hs.find((x) => x.owner === owners[1])!;
  assert.equal(h1.noteSuccess, 2 / 6);
  assert.ok(Math.abs(h1.setSuccess - 1 / 15) < 1e-12);
  // consistent with the batch report: same bits; the per-note average over all notes is at most the MAP labelling rate
  const r = analyzeBatch(batch);
  for (const h of hs) assert.ok(Math.abs(h.bits - r.perHolder.find((x) => x.owner === h.owner)!.bits) < 1e-9);
  assert.ok(hs.reduce((s, h) => s + h.noteSuccess * h.notes, 0) / r.notes <= r.bestGuessRate);
});

test('per holder, 200 holders: min / p10 / median / p90 / max, and the 5 most exposed holders with why', (t) => {
  const r = holdersReport();
  const { batch } = worldBatch();
  const hs = holderSuccess(batch);
  assert.equal(r.paid, 178);
  assert.equal(r.unpaid, 22, 'owed less than one unit this epoch: no note, all of it carried');
  const s = spread(hs.map((h) => h.noteSuccess));
  assert.ok(s.median < 0.015 && s.p90 < 0.025, `typical holder: median ${pct(s.median)}, p90 ${pct(s.p90)}`);
  assert.ok(s.min >= 1 / 117 - 1e-12, 'nobody below 1 / (largest group)');

  // The average hides the tail: the 16-NFT holder's notes are attributed correctly ~15% of the time, 5x the average.
  assert.equal(r.worst[0].who, 'owner #0 (16 NFTs)');
  const whale = hs.find((h) => h.owner === r.worst[0].owner)!;
  assert.deepEqual(whale.pattern.map((g) => [g.exponent, g.mine, g.groupNotes, g.groupHolders]), [[0, 1, 57, 57], [4, 7, 42, 31]]);
  assert.ok(Math.abs(whale.noteSuccess - (1 / 57 + (7 * 7) / 42) / 8) < 1e-12);
  assert.ok(whale.noteSuccess > 4 * r.bestGuessRate);
  // A crowd of >= 20 holders is not a 1-in-20 bound per note: the share of the group's NOTES is what counts.
  assert.ok(whale.exposedNote.share > 1 / WORLD_MIN_CROWD);
  // All five most exposed holders sit above the cap: several notes of the top denomination.
  for (const w of r.worst) assert.match(w.why, /above the cap/);
  // Whole sets are another matter: nobody's whole set is recovered with more than 1 / (smallest group).
  for (const h of hs) assert.ok(h.setSuccess <= 1 / 42 + 1e-12);
  assert.ok(whale.setSuccess < 1e-9, 'the whale\'s whole set: 8 notes, 2^-30');
  // One step lower cap (8u top) halves the whale's exposure for 42 more notes.
  assert.equal(r.lowerCap.kmax, 3);
  assert.equal(r.lowerCap.notes, 401);
  assert.equal(r.lowerCap.worstNoteSuccess, '7.5%');

  t.diagnostic(`per note, min / p10 / median / p90 / max: ${r.spreads.noteSuccess} (average over notes ${pct(r.averageOverNotes)}, MAP labelling ${pct(r.bestGuessRate)})`);
  t.diagnostic(`most exposed note: ${r.spreads.exposedNote}; whole set: ${r.spreads.setSuccess}`);
  for (const w of r.worst) t.diagnostic(`${w.who}: ${w.noteSuccess} per note, whole set ${w.setSuccess}: ${w.why}`);
});

// ---------------------------------------------------------------- 2. across epochs, with carry

test('no link between epochs: 30 epochs with carry do not raise anyone\'s per-note success', (t) => {
  const run = runAt(WORLD_BASE);
  assert.equal(run.batches.length, RUN_EPOCHS);
  for (const b of run.batches) for (const g of b.groups) assert.ok(g.holders >= WORLD_MIN_CROWD);
  const first = spread(successOverRun(run, 1).map((h) => h.noteSuccess));
  const rows = [1, 3, 10, 30].map((T) => {
    const over = successOverRun(run, T);
    for (const h of over) assert.ok(h.noteSuccess <= h.worstEpoch + 1e-12, 'an average of epochs is never above the worst epoch');
    return { T, s: spread(over.map((h) => h.noteSuccess)), holders: over.length };
  });
  for (const r of rows) {
    assert.ok(r.s.median <= first.median + 1e-9, `T=${r.T}: median ${pct(r.s.median)} vs ${pct(first.median)}`);
    assert.ok(r.s.max <= first.max + 1e-9);
    t.diagnostic(`T=${r.T}: ${r.holders} holders, per note min / median / p90 / max ${pct(r.s.min)} / ${pct(r.s.median)} / ${pct(r.s.p90)} / ${pct(r.s.max)}`);
  }
});

test('linking across epochs does raise it: carry schedule, recurring denominations, merged totals', (t) => {
  const run = runAt(WORLD_BASE);
  const b0 = analyzeBatch(run.batches[0]);
  const med = (habit: 'schedule' | 'one-note' | 'merge', T: number) => spread(linkedSuccess(run, T, habit).map((x) => x.success)).median;

  // T = 1 is the single epoch: merge = 1 / (holders with the same payout), schedule = 1 / (holders paid at all).
  for (const x of linkedSuccess(run, 1, 'merge')) assert.equal(x.success, 1 / b0.perHolder.find((h) => h.owner === x.owner)!.mergedCrowd);
  for (const x of linkedSuccess(run, 1, 'schedule')) assert.equal(x.success, 1 / b0.holdersPaid);
  // one-note at T = 1, by hand for the whale: posterior ∝ (its notes of that denomination / its notes), over paid owners
  const whale = labelAddress('world/owner/0');
  const w = run.batches[0].perOwner.get(whale)!;
  const k = w.exponents[defaultPick(whale, 0, w.exponents.length)];
  const lk = (ex: number[]) => (ex.length ? ex.filter((e) => e === k).length / ex.length : 0);
  const norm = [...run.batches[0].perOwner.values()].reduce((s, p) => s + lk(p.exponents), 0);
  const got = linkedSuccess(run, 1, 'one-note').find((x) => x.owner === whale)!;
  assert.ok(Math.abs(got.success - lk(w.exponents) / norm) < 1e-12);

  for (const habit of ['one-note', 'merge'] as const) {
    let prev = 0;
    for (const T of [1, 3, 10, 30]) {
      const m = med(habit, T);
      assert.ok(m >= prev, `${habit}: median grows with linked epochs`);
      prev = m;
    }
  }
  assert.ok(med('one-note', 1) < 0.02, 'one linked note: like the single epoch');
  assert.ok(med('one-note', 10) > 0.5, 'one note per epoch to one place for 10 epochs: the median holder is more likely named than not');
  assert.equal(med('one-note', 30), 1, '30 epochs: the median holder is named outright');
  assert.equal(med('merge', 10), 1, 'merging every epoch (H3): the median holder is named outright after 10');
  const sched = linkedSuccess(run, 30, 'schedule');
  const namedBySchedule = sched.filter((x) => x.candidates === 1).length;
  assert.ok(namedBySchedule > 20, `the carry schedule alone (which epochs a holder is paid at all) names ${namedBySchedule} holders in 30 epochs`);

  const rep = report();
  t.diagnostic(`T = ${rep.T.join(', ')} linked epochs (median / p90 success, holders named outright):`);
  for (const [k, v] of Object.entries(rep.linking)) t.diagnostic(`  ${k}: ${(v as string[]).join(' | ')}`);
});

// ---------------------------------------------------------------- 3. payment delay vs privacy

test('payment delay from rounding + carry, per holder, in epochs and wei, against the privacy it buys', (t) => {
  const rows = [10n ** 13n, 10n ** 14n, 10n ** 15n].map((base) => {
    const run = runAt(base);
    const d = paymentDelays(run); // throws if the FIFO queue ever disagrees with the rule's carry
    // per owner: the carry is always below one unit, and what is open at the end is exactly cumulative debt - paid
    for (const x of d) {
      assert.ok(x.maxCarry < base && x.open < base);
      const debt = run.lines.flat().filter((l) => l.owner === x.owner).reduce((s, l) => s + l.debt, 0n);
      const paid = run.batches.reduce((s, b) => s + (b.perOwner.get(x.owner)?.paid ?? 0n), 0n);
      assert.equal(paid + x.open, debt);
    }
    // while a holder accrues every epoch, no wei waits longer than ceil((base - 1) / its smallest epoch debt)
    for (const x of d.filter((y) => y.accruedEveryEpoch)) {
      const dmin = run.lines.map((ls) => ls.find((l) => l.owner === x.owner)!.debt).reduce((m, v) => (v < m ? v : m));
      assert.ok(x.maxDelayAccruing <= Number((base - 1n + dmin - 1n) / dmin), `${x.owner}: waited ${x.maxDelayAccruing}`);
    }
    return { base, run, d, mean: spread(d.map((x) => x.meanDelay)), over: spread(successOverRun(run).map((h) => h.noteSuccess)), a: analyzeBatch(run.batches[0]) };
  });
  // Coarser base: more delay, fewer notes, smaller merge leak.
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].mean.median > rows[i - 1].mean.median && rows[i].mean.max > rows[i - 1].mean.max);
    assert.ok(rows[i].a.notes < rows[i - 1].a.notes);
    assert.ok(rows[i].a.mergedUnique < rows[i - 1].a.mergedUnique);
  }
  const [b13, b14, b15] = rows;
  assert.equal(Math.max(...b13.d.map((x) => x.maxDelayAccruing)), 1, '1e13: nobody who keeps accruing waits more than one epoch');
  assert.ok(b14.mean.median < 0.1, '1e14: the median holder\'s wei waits under 0.1 epoch on average');
  assert.ok(b15.d.filter((x) => x.maxDelayAccruing > 1).length > 100, '1e15: most holders wait more than an epoch for part of their debt');
  // Per-note success does not improve with a coarser base: it is set by the share of the top group, not by the unit.
  assert.ok(Math.abs(b15.over.median - b14.over.median) < 0.005);

  for (const r of report().tradeOff) {
    t.diagnostic(`base ${r.base}: ${r.notesPerEpoch} notes/epoch, per note median / max ${r.noteSuccess}, merged unique ${r.mergedUnique}, linked 10 epochs median ${r.linked10Median}; delay (epochs, holder mean) median / p90 / max ${r.meanDelayEpochs}, longest wait while accruing ${r.maxWaitAccruing} (${r.holdersWaitingOver1} holders > 1), any ${r.maxWaitAny}; carry median / max ${r.carryEth} ETH; open at end ${r.openAtEnd.eth} ETH, oldest ${r.openAtEnd.oldest} epochs`);
  }
});
