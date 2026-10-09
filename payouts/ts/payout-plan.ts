// Operator side: turn one epoch's entitlements ({nftId, metaAddress} per registered NFT) into the settle() call, the
// commitments and the per-holder private receipts. Holder side: find your own payouts with your viewing key and rebuild
// your receipts from public data only.
//
// Pure functions; nothing here touches a network or stores a key.
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, concat, encodeFunctionData, getAddress, hexToBytes, keccak256, toHex, type Address, type Hex } from 'viem';
import { generateStealthAddress, parseMetaAddress, stealthAddressFor, viewTagMatch, type StealthKeys } from './stealth.ts';
import { buildTree, leafHash, merkleProof } from './proof.ts';

export type Entitlement = { nftId: bigint; metaAddress: string };

/** One entry of settle()'s Recipient[]: the only per-payment data that goes on chain. */
export type Recipient = { stealthAddress: Address; ephemeralPubKey: Hex; viewTag: Hex /* bytes1 */ };

/** PRIVATE. One per NFT. Hand it to the holder (or let them rebuild it, see findMyPayouts); never publish it. */
export type Receipt = {
  nftId: bigint;
  epoch: bigint;
  amountEach: bigint;
  stealthAddress: Address;
  ephemeralPubKey: Hex;
  viewTag: number;
  salt: Hex;
  leaf: Hex;
  merkleProof: Hex[];
  commitmentsRoot: Hex;
};

export type PayoutPlan = {
  epoch: bigint;
  amountEach: bigint;
  value: bigint; // msg.value for settle(): recipients.length * amountEach
  recipients: Recipient[]; // public, ascending by stealth address (the contract enforces it)
  commitmentsRoot: Hex; // public, goes into settle()
  leaves: Hex[]; // public, sorted; safe to publish (each hides its NFT behind a secret salt), lets holders build proofs
  receipts: Receipt[]; // PRIVATE: this is the operator's NFT -> address mapping
};

export type SaltSource = (ctx: { nftId: bigint; epoch: bigint; hashedSecret: Hex }) => Hex;

/**
 * Default salt: derived from the ERC-5564 shared secret, which only the operator and the holder (anyone with the
 * holder's viewing key) can compute. The holder can then rebuild their receipt from the chain and the published leaves,
 * with no private delivery channel. Its first byte (the view tag) is public; the salt is a hash over all of it.
 */
export const sharedSecretSalt: SaltSource = ({ hashedSecret }) => keccak256(concat([toHex('StealthPayout.salt.v1'), hashedSecret]));

/** Alternative: 32 random bytes. The operator must then deliver each receipt privately. */
export const randomSalt: SaltSource = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));

/** Sender-side hashed secret, the same value the holder gets from viewTagMatch(). */
export function hashedSecretFor(ephemeralPrivateKey: Hex, viewingPublicKey: Hex): Hex {
  return keccak256(secp256k1.getSharedSecret(hexToBytes(ephemeralPrivateKey), hexToBytes(viewingPublicKey), true));
}

const cmpAddr = (a: Address, b: Address) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0);

/**
 * Operator side. Every NFT gets its own fresh stealth address and the same amount, so an owner of k NFTs gets k
 * ordinary-looking payments. Throws on a duplicate NFT id, an invalid meta-address or a repeated stealth address (a
 * reused ephemeral key would pay one address twice: a distinctive 2x balance).
 */
export function planEpoch(opts: {
  epoch: bigint;
  amountEach: bigint;
  entitlements: Entitlement[];
  salt?: SaltSource;
  ephemeralKey?: (index: number) => Hex; // tests only; default: fresh random key per payment
}): PayoutPlan {
  const { epoch, amountEach, entitlements } = opts;
  if (entitlements.length === 0) throw new Error('Nothing to pay');
  if (amountEach <= 0n) throw new Error('amountEach must be positive');
  if (epoch < 0n) throw new Error('Bad epoch');
  const seen = new Set<bigint>();
  for (const e of entitlements) {
    if (e.nftId < 0n) throw new Error('Bad NFT id');
    if (seen.has(e.nftId)) throw new Error(`NFT ${e.nftId} listed twice`);
    seen.add(e.nftId);
  }
  const saltOf = opts.salt ?? sharedSecretSalt;

  const rows = entitlements.map((e, i) => {
    const meta = parseMetaAddress(e.metaAddress);
    const eph = opts.ephemeralKey ? opts.ephemeralKey(i) : bytesToHex(secp256k1.utils.randomPrivateKey());
    const g = generateStealthAddress(meta, eph);
    const hashedSecret = hashedSecretFor(eph, meta.viewingPublicKey);
    if (parseInt(hashedSecret.slice(2, 4), 16) !== g.viewTag) throw new Error('View tag mismatch'); // sanity
    const stealthAddress = getAddress(g.stealthAddress);
    const salt = saltOf({ nftId: e.nftId, epoch, hashedSecret });
    return { nftId: e.nftId, stealthAddress, ephemeralPubKey: g.ephemeralPublicKey, viewTag: g.viewTag, salt, leaf: leafHash(e.nftId, epoch, stealthAddress, salt) };
  });

  rows.sort((a, b) => cmpAddr(a.stealthAddress, b.stealthAddress));
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].stealthAddress === rows[i - 1].stealthAddress) throw new Error('Same stealth address twice (reused ephemeral key)');
  }
  if (new Set(rows.map((r) => r.ephemeralPubKey.toLowerCase())).size !== rows.length) {
    throw new Error('Ephemeral key reused: every payment needs a fresh one');
  }

  const tree = buildTree(rows.map((r) => r.leaf));
  return {
    epoch,
    amountEach,
    value: amountEach * BigInt(rows.length),
    recipients: rows.map((r) => ({ stealthAddress: r.stealthAddress, ephemeralPubKey: r.ephemeralPubKey, viewTag: toHex(r.viewTag, { size: 1 }) })),
    commitmentsRoot: tree.root,
    leaves: tree.leaves,
    receipts: rows.map((r) => ({
      nftId: r.nftId,
      epoch,
      amountEach,
      stealthAddress: r.stealthAddress,
      ephemeralPubKey: r.ephemeralPubKey,
      viewTag: r.viewTag,
      salt: r.salt,
      leaf: r.leaf,
      merkleProof: merkleProof(tree, r.leaf),
      commitmentsRoot: tree.root,
    })),
  };
}

// ---------------------------------------------------------------- the call

export const STEALTH_PAYOUT_ABI = [
  {
    type: 'function',
    name: 'settle',
    stateMutability: 'payable',
    inputs: [
      { name: 'epoch', type: 'uint256' },
      { name: 'commitmentsRoot', type: 'bytes32' },
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
    outputs: [],
  },
  {
    type: 'event',
    name: 'EpochSettled',
    inputs: [
      { name: 'payer', type: 'address', indexed: true },
      { name: 'epoch', type: 'uint256', indexed: true },
      { name: 'count', type: 'uint256', indexed: false },
      { name: 'amountEach', type: 'uint256', indexed: false },
      { name: 'commitmentsRoot', type: 'bytes32', indexed: false },
    ],
  },
] as const;

/** Calldata for settle(); send it with value = plan.value. */
export function settleCalldata(plan: PayoutPlan): Hex {
  return encodeFunctionData({ abi: STEALTH_PAYOUT_ABI, functionName: 'settle', args: [plan.epoch, plan.commitmentsRoot, plan.recipients] });
}

// ---------------------------------------------------------------- holder side

/** An announcement as read from the chain (the Announcer's Announcement logs of the settle transaction). */
export type SeenPayment = { stealthAddress: Address; ephemeralPubKey: Hex; viewTag: number };

/**
 * Holder side, public data only: the epoch's announcements, the published leaves and root, and your own keys and NFT ids.
 * - receipts: your payouts, each matched to one of your NFTs, ready for proveEntitlement()
 * - unmatched: payouts to you whose leaf opens to none of your NFT ids (the operator committed something else)
 * - missing: your NFT ids with no payout in this epoch
 * Works with the default salt (sharedSecretSalt); with randomSalt the operator must hand over the receipts.
 */
export function findMyPayouts(
  keys: Pick<StealthKeys, 'viewingPrivateKey' | 'spendingPublicKey'>,
  opts: { epoch: bigint; amountEach: bigint; payments: SeenPayment[]; leaves: Hex[]; myNftIds: bigint[]; salt?: SaltSource },
): { receipts: Receipt[]; unmatched: Address[]; missing: bigint[] } {
  const saltOf = opts.salt ?? sharedSecretSalt;
  const tree = buildTree(opts.leaves);
  const published = new Set(tree.leaves);
  const receipts: Receipt[] = [];
  const unmatched: Address[] = [];
  for (const p of opts.payments) {
    const h = viewTagMatch(keys.viewingPrivateKey, p.ephemeralPubKey, p.viewTag);
    if (!h) continue;
    const addr = stealthAddressFor(keys.spendingPublicKey, h);
    if (addr.toLowerCase() !== p.stealthAddress.toLowerCase()) continue; // view tag collision, not ours
    const stealthAddress = getAddress(p.stealthAddress);
    let found = false;
    for (const nftId of opts.myNftIds) {
      const salt = saltOf({ nftId, epoch: opts.epoch, hashedSecret: h });
      const leaf = leafHash(nftId, opts.epoch, stealthAddress, salt);
      if (!published.has(leaf.toLowerCase() as Hex)) continue;
      receipts.push({
        nftId,
        epoch: opts.epoch,
        amountEach: opts.amountEach,
        stealthAddress,
        ephemeralPubKey: p.ephemeralPubKey,
        viewTag: p.viewTag,
        salt,
        leaf,
        merkleProof: merkleProof(tree, leaf),
        commitmentsRoot: tree.root,
      });
      found = true;
      break;
    }
    if (!found) unmatched.push(stealthAddress);
  }
  const paid = new Set(receipts.map((r) => r.nftId));
  return { receipts, unmatched, missing: opts.myNftIds.filter((id) => !paid.has(id)) };
}

/** The announcements a settle() call produces, in order (handy for tests and simulations). */
export const paymentsOf = (plan: PayoutPlan): SeenPayment[] =>
  plan.recipients.map((r) => ({ stealthAddress: r.stealthAddress, ephemeralPubKey: r.ephemeralPubKey, viewTag: parseInt(r.viewTag.slice(2), 16) }));
