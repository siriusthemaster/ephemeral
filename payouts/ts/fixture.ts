// A deterministic toy world (owners, NFTs, keys) shared by the TypeScript tests and the Solidity test.
//   node --experimental-strip-types fixture.ts > ../test/fixtures/epoch7.json
// writes the plan that test/StealthPayout.t.sol settles on chain (fixture.test.ts checks the file is up to date).
// Keys here are derived from fixed labels: test data only, never use them for anything else.
import { secp256k1 } from '@noble/curves/secp256k1';
import { concat, keccak256, toHex, type Hex } from 'viem';
import { pathToFileURL } from 'node:url';
import { keysFromSignature, metaAddressOf, metadataForETH, type StealthKeys } from './stealth.ts';
import { planEpoch, type Entitlement, type PayoutPlan } from './payout-plan.ts';

const N = secp256k1.CURVE.n;
const label = (s: string) => keccak256(toHex(s));
const scalar = (s: string): Hex => `0x${(BigInt(label(s)) % (N - 1n) + 1n).toString(16).padStart(64, '0')}` as Hex;

/** Stealth keys from a fixed label, through the real derivation (a stand-in for the wallet's signature). */
export function testKeys(name: string): StealthKeys {
  const fakeSignature = concat([label(`${name}/r`), label(`${name}/s`), '0x1b']);
  return keysFromSignature(fakeSignature);
}

export type Owner = { name: string; keys: StealthKeys; metaAddress: Hex; nftIds: bigint[]; walletKey: Hex };

/** 6 registered owners with 1 to 4 NFTs each (12 NFTs). NFTs 13 and 14 belong to an unregistered owner (paid publicly, not here). */
export function testOwners(): Owner[] {
  const holdings: [string, number[]][] = [
    ['alice', [1]],
    ['bob', [2, 3]],
    ['carol', [4]],
    ['dave', [5, 6, 7]],
    ['erin', [8]],
    ['frank', [9, 10, 11, 12]],
  ];
  return holdings.map(([name, ids]) => {
    const keys = testKeys(name);
    return { name, keys, metaAddress: metaAddressOf(keys), nftIds: ids.map(BigInt), walletKey: scalar(`${name}/wallet`) };
  });
}

export const FIXTURE_EPOCH = 7n;
export const FIXTURE_AMOUNT = 10n ** 15n; // 0.001 ETH per NFT

export function testPlan(epoch = FIXTURE_EPOCH, amountEach = FIXTURE_AMOUNT): { owners: Owner[]; plan: PayoutPlan } {
  const owners = testOwners();
  const entitlements: Entitlement[] = owners.flatMap((o) => o.nftIds.map((nftId) => ({ nftId, metaAddress: o.metaAddress })));
  const plan = planEpoch({ epoch, amountEach, entitlements, ephemeralKey: (i) => scalar(`eph/${epoch}/${i}`) });
  return { owners, plan };
}

/** The JSON the Solidity test reads (numbers small enough to be exact in JSON). */
export function buildFixture() {
  const { plan } = testPlan();
  const r = plan.receipts.find((x) => x.nftId === 6n)!; // one of dave's three
  return {
    epoch: Number(plan.epoch),
    amountEach: Number(plan.amountEach),
    commitmentsRoot: plan.commitmentsRoot,
    stealthAddresses: plan.recipients.map((x) => x.stealthAddress),
    ephemeralPubKeys: plan.recipients.map((x) => x.ephemeralPubKey),
    viewTags: plan.recipients.map((x) => parseInt(x.viewTag.slice(2), 16)),
    metadata: plan.recipients.map((x) => metadataForETH(parseInt(x.viewTag.slice(2), 16), plan.amountEach)),
    receipt: { nftId: Number(r.nftId), stealthAddress: r.stealthAddress, salt: r.salt, leaf: r.leaf, proof: r.merkleProof },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.stdout.write(JSON.stringify(buildFixture(), null, 2) + '\n');
}
