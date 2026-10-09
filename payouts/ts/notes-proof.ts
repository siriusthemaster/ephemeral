// v2 private proof: "these notes settled exactly my debt for epoch N", shown to ONE verifier.
//
// The holder opens all their notes of the epoch to that verifier: for each, the stealth address, denomination, salt and
// Merkle path, and a signature by the note's stealth key. Every leaf commits (epoch, owner, debt, carryIn), so the
// verifier recomputes each leaf with the stated debt and carry, checks it is in the root settled on chain, that the address
// was paid exactly that denomination in that epoch, and that the denominations add up to exactly what the debt pays:
// sum == floor((debt + carryIn) / base) * base. The debt must equal the public ledger's line for the owner, and the owner
// wallet signs too, so "the right person's debt" is checked, not only "money reached an address".
//
// Pure functions (no network). The verifier reads the chain (NotesSettled, the announcements of the epoch's settle
// transactions, commitmentsRootOf) and the public ledger itself and passes the facts in.
import { concat, getAddress, isAddressEqual, keccak256, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { privateKeyToAccount, signTypedData } from 'viem/accounts';
import { verifyInclusion } from './proof.ts';
import { noteLeafHash, roundDown, type NoteReceipt } from './notes.ts';

export const DEBT_TYPES = {
  DebtSettled: [
    { name: 'payer', type: 'address' },
    { name: 'epoch', type: 'uint256' },
    { name: 'owner', type: 'address' },
    { name: 'debt', type: 'uint256' },
    { name: 'carryIn', type: 'uint256' },
    { name: 'paid', type: 'uint256' },
    { name: 'notes', type: 'bytes32' }, // keccak256 of the opened leaves, ascending
    { name: 'commitmentsRoot', type: 'bytes32' },
    { name: 'verifier', type: 'string' },
    { name: 'challenge', type: 'bytes32' }, // fresh nonce from the verifier: no replay
  ],
} as const;

export const debtDomain = (chainId: number, payoutContract: Address) =>
  ({ name: 'StealthPayout debt', version: '2', chainId, verifyingContract: getAddress(payoutContract) }) as const;

export type DebtStatement = {
  payer: Address;
  epoch: bigint;
  owner: Address;
  debt: bigint;
  carryIn: bigint;
  paid: bigint;
  notes: Hex;
  commitmentsRoot: Hex;
  verifier: string;
  challenge: Hex;
};

export type OpenedNote = { stealthAddress: Address; denomination: bigint; salt: Hex; merkleProof: Hex[]; signature: Hex };

export type DebtProof = { chainId: number; payoutContract: Address; statement: DebtStatement; notes: OpenedNote[]; ownerSignature: Hex };

const notesHash = (leaves: Hex[]) => keccak256(concat([...leaves].map((l) => l.toLowerCase() as Hex).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))));

/** Holder side. `stealthPrivateKeys[i]` controls `receipts[i].stealthAddress`. Nothing here is published. */
export async function proveDebtSettled(opts: {
  receipts: NoteReceipt[];
  stealthPrivateKeys: Hex[];
  ownerPrivateKey: Hex;
  payer: Address;
  chainId: number;
  payoutContract: Address;
  verifier: string;
  challenge: Hex;
}): Promise<DebtProof> {
  const rs = opts.receipts;
  if (rs.length === 0) throw new Error('No notes to prove');
  if (rs.length !== opts.stealthPrivateKeys.length) throw new Error('One stealth key per note');
  const first = rs[0];
  for (const r of rs) {
    if (r.epoch !== first.epoch || r.owner !== first.owner || r.debt !== first.debt || r.carryIn !== first.carryIn || r.commitmentsRoot !== first.commitmentsRoot) {
      throw new Error('All notes must be of one ledger line and one epoch');
    }
  }
  const owner = privateKeyToAccount(opts.ownerPrivateKey).address;
  if (!isAddressEqual(owner, first.owner)) throw new Error('The owner key does not match the ledger line');
  rs.forEach((r, i) => {
    if (!isAddressEqual(privateKeyToAccount(opts.stealthPrivateKeys[i]).address, r.stealthAddress)) throw new Error('A key does not control its note');
  });
  const statement: DebtStatement = {
    payer: getAddress(opts.payer),
    epoch: first.epoch,
    owner: getAddress(owner),
    debt: first.debt,
    carryIn: first.carryIn,
    paid: rs.reduce((s, r) => s + r.denomination, 0n),
    notes: notesHash(rs.map((r) => r.leaf)),
    commitmentsRoot: first.commitmentsRoot,
    verifier: opts.verifier,
    challenge: opts.challenge,
  };
  const typed = { domain: debtDomain(opts.chainId, opts.payoutContract), types: DEBT_TYPES, primaryType: 'DebtSettled', message: statement } as const;
  const notes: OpenedNote[] = [];
  for (let i = 0; i < rs.length; i++) {
    notes.push({
      stealthAddress: getAddress(rs[i].stealthAddress),
      denomination: rs[i].denomination,
      salt: rs[i].salt,
      merkleProof: rs[i].merkleProof,
      signature: await signTypedData({ ...typed, privateKey: opts.stealthPrivateKeys[i] }),
    });
  }
  return {
    chainId: opts.chainId,
    payoutContract: getAddress(opts.payoutContract),
    statement,
    notes,
    ownerSignature: await signTypedData({ ...typed, privateKey: opts.ownerPrivateKey }),
  };
}

/** What the verifier read for (payer, epoch): the root and every note paid (address, amount) across the epoch's parts. */
export type OnchainNotesEpoch = {
  chainId: number;
  payoutContract: Address;
  payer: Address;
  epoch: bigint;
  commitmentsRoot: Hex;
  paidNotes: { stealthAddress: Address; amount: bigint }[];
};

export type DebtVerdict = { ok: true; owner: Address; debt: bigint; paid: bigint; carryOut: bigint; notes: number } | { ok: false; reason: string };

/**
 * Verifier side. `ledgerDebt` is the public ledger's line for (epoch, owner); `ledgerCarryIn`, if the verifier recomputed
 * it from the ledger history, is checked too (otherwise only carryIn < base is checked: a misstated carry moves less than
 * one base unit). `base` is the payer's public base unit.
 */
export async function verifyDebtSettled(
  proof: DebtProof,
  expect: { verifier: string; challenge: Hex; base: bigint; ledgerDebt: (owner: Address) => bigint | undefined; ledgerCarryIn?: bigint; onchain: OnchainNotesEpoch },
): Promise<DebtVerdict> {
  const s = proof.statement;
  const o = expect.onchain;
  const fail = (reason: string): DebtVerdict => ({ ok: false, reason });

  if (s.verifier !== expect.verifier) return fail('made for another verifier');
  if (s.challenge.toLowerCase() !== expect.challenge.toLowerCase()) return fail('stale or foreign challenge');
  if (proof.chainId !== o.chainId || !isAddressEqual(proof.payoutContract, o.payoutContract)) return fail('wrong chain or contract');
  if (!isAddressEqual(s.payer, o.payer) || s.epoch !== o.epoch) return fail('wrong payer or epoch');
  if (s.commitmentsRoot.toLowerCase() !== o.commitmentsRoot.toLowerCase()) return fail('root does not match the chain');
  if (expect.ledgerDebt(s.owner) !== s.debt) return fail('debt does not match the public ledger');
  if (expect.ledgerCarryIn !== undefined ? s.carryIn !== expect.ledgerCarryIn : s.carryIn >= expect.base) return fail('carry does not match the ledger');
  if (proof.notes.length === 0) return fail('no notes');
  if (new Set(proof.notes.map((n) => n.stealthAddress.toLowerCase())).size !== proof.notes.length) return fail('a note is listed twice');

  const typed = { domain: debtDomain(proof.chainId, proof.payoutContract), types: DEBT_TYPES, primaryType: 'DebtSettled', message: s } as const;
  const leaves: Hex[] = [];
  let sum = 0n;
  for (const n of proof.notes) {
    const paid = o.paidNotes.find((p) => isAddressEqual(p.stealthAddress, n.stealthAddress));
    if (!paid) return fail('note was not paid in this epoch');
    if (paid.amount !== n.denomination) return fail('denomination does not match the chain');
    let leaf: Hex;
    try {
      leaf = noteLeafHash(s.epoch, s.owner, s.debt, s.carryIn, n.stealthAddress, n.denomination, n.salt);
    } catch {
      return fail('bad salt');
    }
    if (!verifyInclusion(leaf, n.merkleProof, o.commitmentsRoot)) return fail('note does not open to this ledger line');
    let signer: Address;
    try {
      signer = await recoverTypedDataAddress({ ...typed, signature: n.signature });
    } catch {
      return fail('bad note signature');
    }
    if (!isAddressEqual(signer, n.stealthAddress)) return fail('note not signed by its stealth address');
    leaves.push(leaf);
    sum += n.denomination;
  }
  if (notesHash(leaves) !== s.notes.toLowerCase()) return fail('statement does not name these notes');
  if (sum !== s.paid) return fail('paid does not add up');
  const { paid: owed, carryOut } = roundDown(s.debt, s.carryIn, expect.base);
  if (sum !== owed) return fail('notes do not settle the debt exactly');

  let owner: Address;
  try {
    owner = await recoverTypedDataAddress({ ...typed, signature: proof.ownerSignature });
  } catch {
    return fail('bad owner signature');
  }
  if (!isAddressEqual(owner, s.owner)) return fail('not signed by the owner');
  return { ok: true, owner: getAddress(s.owner), debt: s.debt, paid: sum, carryOut, notes: proof.notes.length };
}
