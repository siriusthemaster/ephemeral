/**
 * A small hand-built world that exercises every rule once. Used by the unit test (directly)
 * and by the end-to-end test (served through a fake JSON-RPC node).
 *
 * S1  Umbra ETH, withdrawn by itself to registrant R1 before the cutoff      -> H1, H4 (fee shared with S2)
 * S2  Umbra ETH, withdrawn by itself back to its sender A2                   -> H2, H4
 * S3  Umbra token, relayer withdraws to D1                                   -> H3 with S4
 * S4  Umbra token, relayer withdraws to D1                                   -> H3 with S3
 * S5  ERC-5564 token, gas from registrant R2 first, then token out + ETH dust sweep
 *                                                                            -> H5; still a single withdrawal
 * S6  ERC-5564 ETH, never withdrawn; a scammer's fake-token "transfer" from it is ignored
 * S7  ERC-5564 ETH, two withdrawals (not single)
 * S8  Umbra ETH, legacy tx into the Umbra contract                           -> contract recipient, no H3, no H4
 * S9  Umbra ETH, legacy tx into the Umbra contract                           -> contract recipient, no H3, no H4
 * S10 ERC-5564 token, relayed (permit) withdrawal of the paid token, nonce 0  -> counts as withdrawn
 * S11 ERC-5564 ETH to an address that had sent a tx before                 -> not fresh, left out entirely
 * S12 ERC-5564 token, gas from its payer, later ETH from R1                   -> needs gas, but no H5
 */
export const a = (n: number): string => '0x' + n.toString(16).padStart(40, '0');
export const h = (n: number): string => '0x' + n.toString(16).padStart(64, '0');

/** Monotonic block -> unix time for the fake chain (piecewise linear). */
const ANCHORS: [number, number][] = [
  [0, Date.parse('2022-01-01T00:00:00Z') / 1000],
  [3_590_000, Date.parse('2023-04-01T00:00:00Z') / 1000],
  [3_700_000, Date.parse('2023-06-01T00:00:00Z') / 1000],
  [3_800_000, Date.parse('2023-08-01T00:00:00Z') / 1000],
  [5_400_000, Date.parse('2024-02-01T00:00:00Z') / 1000],
  [5_600_100, Date.parse('2024-06-01T00:00:00Z') / 1000],
  [9_000_000, Date.parse('2026-01-01T00:00:00Z') / 1000],
];
export function timeOf(block: number): number {
  for (let i = 1; i < ANCHORS.length; i++) {
    const [b1, t1] = ANCHORS[i] as [number, number];
    const [b0, t0] = ANCHORS[i - 1] as [number, number];
    if (block <= b1) return Math.floor(t0 + ((block - b0) * (t1 - t0)) / (b1 - b0));
  }
  return (ANCHORS[ANCHORS.length - 1] as [number, number])[1];
}

/** any block between the last pre-cutoff withdrawal (3,710,000) and S3's payment (3,800,000) */
export const CUTOFF_BLOCK = 3_750_000;

export const UMBRA = '0xfb2dc580eed955b528407b4d36ffafe3da685401';
export const R1 = a(0x101); // Umbra registry registrant
export const R2 = a(0x102); // ERC-6538 registrant
export const RELAYER = a(0x1e1);
export const RELAYER2 = a(0x1e2);
export const SCAMMER = a(0xbad);
export const T0 = a(0x7070); // token paid through Umbra
export const T1 = a(0x7171); // token paid through ERC-5564
export const T9 = a(0x7979); // fake token
export const D = (i: number): string => a(0xd00 + i);
export const S = (i: number): string => a(0x5000 + i);
export const A = (i: number): string => a(0xa000 + i);

export interface FxPayment {
  source: 'umbra' | 'erc5564';
  stealth: string;
  sender: string;
  asset: 'ETH' | 'TOKEN';
  token: string | null;
  block: number;
  tx: string;
}

export interface FxWithdrawal {
  stealth: string;
  tx: string;
  block: number;
  to: string;
  kind: 'eth' | 'token' | 'umbra-token';
  token: string | null;
  txFrom: string;
  type: number;
  fee: string | null;
}

export interface FxFunding {
  stealth: string;
  tx: string;
  block: number;
  from: string;
}

export const payments: FxPayment[] = [
  { source: 'umbra', stealth: S(1), sender: A(1), asset: 'ETH', token: null, block: 3_600_000, tx: h(1) },
  { source: 'umbra', stealth: S(8), sender: A(8), asset: 'ETH', token: null, block: 3_650_000, tx: h(8) },
  { source: 'umbra', stealth: S(9), sender: A(9), asset: 'ETH', token: null, block: 3_660_000, tx: h(9) },
  { source: 'umbra', stealth: S(2), sender: A(2), asset: 'ETH', token: null, block: 3_700_000, tx: h(2) },
  { source: 'umbra', stealth: S(3), sender: A(3), asset: 'TOKEN', token: T0, block: 3_800_000, tx: h(3) },
  { source: 'umbra', stealth: S(4), sender: A(4), asset: 'TOKEN', token: T0, block: 3_900_000, tx: h(4) },
  { source: 'erc5564', stealth: S(5), sender: A(5), asset: 'TOKEN', token: T1, block: 5_500_000, tx: h(5) },
  { source: 'erc5564', stealth: S(6), sender: A(6), asset: 'ETH', token: null, block: 5_550_000, tx: h(6) },
  { source: 'erc5564', stealth: S(7), sender: A(7), asset: 'ETH', token: null, block: 5_560_000, tx: h(7) },
  { source: 'erc5564', stealth: S(10), sender: A(10), asset: 'TOKEN', token: T1, block: 5_570_000, tx: h(10) },
  { source: 'erc5564', stealth: S(11), sender: A(11), asset: 'ETH', token: null, block: 5_580_000, tx: h(11) },
  { source: 'erc5564', stealth: S(12), sender: A(12), asset: 'TOKEN', token: T1, block: 5_585_000, tx: h(12) },
];

export const withdrawals: FxWithdrawal[] = [
  { stealth: S(1), tx: h(101), block: 3_610_000, to: R1, kind: 'eth', token: null, txFrom: S(1), type: 2, fee: '1234567' },
  { stealth: S(2), tx: h(102), block: 3_710_000, to: A(2), kind: 'eth', token: null, txFrom: S(2), type: 2, fee: '1234567' },
  { stealth: S(3), tx: h(103), block: 3_950_000, to: D(1), kind: 'umbra-token', token: T0, txFrom: RELAYER, type: 2, fee: '2000000000' },
  { stealth: S(4), tx: h(104), block: 3_950_000, to: D(1), kind: 'umbra-token', token: T0, txFrom: RELAYER, type: 2, fee: '2000000000' },
  { stealth: S(5), tx: h(105), block: 5_520_000, to: D(2), kind: 'token', token: T1, txFrom: S(5), type: 2, fee: '1500000000' },
  { stealth: S(5), tx: h(125), block: 5_525_000, to: D(2), kind: 'eth', token: null, txFrom: S(5), type: 2, fee: '1500000000' },
  { stealth: S(6), tx: h(106), block: 5_555_000, to: D(9), kind: 'token', token: T9, txFrom: SCAMMER, type: 2, fee: '7' },
  { stealth: S(7), tx: h(107), block: 5_565_000, to: D(3), kind: 'eth', token: null, txFrom: S(7), type: 2, fee: '1000000000' },
  { stealth: S(7), tx: h(117), block: 5_566_000, to: D(4), kind: 'eth', token: null, txFrom: S(7), type: 2, fee: '1000000000' },
  { stealth: S(8), tx: h(108), block: 3_655_000, to: UMBRA, kind: 'eth', token: null, txFrom: S(8), type: 0, fee: null },
  { stealth: S(9), tx: h(109), block: 3_665_000, to: UMBRA, kind: 'eth', token: null, txFrom: S(9), type: 0, fee: null },
  { stealth: S(10), tx: h(110), block: 5_575_000, to: D(5), kind: 'token', token: T1, txFrom: RELAYER2, type: 2, fee: '9' },
  { stealth: S(11), tx: h(111), block: 5_400_000, to: D(6), kind: 'eth', token: null, txFrom: S(11), type: 2, fee: '3000000000' },
  { stealth: S(12), tx: h(112), block: 5_590_000, to: D(7), kind: 'token', token: T1, txFrom: S(12), type: 2, fee: '2500000000' },
];

export const fundings: FxFunding[] = [
  { stealth: S(5), tx: h(205), block: 5_510_000, from: R2 },
  { stealth: S(12), tx: h(212), block: 5_586_000, from: A(12) },
  { stealth: S(12), tx: h(213), block: 5_595_000, from: R1 },
];

export const registrations = [
  { registrant: R1, block: 3_595_000, registry: 'umbra' as const },
  { registrant: R2, block: 5_490_000, registry: 'erc6538' as const },
];

export const contracts = [UMBRA];

/** addresses that had sent transactions before their first payment (the scan finds them by nonce) */
export const preUsed = [S(11)];

const m = (x: Partial<Record<string, number>>) => ({
  stealthAddresses: 0, withdrawn: 0, singleWithdrawal: 0, h1Single: 0, h2Single: 0, paperLinked: 0, paperPct: 0,
  h1Any: 0, h2Any: 0, needingOwnGas: 0, h5: 0, identityLinked: 0, identityPct: 0, ...x,
});

/** What analyze() must return for this world. */
export const expected = {
  paperComparable: m({ stealthAddresses: 4, withdrawn: 4, singleWithdrawal: 4, h1Single: 1, h2Single: 1, paperLinked: 2, paperPct: 50, h1Any: 1, h2Any: 1, identityLinked: 2, identityPct: 50 }),
  all: m({ stealthAddresses: 11, withdrawn: 10, singleWithdrawal: 9, h1Single: 1, h2Single: 1, paperLinked: 2, paperPct: 20, h1Any: 1, h2Any: 1, needingOwnGas: 2, h5: 1, identityLinked: 3, identityPct: 30 }),
  sinceCutoff: m({ stealthAddresses: 7, withdrawn: 6, singleWithdrawal: 5, needingOwnGas: 2, h5: 1, identityLinked: 1, identityPct: 16.67 }),
  byYear: {
    '2023': m({ stealthAddresses: 6, withdrawn: 6, singleWithdrawal: 6, h1Single: 1, h2Single: 1, paperLinked: 2, paperPct: 33.33, h1Any: 1, h2Any: 1, identityLinked: 2, identityPct: 33.33 }),
    '2024': m({ stealthAddresses: 5, withdrawn: 4, singleWithdrawal: 3, needingOwnGas: 2, h5: 1, identityLinked: 1, identityPct: 25 }),
  },
  h3: { clusteredStealth: 2, clusters: 1, largestCluster: 2, pctOfSingle: 22.22 },
  h4: { eligibleTxs: 7, uniqueFeeValues: 4, linkedStealth: 2, groups: 1 },
};
