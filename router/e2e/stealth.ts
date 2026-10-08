// ERC-5564 scheme 1 (secp256k1 with view tags) and the ephemeral key derivation: the same code the ephemeral client runs.
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

/** Splits a 65-byte signature into r and s and hashes each into a key: p_spend = keccak256(r), p_view = keccak256(s), mod n. */
export function keysFromSignature(signature: Hex): StealthKeys {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error('Expected a 65-byte signature');
  const r = `0x${signature.slice(2, 66)}` as Hex;
  const s = `0x${signature.slice(66, 130)}` as Hex;
  const spend = toScalar(keccak256(r));
  const view = toScalar(keccak256(s));
  return {
    spendingPrivateKey: scalarHex(spend),
    viewingPrivateKey: scalarHex(view),
    spendingPublicKey: pubOf(spend),
    viewingPublicKey: pubOf(view),
  };
}

/** The 66-byte stealth meta-address: compressed spending key followed by compressed viewing key. */
export function metaAddressOf(keys: Pick<StealthKeys, 'spendingPublicKey' | 'viewingPublicKey'>): Hex {
  return `0x${keys.spendingPublicKey.slice(2)}${keys.viewingPublicKey.slice(2)}` as Hex;
}

export const metaAddressURI = (meta: Hex) => `st:eth:${meta}`;

export type MetaAddress = { spendingPublicKey: Hex; viewingPublicKey: Hex };

/** Accepts `st:eth:0x…`, `st:<chain>:0x…` or a bare 0x meta-address (66 bytes, or 33 when one key does both jobs). */
export function parseMetaAddress(input: string): MetaAddress {
  let s = input.trim();
  if (s.startsWith('st:')) {
    const parts = s.split(':');
    if (parts.length !== 3) throw new Error('A meta-address URI looks like st:eth:0x…');
    s = parts[2];
  }
  if (!/^0x([0-9a-fA-F]{66}|[0-9a-fA-F]{132})$/.test(s)) throw new Error('Not a stealth meta-address');
  const hex = s.slice(2);
  const spend = `0x${hex.slice(0, 66)}` as Hex;
  const view = (hex.length === 132 ? `0x${hex.slice(66)}` : spend) as Hex;
  for (const k of [spend, view]) {
    try {
      secp256k1.ProjectivePoint.fromHex(k.slice(2)).assertValidity();
    } catch {
      throw new Error('The meta-address contains a key that is not on the curve');
    }
  }
  return { spendingPublicKey: spend, viewingPublicKey: view };
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
