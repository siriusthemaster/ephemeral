// ERC-5564 scheme 1 (secp256k1 with view tags) and the ephemeral key derivation: the ephemeral client's
// src/lib/stealth.ts as of client 0.2.19-beta (ephemeral-client commit 2d12269), unchanged below this header (bug
// bounty, 24 Nov: this copy was from before client 0.2.10 and accepted a 33-byte meta-address, a high-S signature as a
// second key set, and r or s of 0 or n).
// Every function here is pure. Keys never leave the caller.
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex, hexToBytes, keccak256, type Hex } from 'viem';
import { publicKeyToAddress } from 'viem/accounts';

export const SCHEME_ID = 1n;
const N = secp256k1.CURVE.n;

/**
 * The fixed text the wallet signs to derive the stealth keys. Changing a single character changes every key,
 * so this text is frozen. A new version means new keys (see docs: Rotation).
 */
export const KEY_MESSAGE_V1 = [
  'ephemeral stealth keys v1',
  '',
  'Sign this message to create your private receiving keys.',
  'It does not move funds or approve anything.',
  'Anyone who has this signature can find and spend payments to you.',
  'Only sign it on ephemeral.money or a copy of the client you run yourself.',
].join('\n');

export type StealthKeys = {
  spendingPrivateKey: Hex;
  viewingPrivateKey: Hex;
  spendingPublicKey: Hex; // compressed, 33 bytes
  viewingPublicKey: Hex; // compressed, 33 bytes
};

const toScalar = (h: Hex) => {
  const k = BigInt(h) % N;
  if (k === 0n) throw new Error('Derived key is zero');
  return k;
};
const scalarHex = (k: bigint) => `0x${k.toString(16).padStart(64, '0')}` as Hex;
const pubOf = (k: bigint) => bytesToHex(secp256k1.getPublicKey(hexToBytes(scalarHex(k)), true));

const HALF_N = N >> 1n;

/**
 * r and s of a 65-byte signature as 32-byte words, checked (0.2.11): r and s must lie in 1 to n - 1, else it is no
 * signature at all (s = 0 and s >= n used to pass and gave keys). The recovery byte is not used for the keys; the
 * wallet check in io.ts deriveKeys recovers the signer with it.
 */
function signatureWords(signature: Hex): { r: Hex; s: Hex; high: boolean } {
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error('Expected a 65-byte signature');
  const r = `0x${signature.slice(2, 66)}` as Hex;
  const s = `0x${signature.slice(66, 130)}` as Hex;
  const rv = BigInt(r);
  const sv = BigInt(s);
  if (rv === 0n || rv >= N || sv === 0n || sv >= N) throw new Error('Not a valid signature: r and s must be between 1 and n - 1');
  return { r, s, high: sv > HALF_N };
}

function keysOf(r: Hex, s: Hex): StealthKeys {
  const spend = toScalar(keccak256(r));
  const view = toScalar(keccak256(s));
  return {
    spendingPrivateKey: scalarHex(spend),
    viewingPrivateKey: scalarHex(view),
    spendingPublicKey: pubOf(spend),
    viewingPublicKey: pubOf(view),
  };
}

/** True when s is in the upper half (high-S): the same signature is also valid with n - s, and wallets differ here. */
export const isHighS = (signature: Hex) => signatureWords(signature).high;

/**
 * Splits a 65-byte signature into r and s and hashes each into a key: p_spend = keccak256(r), p_view = keccak256(s),
 * mod n, with s in its low form (min(s, n - s), as EIP-2 requires of transactions) since 0.2.11. An ECDSA signature
 * stays valid when s is replaced by n - s, and a wallet may return either form; before, the two forms gave two
 * different viewing keys for the same wallet, so a payment to one meta-address was invisible to the other. For every
 * low-S signature (what most wallets return) the keys are exactly as before and as in the ScopeLift SDK.
 */
export function keysFromSignature(signature: Hex): StealthKeys {
  const { r, s, high } = signatureWords(signature);
  return keysOf(r, high ? scalarHex(N - BigInt(s)) : s);
}

/**
 * The keys of the other s form of the same signature: what a high-S signature gave before 0.2.11 (viewing key from s
 * as signed). Since 0.2.19 (bug bounty #60) also for a low-S signature: a wallet that returned the high form before
 * 0.2.11 and returns the low form now had its pre-0.2.11 viewing key from n - s, and its older payments are found only
 * with those keys. The scan reads with these too, so payments made to that older meta-address are still found.
 */
export function legacyKeysFromSignature(signature: Hex): StealthKeys | null {
  const { r, s, high } = signatureWords(signature);
  return high ? keysOf(r, s) : keysOf(r, scalarHex(N - BigInt(s)));
}

/** The 66-byte stealth meta-address: compressed spending key followed by compressed viewing key. */
export function metaAddressOf(keys: Pick<StealthKeys, 'spendingPublicKey' | 'viewingPublicKey'>): Hex {
  return `0x${keys.spendingPublicKey.slice(2)}${keys.viewingPublicKey.slice(2)}` as Hex;
}

export const metaAddressURI = (meta: Hex) => `st:eth:${meta}`;

export type MetaAddress = { spendingPublicKey: Hex; viewingPublicKey: Hex };

/** One compressed secp256k1 public key: 33 bytes, prefix 02 or 03, a valid point on the curve. */
function assertCompressedKey(k: unknown, which: string): asserts k is Hex {
  if (typeof k !== 'string' || !/^0x0[23][0-9a-fA-F]{64}$/.test(k))
    throw new Error(`The ${which} key of this meta-address is not a compressed public key (33 bytes starting with 02 or 03)`);
  try {
    secp256k1.ProjectivePoint.fromHex(k.slice(2)).assertValidity();
  } catch {
    throw new Error('The meta-address contains a key that is not on the curve');
  }
}

/**
 * Accepts `st:eth:0x…`, `st:<chain>:0x…` or a bare 0x meta-address, and only the exact ERC-5564 scheme 1 format: 66
 * bytes, the compressed spending key then the compressed viewing key, both valid points (0.2.10). Anything else is
 * refused with a clear error before any payment, never reinterpreted: a 33-byte input used to be read as one key doing
 * both jobs (viewing key = spending key), so a truncated meta-address paid an address its owner's scan never finds.
 */
export function parseMetaAddress(input: string): MetaAddress {
  if (typeof input !== 'string') throw new Error('Not a stealth meta-address');
  let s = input.trim();
  if (s.startsWith('st:')) {
    const parts = s.split(':');
    if (parts.length !== 3 || !parts[1]) throw new Error('A meta-address URI looks like st:eth:0x…');
    s = parts[2];
  }
  if (!/^0x[0-9a-fA-F]*$/.test(s)) throw new Error('Not a stealth meta-address');
  const hex = s.slice(2);
  if (hex.length === 66)
    throw new Error(
      'This meta-address is too short: it holds one key (33 bytes), and a stealth meta-address holds two (66 bytes: st:eth:0x and 132 hex characters). Ask the receiver for the full one.',
    );
  if (hex.length !== 132)
    throw new Error(`Not a stealth meta-address: expected 66 bytes (132 hex characters after 0x), got ${hex.length % 2 ? `${hex.length} hex characters` : `${hex.length / 2} bytes`}.`);
  const spend = `0x${hex.slice(0, 66)}` as Hex;
  const view = `0x${hex.slice(66)}` as Hex;
  assertCompressedKey(spend, 'spending');
  assertCompressedKey(view, 'viewing');
  return { spendingPublicKey: spend, viewingPublicKey: view };
}

/** Throws unless `meta` holds two compressed keys that are valid points (the shape parseMetaAddress returns). */
export function assertMetaAddress(meta: MetaAddress): void {
  if (!meta || typeof meta !== 'object') throw new Error('Not a stealth meta-address');
  assertCompressedKey(meta.spendingPublicKey, 'spending');
  assertCompressedKey(meta.viewingPublicKey, 'viewing');
}

function hashedSecret(sharedPoint: Uint8Array): Hex {
  return keccak256(sharedPoint); // compressed shared point, 33 bytes
}

export type GeneratedStealth = {
  stealthAddress: Hex;
  ephemeralPublicKey: Hex; // compressed, 33 bytes
  viewTag: number; // first byte of the hashed secret
};

/** Sender side: a fresh one-time address for the receiver, plus what the announcement must carry. */
export function generateStealthAddress(meta: MetaAddress, ephemeralPrivateKey?: Hex): GeneratedStealth {
  assertMetaAddress(meta); // never pay a malformed meta-address, whoever built it (0.2.10)
  const eph = ephemeralPrivateKey ? hexToBytes(ephemeralPrivateKey) : secp256k1.utils.randomPrivateKey();
  const ephemeralPublicKey = bytesToHex(secp256k1.getPublicKey(eph, true));
  const shared = secp256k1.getSharedSecret(eph, hexToBytes(meta.viewingPublicKey), true);
  const h = hashedSecret(shared);
  const viewTag = parseInt(h.slice(2, 4), 16);
  const stealthPub = secp256k1.ProjectivePoint.fromHex(meta.spendingPublicKey.slice(2)).add(
    secp256k1.ProjectivePoint.BASE.multiply(toScalar(h)),
  );
  const stealthAddress = publicKeyToAddress(bytesToHex(stealthPub.toRawBytes(false)));
  return { stealthAddress, ephemeralPublicKey, viewTag };
}

/** Receiver side, step 1: the cheap view-tag test. Returns the hashed secret on a match, else null. */
export function viewTagMatch(viewingPrivateKey: Hex, ephemeralPublicKey: Hex, viewTag: number): Hex | null {
  let shared: Uint8Array;
  try {
    shared = secp256k1.getSharedSecret(hexToBytes(viewingPrivateKey), hexToBytes(ephemeralPublicKey), true);
  } catch {
    return null; // malformed key in someone's announcement
  }
  const h = hashedSecret(shared);
  return parseInt(h.slice(2, 4), 16) === viewTag ? h : null;
}

/** Receiver side, step 2: the stealth address this announcement would pay, given a view-tag match. */
export function stealthAddressFor(spendingPublicKey: Hex, hashed: Hex): Hex {
  const p = secp256k1.ProjectivePoint.fromHex(spendingPublicKey.slice(2)).add(
    secp256k1.ProjectivePoint.BASE.multiply(toScalar(hashed)),
  );
  return publicKeyToAddress(bytesToHex(p.toRawBytes(false)));
}

/** Full check of one announcement. Returns the stealth address if it is ours. */
export function checkAnnouncement(
  keys: Pick<StealthKeys, 'viewingPrivateKey' | 'spendingPublicKey'>,
  a: { ephemeralPublicKey: Hex; viewTag: number; stealthAddress: Hex },
): Hex | null {
  const h = viewTagMatch(keys.viewingPrivateKey, a.ephemeralPublicKey, a.viewTag);
  if (!h) return null;
  const addr = stealthAddressFor(keys.spendingPublicKey, h);
  return addr.toLowerCase() === a.stealthAddress.toLowerCase() ? addr : null;
}

/** The private key of a stealth address: p_stealth = p_spend + keccak256(s) mod n. */
export function stealthPrivateKey(spendingPrivateKey: Hex, viewingPrivateKey: Hex, ephemeralPublicKey: Hex): Hex {
  const shared = secp256k1.getSharedSecret(hexToBytes(viewingPrivateKey), hexToBytes(ephemeralPublicKey), true);
  const h = hashedSecret(shared);
  return scalarHex((BigInt(spendingPrivateKey) + toScalar(h)) % N);
}

/**
 * The private key of one payment address, from the first key set that controls it (0.2.11: the current keys, then the
 * older high-S keys the scan may have found it with). Throws when none does, so nothing is ever signed with a key that
 * does not belong to the address.
 */
export function paymentKeyFor(
  sets: (Pick<StealthKeys, 'spendingPrivateKey' | 'viewingPrivateKey'> | null | undefined)[],
  stealthAddress: Hex,
  ephemeralPublicKey: Hex,
): Hex {
  for (const k of sets) {
    if (!k) continue;
    let p: Hex;
    try {
      p = stealthPrivateKey(k.spendingPrivateKey, k.viewingPrivateKey, ephemeralPublicKey);
    } catch {
      continue;
    }
    if (publicKeyToAddress(bytesToHex(secp256k1.getPublicKey(hexToBytes(p), false))).toLowerCase() === stealthAddress.toLowerCase()) return p;
  }
  throw new Error('None of your keys controls this payment address. Create your keys again with the wallet that received it.');
}

// ---------------------------------------------------------------- metadata (ERC-5564 recommended layout)

export const ETH_SELECTOR = '0xeeeeeeee';
export const ETH_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

/** 57 bytes: view tag (1) | 0xeeeeeeee (4) | 0xEeee…EEeE (20) | amount (32). */
export function metadataForETH(viewTag: number, amountWei: bigint): Hex {
  if (viewTag < 0 || viewTag > 255) throw new Error('View tag is one byte');
  if (amountWei < 0n) throw new Error('Amount must be positive');
  return `0x${viewTag.toString(16).padStart(2, '0')}${ETH_SELECTOR.slice(2)}${ETH_TOKEN.slice(2)}${amountWei
    .toString(16)
    .padStart(64, '0')}` as Hex;
}

export type ParsedMetadata = { viewTag: number; selector?: Hex; token?: Hex; amount?: bigint; isETH: boolean };

export function parseMetadata(metadata: Hex): ParsedMetadata {
  if (!/^0x[0-9a-fA-F]{2,}$/.test(metadata)) throw new Error('Empty metadata');
  const viewTag = parseInt(metadata.slice(2, 4), 16);
  if (metadata.length < 2 + 114) return { viewTag, isETH: false };
  const selector = `0x${metadata.slice(4, 12)}` as Hex;
  const token = `0x${metadata.slice(12, 52)}` as Hex;
  const amount = BigInt(`0x${metadata.slice(52, 116)}`);
  return { viewTag, selector, token, amount, isETH: selector.toLowerCase() === ETH_SELECTOR };
}
