import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, getAddress, keccak256, toHex, type Address } from 'viem';
import { generateStealthAddress, parseMetaAddress } from './stealth.ts';
import { buildTree } from './proof.ts';
import {
  auditNotesEpoch,
  decompose,
  expectedBatch,
  findMyNotes,
  noteLeafHash,
  notesOf,
  planNotesEpoch,
  roundDown,
  settleNotesCalldata,
  splitParts,
  STEALTH_PAYOUT_V2_ABI,
  summarizeParts,
  topExponent,
  MAX_NOTES_PER_TX,
  withCarries,
  type NotesPlan,
} from './notes.ts';
import { analyzeBatch, analyzeExactAmounts, log2SubsetsSumming } from './notes-anonymity.ts';
import { smallPlan, smallWorld, SMALL_BASE, SMALL_EPOCH, SMALL_MIN_CROWD, world, worldBatch, worldHistory, WORLD_BASE, WORLD_MIN_CROWD, labelAddress } from './notes-fixture.ts';
import { testKeys } from './fixture.ts';
import { metaAddressOf } from './stealth.ts';

const strip = (h: string) => h.slice(2).toLowerCase();
const sumPlan = (p: Pick<NotesPlan, 'groups'>) => p.groups.reduce((s, g) => s + g.amountEach * BigInt(g.recipients.length), 0n);

// ---------------------------------------------------------------- the public rule

test('the public rule: round down to the base unit, carry the rest, binary notes below the cap, top notes above it', () => {
  assert.deepEqual(roundDown(1234n, 0n, 100n), { units: 12n, paid: 1200n, carryOut: 34n });
  assert.deepEqual(roundDown(1234n, 66n, 100n), { units: 13n, paid: 1300n, carryOut: 0n });
  assert.deepEqual(roundDown(5n, 0n, 100n), { units: 0n, paid: 0n, carryOut: 5n });
  assert.throws(() => roundDown(1n, 0n, 0n), /positive/);

  assert.deepEqual(decompose(13n, 10), [0, 2, 3]); // 13 = 1 + 4 + 8
  assert.deepEqual(decompose(13n, 2), [0, 2, 2, 2]); // 13 = 1 + 3 * 4: no 8 note below the cap
  assert.deepEqual(decompose(0n, 4), []);
  for (let u = 0n; u < 300n; u++) for (const k of [0, 1, 3, 5, 9]) assert.equal(decompose(u, k).reduce((s, e) => s + (1n << BigInt(e)), 0n), u);

  // The cap: the largest denomination at least minCrowd holders get, with every used lower one shared as widely.
  const units = [1n, 2n, 3n, 5n, 6n, 7n, 9n, 12n, 100n]; // one big holder
  const k = topExponent(units, 3);
  assert.equal(k, 3, 'three holders reach 8 units (9, 12, 100), only one reaches 16: no 16, 32 or 64 note for the big holder');
  assert.deepEqual(decompose(100n, k), [2, ...Array(12).fill(3)], '100 = 4 + 12 * 8');
  const b = expectedBatch(units.map((u, i) => ({ owner: labelAddress(`rule/${i}`), debt: u * 10n, carryIn: 0n })), 10n, 3);
  for (const g of b.groups) assert.ok(g.holders >= 3, `${g.amountEach}: ${g.holders} holders`);
  assert.equal(b.declaredTotal, units.reduce((s, u) => s + u, 0n) * 10n);
  assert.throws(() => topExponent([1n, 2n], 3), /Only 2 holders/);
  assert.throws(() => expectedBatch([{ owner: labelAddress('x'), debt: 1n, carryIn: 10n }], 10n, 1), /carry/i);
});

test('carry-over keeps every holder exact across 30 epochs, through sales and new owners', () => {
  const history = withCarries(worldHistory(30), WORLD_BASE);
  const debt = new Map<Address, bigint>();
  const paid = new Map<Address, bigint>();
  const carry = new Map<Address, bigint>();
  let minCrowd = Infinity;
  for (const lines of history) {
    const b = expectedBatch(lines, WORLD_BASE, WORLD_MIN_CROWD);
    minCrowd = Math.min(minCrowd, ...b.groups.map((g) => g.holders));
    let notesSum = 0n;
    for (const l of lines) {
      const p = b.perOwner.get(l.owner)!;
      assert.equal(l.carryIn, carry.get(l.owner) ?? 0n, 'carry in == last carry out (public, recomputable)');
      assert.ok(p.carryOut >= 0n && p.carryOut < WORLD_BASE);
      assert.equal(p.paid + p.carryOut, l.debt + l.carryIn);
      assert.equal(p.exponents.reduce((s, e) => s + (WORLD_BASE << BigInt(e)), 0n), p.paid, 'notes add up to the rounded amount');
      debt.set(l.owner, (debt.get(l.owner) ?? 0n) + l.debt);
      paid.set(l.owner, (paid.get(l.owner) ?? 0n) + p.paid);
      carry.set(l.owner, p.carryOut);
      notesSum += p.paid;
    }
    assert.equal(notesSum, b.declaredTotal);
  }
  let owed = 0n;
  let settled = 0n;
  let open = 0n;
  for (const [o, d] of debt) {
    assert.equal(paid.get(o)! + carry.get(o)!, d, `${o}: cumulative paid + carry == cumulative debt, to the wei`);
    owed += d;
    settled += paid.get(o)!;
    open += carry.get(o)!;
  }
  assert.equal(settled + open, owed);
  assert.ok(open < BigInt(debt.size) * WORLD_BASE, 'what is still carried is below one base unit per owner');
  assert.ok(minCrowd >= WORLD_MIN_CROWD, `every denomination of every epoch shared by >= ${WORLD_MIN_CROWD} holders (min ${minCrowd})`);
  assert.ok(debt.size > 200, `${debt.size} owners over 30 epochs, including sellers and new buyers`);
});

// ---------------------------------------------------------------- the operator plan

test('the plan: one equal-amount group per denomination, ascending, fresh addresses, nothing per holder in the calldata', () => {
  const { owners, lines, plan } = smallPlan();
  assert.equal(sumPlan(plan), plan.declaredTotal);
  for (let j = 1; j < plan.groups.length; j++) assert.ok(plan.groups[j - 1].amountEach < plan.groups[j].amountEach, 'groups ascending');
  const all = plan.groups.flatMap((g) => g.recipients);
  assert.equal(new Set(all.map((r) => r.stealthAddress)).size, all.length, 'no address twice in the epoch');
  assert.equal(new Set(all.map((r) => r.ephemeralPubKey)).size, all.length, 'a fresh ephemeral key per note');
  for (const g of plan.groups) {
    assert.ok(g.amountEach % SMALL_BASE === 0n && ((g.amountEach / SMALL_BASE) & (g.amountEach / SMALL_BASE - 1n)) === 0n, 'base * 2^k');
    for (let i = 1; i < g.recipients.length; i++) assert.ok(BigInt(g.recipients[i - 1].stealthAddress) < BigInt(g.recipients[i].stealthAddress));
  }
  assert.equal(plan.leaves.length, plan.receipts.length);

  // Per owner: the notes add up to the rounded debt; the rest is carried.
  for (const l of lines) {
    const mine = plan.receipts.filter((r) => r.owner === l.owner);
    const { paid, carryOut } = roundDown(l.debt, l.carryIn, SMALL_BASE);
    assert.equal(mine.reduce((s, r) => s + r.denomination, 0n), paid);
    assert.equal(plan.carryOut.get(l.owner), carryOut);
  }
  const erin = owners.find((o) => o.name === 'erin')!;
  assert.equal(plan.receipts.filter((r) => r.owner === erin.owner).length, 0, 'erin owes less than one unit: all of it carries');
  assert.equal(plan.carryOut.get(erin.owner), lines.find((l) => l.owner === erin.owner)!.debt);

  // The transaction input: epoch, root, declared total and (amount, [address, key, tag]) groups. No owner, wallet,
  // meta-address, debt or carry.
  const data = settleNotesCalldata(plan, plan.groups);
  const d = decodeFunctionData({ abi: STEALTH_PAYOUT_V2_ABI, data });
  assert.equal(d.args[0], SMALL_EPOCH);
  assert.equal(d.args[2], plan.declaredTotal);
  for (const o of owners) {
    for (const secretish of [o.owner, o.metaAddress, o.keys.viewingPublicKey, o.keys.spendingPublicKey]) {
      assert.ok(!data.toLowerCase().includes(strip(secretish)), `${o.name}: ${secretish.slice(0, 12)}… not in calldata`);
    }
  }
  for (const l of lines) for (const v of [l.debt, l.carryIn, l.debt + l.carryIn]) if (v > 0n) assert.ok(!data.includes(v.toString(16).padStart(64, '0')), 'no debt in calldata');
});

test('parts: an epoch too big for one transaction splits into ascending parts that add up to the declared total', () => {
  const { plan } = smallPlan();
  for (const max of [1, 4, 5, 20, 21, 100]) {
    const parts = splitParts(plan, max);
    assert.equal(parts.reduce((s, p) => s + p.value, 0n), plan.declaredTotal);
    assert.equal(parts.length, Math.ceil(plan.receipts.length / max));
    const flat = parts.flatMap((p) => p.groups.flatMap((g) => g.recipients.map((r) => [g.amountEach, r.stealthAddress] as const)));
    assert.deepEqual(flat, plan.groups.flatMap((g) => g.recipients.map((r) => [g.amountEach, r.stealthAddress] as const)), 'same notes, same order');
    for (const p of parts) {
      assert.ok(p.notes <= max);
      for (let j = 1; j < p.groups.length; j++) assert.ok(p.groups[j - 1].amountEach < p.groups[j].amountEach);
    }
  }
});

// ---------------------------------------------------------------- holders

test('each holder finds exactly their notes from public data, and notices a misstated debt or a missing note, privately', () => {
  const { owners, lines, plan } = smallPlan();
  const notes = notesOf(plan);
  const found = new Set<string>();
  for (const o of owners) {
    const l = lines.find((x) => x.owner === o.owner)!;
    const m = findMyNotes(o.keys, { epoch: plan.epoch, base: plan.base, owner: o.owner, debt: l.debt, carryIn: l.carryIn, notes, leaves: plan.leaves });
    assert.deepEqual(m.unmatched, []);
    assert.equal(m.complete, true, `${o.name}: notes add up to exactly the ledger line`);
    const operatorCopy = plan.receipts.filter((r) => r.owner === o.owner);
    assert.equal(m.receipts.length, operatorCopy.length);
    for (const r of m.receipts) {
      assert.deepEqual(r, operatorCopy.find((x) => x.stealthAddress === r.stealthAddress), 'same receipt the operator holds');
      assert.ok(!found.has(r.stealthAddress));
      found.add(r.stealthAddress);
    }
  }
  assert.equal(found.size, plan.receipts.length, 'every note found by its owner, by nobody else');

  // The operator misstates dave's debt (one unit less) in his leaves: dave sees notes that do not open to his ledger line.
  const { owners: o2, lines: l2, holders } = smallWorld();
  const dave = o2.find((o) => o.name === 'dave')!;
  const daveLine = l2.find((l) => l.owner === dave.owner)!;
  const lied = planNotesEpoch({
    epoch: SMALL_EPOCH, base: SMALL_BASE, minCrowd: SMALL_MIN_CROWD,
    holders: holders.map((h) => (h.owner === dave.owner ? { ...h, debt: h.debt - SMALL_BASE } : h)),
  });
  const d = findMyNotes(dave.keys, { epoch: SMALL_EPOCH, base: SMALL_BASE, owner: dave.owner, debt: daveLine.debt, carryIn: daveLine.carryIn, notes: notesOf(lied), leaves: lied.leaves });
  assert.equal(d.receipts.length, 0);
  assert.ok(d.unmatched.length > 0, 'paid, but committed to another debt');
  assert.equal(d.complete, false);
});

// ---------------------------------------------------------------- the public audit

test('public audit: the notes paid are exactly the multiset the public ledger implies; a remapping is invisible to it', () => {
  const { owners, lines, plan } = smallPlan();
  const expected = expectedBatch(lines, SMALL_BASE, SMALL_MIN_CROWD);
  const table = (p: Pick<NotesPlan, 'groups'>) => p.groups.map((g) => ({ amountEach: g.amountEach, count: g.recipients.length }));
  assert.deepEqual(auditNotesEpoch(expected, summarizeParts(plan.declaredTotal, [table(plan)])), { ok: true, problems: [] });
  assert.equal(auditNotesEpoch(expected, summarizeParts(plan.declaredTotal, splitParts(plan, 5).map(table))).ok, true, 'parts add up');
  assert.match(auditNotesEpoch(expected, summarizeParts(plan.declaredTotal, splitParts(plan, 5).slice(0, -1).map(table))).problems.join(), /incomplete/);
  assert.match(auditNotesEpoch(expected, summarizeParts(plan.declaredTotal - SMALL_BASE, [table(plan)])).problems.join(), /declared total/);

  // One note fewer, or one note of the wrong denomination: caught by anyone.
  const fewer = table(plan).map((g, j) => (j === 0 ? { ...g, count: g.count - 1 } : g));
  assert.equal(auditNotesEpoch(expected, summarizeParts(plan.declaredTotal, [fewer])).ok, false);
  const other = [...table(plan), { amountEach: SMALL_BASE * 3n, count: 1 }];
  assert.match(auditNotesEpoch(expected, summarizeParts(plan.declaredTotal, [other])).problems.join(), /does not imply/);

  // The limit: the operator pays one of frank's notes to an address of its own (same amount, a leaf for a made-up owner).
  // The multiset is unchanged, so the public audit passes. Only frank sees it: his notes no longer add up.
  const frank = owners.find((o) => o.name === 'frank')!;
  const frankLine = lines.find((l) => l.owner === frank.owner)!;
  const stolen = plan.receipts.find((r) => r.owner === frank.owner)!;
  const thiefKeys = testKeys('operator-own');
  const g = generateStealthAddress(parseMetaAddress(metaAddressOf(thiefKeys)), keccak256(toHex('thief eph')));
  const fakeLeaf = noteLeafHash(plan.epoch, labelAddress('made-up owner'), 1n, 0n, getAddress(g.stealthAddress), stolen.denomination, keccak256(toHex('s')));
  const remapped: NotesPlan = {
    ...plan,
    groups: plan.groups.map((grp) =>
      grp.amountEach !== stolen.denomination
        ? grp
        : {
            ...grp,
            recipients: [
              ...grp.recipients.filter((r) => r.stealthAddress !== stolen.stealthAddress),
              { stealthAddress: getAddress(g.stealthAddress), ephemeralPubKey: g.ephemeralPublicKey, viewTag: toHex(g.viewTag, { size: 1 }) },
            ].sort((a, b) => (BigInt(a.stealthAddress) < BigInt(b.stealthAddress) ? -1 : 1)),
          },
    ),
    leaves: buildTree([...plan.leaves.filter((l) => l !== stolen.leaf.toLowerCase()), fakeLeaf]).leaves,
  };
  assert.equal(auditNotesEpoch(expected, summarizeParts(plan.declaredTotal, [table(remapped)])).ok, true, 'public audit cannot see a remapping');
  const f = findMyNotes(frank.keys, { epoch: plan.epoch, base: plan.base, owner: frank.owner, debt: frankLine.debt, carryIn: frankLine.carryIn, notes: notesOf(remapped), leaves: remapped.leaves });
  assert.equal(f.complete, false, 'frank notices privately');
  assert.equal(f.expected - f.paid, stolen.denomination);
});

// ---------------------------------------------------------------- the observer, 200 holders

test('observer with all public data, 200 holders: amounts point to groups of >= 20 holders, never to one holder', (t) => {
  const { lines, batch } = worldBatch();
  assert.equal(lines.length, 200);
  const r = analyzeBatch(batch);

  // What the chain shows is a multiset of denominations, and that multiset is a function of the public ledger.
  assert.deepEqual(batch.groups.map((g) => g.amountEach), [1n, 2n, 4n, 8n, 16n].map((u) => u * WORLD_BASE));

  // Matching by amount: for every holder, the payments of exactly their payout amount are either none or a group shared
  // by >= minCrowd holders, and every note they got sits in a group of >= minCrowd holders.
  const groupOf = new Map(batch.groups.map((g) => [g.amountEach, g]));
  for (const [, p] of batch.perOwner) {
    if (p.paid === 0n) continue;
    const same = groupOf.get(p.paid);
    if (same) assert.ok(same.holders >= WORLD_MIN_CROWD);
    for (const e of p.exponents) assert.ok(groupOf.get(WORLD_BASE << BigInt(e))!.holders >= WORLD_MIN_CROWD);
  }
  assert.ok(r.crowd.min >= WORLD_MIN_CROWD);

  // Against the alternatives.
  const exact = analyzeExactAmounts(lines.map((l) => l.debt));
  const plain = analyzeBatch(expectedBatch(lines, WORLD_BASE, WORLD_MIN_CROWD, { kmax: 64 }));
  assert.ok(exact.alone > 100, 'one group per exact amount: more than half the holders alone in their group');
  assert.equal(plain.crowd.min, 1, 'binary notes with no cap: the largest holders get notes nobody else gets');
  assert.ok(r.bestGuessRate < 0.05, 'an optimal observer attributes under 5% of notes correctly');
  assert.ok(r.mergedUnique > 0, 'H3 still applies: merging all your notes shows your total, and some totals are unique');

  // The subset-sum count matches brute force on a small batch.
  const small = [3, 2, 1];
  for (let target = 0; target <= 9; target++) {
    let ways = 0;
    const items = small.flatMap((c, k) => Array(c).fill(1 << k));
    for (let m = 0; m < 1 << items.length; m++) if (items.reduce((s, v, i) => s + (m & (1 << i) ? v : 0), 0) === target) ways++;
    assert.equal(ways === 0 ? -Infinity : Math.round(2 ** log2SubsetsSumming(small, target)), ways === 0 ? -Infinity : ways);
  }

  t.diagnostic(`holders 200 (paid ${r.holdersPaid}), notes ${r.notes}, kmax ${batch.kmax}: ${r.groups.map((g) => `${g.amountEach / WORLD_BASE}u x${g.count}/${g.holders}h`).join(' ')}`);
  t.diagnostic(`crowd min ${r.crowd.min} median ${r.crowd.median}; bits min ${r.bits.min.toFixed(1)} median ${r.bits.median.toFixed(1)}; subset bits min ${r.subsetBits.min.toFixed(1)} median ${r.subsetBits.median.toFixed(1)}`);
  t.diagnostic(`best-guess ${(r.bestGuessRate * 100).toFixed(1)}%; merged totals unique ${r.mergedUnique}; exact amounts alone ${exact.alone}; no cap: min crowd ${plain.crowd.min}, ${plain.perHolder.filter((h) => h.crowd < WORLD_MIN_CROWD).length} holders below ${WORLD_MIN_CROWD}`);
});

test('the 200-holder plan with real stealth addresses: unique, sorted, adds up, splits under a per-transaction cap', () => {
  const w = world();
  const holders = w.debts.map((d, i) => ({ owner: d.owner, debt: d.debt, carryIn: 0n, metaAddress: metaAddressOf(testKeys(`world/${i}`)) }));
  const plan = planNotesEpoch({ epoch: 1n, base: WORLD_BASE, minCrowd: WORLD_MIN_CROWD, holders });
  const { batch } = worldBatch();
  assert.equal(plan.declaredTotal, batch.declaredTotal);
  assert.deepEqual(plan.groups.map((g) => [g.amountEach, g.recipients.length]), batch.groups.map((g) => [g.amountEach, g.count]), 'the chain shows exactly the public multiset');
  const all = plan.groups.flatMap((g) => g.recipients.map((r) => r.stealthAddress));
  assert.equal(new Set(all).size, all.length);
  assert.equal(sumPlan(plan), plan.declaredTotal);
  const parts = splitParts(plan, MAX_NOTES_PER_TX);
  assert.equal(parts.length, 2, `${plan.receipts.length} notes in parts of <= ${MAX_NOTES_PER_TX}`);
  assert.equal(parts.reduce((s, p) => s + p.value, 0n), plan.declaredTotal);
});
