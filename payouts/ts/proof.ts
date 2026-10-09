// Private proof of entitlement for a StealthPayout payment (answers "that proves money reached an address, not that the
// right person's debt was settled").
//
// The operator commits, per epoch, to one leaf per payment: H(nftId, epoch, stealthAddress, salt), and puts the Merkle
// root on chain in the same transaction that pays. A leaf hides its NFT behind a secret 32-byte salt, so the leaves can
// be published. Later the holder can show ONE verifier of their choice that a given payment settled a given NFT's reward:
// they reveal nftId and salt to that verifier only, and sign a statement with the stealth address's private key.
//
// Every function here is pure (no network). The verifier reads the on-chain facts (EpochSettled + Announcements of the
// settle transaction, or StealthPayout.commitmentsRootOf) itself and passes them in.
import {
  concat,
  encodeAbiParameters,
  getAddress,
  isAddressEqual,
  keccak256,
  recoverTypedDataAddress,
  zeroAddress,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount, signTypedData } from 'viem/accounts';

// ---------------------------------------------------------------- commitments

/**
 * Leaf for one payment: keccak256(keccak256(abi.encode(uint256 nftId, uint256 epoch, address stealthAddress, bytes32 salt))).
 * Double-hashed like OpenZeppelin's StandardMerkleTree, so a leaf can never be passed off as an inner node.
 * The salt MUST be secret and high-entropy: there are only ~195 NFT ids, so without it anyone could test every
 * (nftId, stealthAddress) pair against the published leaves and link every payment.
 */
export function leafHash(nftId: bigint, epoch: bigint, stealthAddress: Address, salt: Hex): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(salt)) throw new Error('Salt must be 32 bytes');
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }],
      [nftId, epoch, getAddress(stealthAddress), salt],
    ),
  );
  return keccak256(inner);
}

/** Inner node: hash of the two children in ascending order (OpenZeppelin MerkleProof convention). */
export const hashPair = (a: Hex, b: Hex): Hex => (BigInt(a) < BigInt(b) ? keccak256(concat([a, b])) : keccak256(concat([b, a])));

export type MerkleTree = { root: Hex; leaves: Hex[]; layers: Hex[][] };

/** Builds the tree over the leaves sorted ascending (canonical: the root does not depend on input order). */
export function buildTree(leaves: Hex[]): MerkleTree {
  if (leaves.length === 0) throw new Error('No leaves');
  const sorted = [...leaves].map((l) => l.toLowerCase() as Hex).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) if (sorted[i] === sorted[i - 1]) throw new Error('Duplicate leaf');
  const layers: Hex[][] = [sorted];
  while (layers[layers.length - 1].length > 1) {
    const cur = layers[layers.length - 1];
    const next: Hex[] = [];
    for (let i = 0; i < cur.length; i += 2) next.push(i + 1 < cur.length ? hashPair(cur[i], cur[i + 1]) : cur[i]); // odd node moves up
    layers.push(next);
  }
  return { root: layers[layers.length - 1][0], leaves: sorted, layers };
}

/** Sibling path for one leaf. With sorted pairs no index is needed (or revealed). */
export function merkleProof(tree: MerkleTree, leaf: Hex): Hex[] {
  let idx = tree.leaves.indexOf(leaf.toLowerCase() as Hex);
  if (idx < 0) throw new Error('Leaf not in tree');
  const proof: Hex[] = [];
  for (let l = 0; l < tree.layers.length - 1; l++) {
    const layer = tree.layers[l];
    const sib = idx ^ 1;
    if (sib < layer.length) proof.push(layer[sib]);
    idx >>= 1;
  }
  return proof;
}

export function verifyInclusion(leaf: Hex, proof: Hex[], root: Hex): boolean {
  let h = leaf.toLowerCase() as Hex;
  for (const p of proof) h = hashPair(h, p.toLowerCase() as Hex);
  return h === root.toLowerCase();
}

// ---------------------------------------------------------------- the private proof

/** What the holder signs. EIP-712, so a wallet shows it field by field. */
export const ENTITLEMENT_TYPES = {
  Entitlement: [
    { name: 'payer', type: 'address' },
    { name: 'epoch', type: 'uint256' },
    { name: 'nftId', type: 'uint256' },
    { name: 'stealthAddress', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'leaf', type: 'bytes32' },
    { name: 'commitmentsRoot', type: 'bytes32' },
    { name: 'ownerWallet', type: 'address' }, // zero address unless the holder chooses to disclose it
    { name: 'verifier', type: 'string' },
    { name: 'challenge', type: 'bytes32' }, // fresh nonce from the verifier: a proof cannot be replayed to them later
  ],
} as const;

export const entitlementDomain = (chainId: number, payoutContract: Address) =>
  ({ name: 'StealthPayout entitlement', version: '1', chainId, verifyingContract: getAddress(payoutContract) }) as const;

export type Statement = {
  payer: Address;
  epoch: bigint;
  nftId: bigint;
  stealthAddress: Address;
  amount: bigint;
  leaf: Hex;
  commitmentsRoot: Hex;
  ownerWallet: Address;
  verifier: string;
  challenge: Hex;
};

export type EntitlementProof = {
  chainId: number;
  payoutContract: Address;
  statement: Statement;
  salt: Hex; // revealed to this verifier only
  merkleProof: Hex[];
  stealthSignature: Hex; // by the stealth address's private key
  ownerSignature?: Hex; // optional: by ownerWallet, so the verifier can also check ownerOf(nftId) at the epoch snapshot
};

/** The private receipt the holder needs (from planEpoch, or rebuilt with findMyPayouts). */
export type ReceiptForProof = {
  nftId: bigint;
  epoch: bigint;
  stealthAddress: Address;
  amountEach: bigint;
  salt: Hex;
  leaf: Hex;
  merkleProof: Hex[];
  commitmentsRoot: Hex;
};

/** Holder side: build the proof for one verifier. Nothing here is published. */
export async function proveEntitlement(opts: {
  receipt: ReceiptForProof;
  stealthPrivateKey: Hex;
  payer: Address;
  chainId: number;
  payoutContract: Address;
  verifier: string;
  challenge: Hex;
  ownerPrivateKey?: Hex;
}): Promise<EntitlementProof> {
  const { receipt: r } = opts;
  const signer = privateKeyToAccount(opts.stealthPrivateKey);
  if (!isAddressEqual(signer.address, r.stealthAddress)) throw new Error('This key does not control the stealth address');
  const ownerWallet = opts.ownerPrivateKey ? privateKeyToAccount(opts.ownerPrivateKey).address : zeroAddress;
  const statement: Statement = {
    payer: getAddress(opts.payer),
    epoch: r.epoch,
    nftId: r.nftId,
    stealthAddress: getAddress(r.stealthAddress),
    amount: r.amountEach,
    leaf: r.leaf,
    commitmentsRoot: r.commitmentsRoot,
    ownerWallet,
    verifier: opts.verifier,
    challenge: opts.challenge,
  };
  const typed = {
    domain: entitlementDomain(opts.chainId, opts.payoutContract),
    types: ENTITLEMENT_TYPES,
    primaryType: 'Entitlement',
    message: statement,
  } as const;
  const stealthSignature = await signTypedData({ ...typed, privateKey: opts.stealthPrivateKey });
  const ownerSignature = opts.ownerPrivateKey ? await signTypedData({ ...typed, privateKey: opts.ownerPrivateKey }) : undefined;
  return {
    chainId: opts.chainId,
    payoutContract: getAddress(opts.payoutContract),
    statement,
    salt: r.salt,
    merkleProof: r.merkleProof,
    stealthSignature,
    ...(ownerSignature ? { ownerSignature } : {}),
  };
}

/** What the verifier read from chain for (payer, epoch): the EpochSettled event and the settle transaction's announcements. */
export type OnchainEpoch = {
  chainId: number;
  payoutContract: Address;
  payer: Address;
  epoch: bigint;
  commitmentsRoot: Hex;
  amountEach: bigint;
  paidStealthAddresses: Address[];
};

export type Verdict = { ok: true; nftId: bigint; stealthAddress: Address; ownerWallet?: Address } | { ok: false; reason: string };

/**
 * Verifier side. On success the verifier knows: the payment of `amountEach` to `stealthAddress` in this epoch was
 * committed by the payer as NFT `nftId`'s reward, and the prover controls that address. If ownerWallet is returned, the
 * prover also controls that wallet; checking ownerOf(nftId) == ownerWallet at the epoch's snapshot block is the
 * verifier's own chain read.
 */
export async function verifyEntitlement(
  proof: EntitlementProof,
  expect: { verifier: string; challenge: Hex; onchain: OnchainEpoch },
): Promise<Verdict> {
  const s = proof.statement;
  const o = expect.onchain;
  const fail = (reason: string): Verdict => ({ ok: false, reason });

  if (s.verifier !== expect.verifier) return fail('made for another verifier');
  if (s.challenge.toLowerCase() !== expect.challenge.toLowerCase()) return fail('stale or foreign challenge');
  if (proof.chainId !== o.chainId || !isAddressEqual(proof.payoutContract, o.payoutContract)) return fail('wrong chain or contract');
  if (!isAddressEqual(s.payer, o.payer) || s.epoch !== o.epoch) return fail('wrong payer or epoch');
  if (s.commitmentsRoot.toLowerCase() !== o.commitmentsRoot.toLowerCase()) return fail('root does not match the chain');
  if (s.amount !== o.amountEach) return fail('amount does not match the chain');
  if (!o.paidStealthAddresses.some((a) => isAddressEqual(a, s.stealthAddress))) return fail('address was not paid in this epoch');

  let leaf: Hex;
  try {
    leaf = leafHash(s.nftId, s.epoch, s.stealthAddress, proof.salt);
  } catch {
    return fail('bad salt');
  }
  if (leaf.toLowerCase() !== s.leaf.toLowerCase()) return fail('leaf does not open to this NFT and address');
  if (!verifyInclusion(leaf, proof.merkleProof, o.commitmentsRoot)) return fail('leaf not in the committed root');

  const typed = {
    domain: entitlementDomain(proof.chainId, proof.payoutContract),
    types: ENTITLEMENT_TYPES,
    primaryType: 'Entitlement',
    message: s,
  } as const;
  let signer: Address;
  try {
    signer = await recoverTypedDataAddress({ ...typed, signature: proof.stealthSignature });
  } catch {
    return fail('bad stealth signature');
  }
  if (!isAddressEqual(signer, s.stealthAddress)) return fail('not signed by the stealth address');

  if (isAddressEqual(s.ownerWallet, zeroAddress)) {
    if (proof.ownerSignature) return fail('owner signature without an owner wallet');
    return { ok: true, nftId: s.nftId, stealthAddress: getAddress(s.stealthAddress) };
  }
  if (!proof.ownerSignature) return fail('owner wallet named but not signed');
  let owner: Address;
  try {
    owner = await recoverTypedDataAddress({ ...typed, signature: proof.ownerSignature });
  } catch {
    return fail('bad owner signature');
  }
  if (!isAddressEqual(owner, s.ownerWallet)) return fail('not signed by the owner wallet');
  return { ok: true, nftId: s.nftId, stealthAddress: getAddress(s.stealthAddress), ownerWallet: getAddress(s.ownerWallet) };
}
