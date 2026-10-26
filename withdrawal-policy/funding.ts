// What reached a payment address and who sent it, read from the chain (0.2.9).
// An ERC-5564 announcement is a claim anyone can make. Its caller is whoever called the Announcer (a relayer, a router,
// a stranger), its metadata may be short (no asset, no amount) or false, and a later announcement for the same address
// can claim any asset and amount. So the asset, the amount shown as sent and the payers H2 compares against come from
// the chain here: the transactions that sent ETH to the address and the Transfer logs to it. Metadata is only compared
// with that evidence, never shown as fact. Everything is read through an injectable reader, so tests need no network.
// Mirror of the ephemeral client's src/lib/funding.ts (client 0.2.9), self-contained: the few helpers it uses from other
// client files (EIP-7708 log parsing, the block order around an announcement, the announcement and metadata shapes)
// are inlined below. Feed `payers` into withdrawChecks (guards.ts): `payer` = the first of them while `payersKnown`
// is true, else undefined (H2 then blocks); `assetUnknown` from paymentView into the H5 input of the same name.
import type { Hex } from 'viem';

/** An ERC-5564 announcement as a scanner reads it. */
export type Announcement = {
  schemeId: bigint;
  stealthAddress: Hex;
  caller: Hex;
  ephemeralPubKey: Hex;
  metadata: Hex;
  txHash: Hex;
  blockNumber: bigint;
  timestamp?: number;
};
/** Announcement metadata in the ERC-5564 recommended layout: view tag, selector, token, amount (57 bytes or more). */
export type ParsedMetadata = { viewTag: number; selector?: Hex; token?: Hex; amount?: bigint; isETH: boolean };
const ETH_SELECTOR = '0xeeeeeeee';
/** Parses metadata. Shorter than 57 bytes: only the view tag, no asset and no amount (most mainnet announcements). */
export function parseMetadata(metadata: Hex): ParsedMetadata {
  if (!/^0x[0-9a-fA-F]{2,}$/.test(metadata)) throw new Error('Empty metadata');
  const viewTag = parseInt(metadata.slice(2, 4), 16);
  if (metadata.length < 2 + 114) return { viewTag, isETH: false };
  const selector = `0x${metadata.slice(4, 12)}` as Hex;
  const token = `0x${metadata.slice(12, 52)}` as Hex;
  const amount = BigInt(`0x${metadata.slice(52, 116)}`);
  return { viewTag, selector, token, amount, isETH: selector.toLowerCase() === ETH_SELECTOR };
}

/** EIP-7708 (Glamsterdam): every ETH transfer with a value logs Transfer(from, to, value) from this address only. */
const SYSTEM_ADDRESS = '0xfffffffffffffffffffffffffffffffffffffffe';
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
function parseEthTransfer(l: FundLog): { from: Hex; to: Hex; value: bigint; blockNumber: bigint | null } | null {
  if (!l || l.removed === true || typeof l.address !== 'string' || l.address.toLowerCase() !== SYSTEM_ADDRESS) return null;
  const t = (l.topics ?? []).map((x) => (typeof x === 'string' ? x.toLowerCase() : ''));
  if (t.length !== 3 || t[0] !== TRANSFER_TOPIC || !ADDRESS_TOPIC.test(t[1] ?? '') || !ADDRESS_TOPIC.test(t[2] ?? '')) return null;
  if (typeof l.data !== 'string' || !WORD.test(l.data)) return null;
  return { from: topicAddr(t[1] ?? ''), to: topicAddr(t[2] ?? ''), value: BigInt(l.data), blockNumber: big(l.blockNumber) };
}

/** Blocks to look at for a payment, nearest first: the announcement block, the next 12, then 2 before. */
export function blockOrder(announceBlock: bigint, latest: bigint): bigint[] {
  const out: bigint[] = [];
  for (let i = 0n; i <= 12n; i++) if (announceBlock + i <= latest) out.push(announceBlock + i);
  for (let i = 1n; i <= 2n; i++) if (announceBlock - i >= 0n) out.push(announceBlock - i);
  return out;
}

/** One announcement that points to one of our payment addresses, with its parsed metadata. */
export type Hit = Announcement & { metaParsed: ParsedMetadata };

/** ETH that reached the address. */
export type EthIn = {
  tx: Hex;
  from: Hex; // who sent the ETH: the transaction sender, or the contract for an internal transfer
  txFrom: Hex | null; // sender of the transaction that carried it (null = not read)
  value: bigint;
  blockNumber: bigint | null;
  direct: boolean; // a plain transaction to the address, the kind /receipt/ can check
};

/** A Transfer log to the address: ERC-20 (three topics) or ERC-721 (four topics). */
export type TokenIn = {
  token: Hex; // the contract that emitted the log
  from: Hex; // topic 1
  txFrom: Hex | null; // sender of the transaction that carried it (null = not read)
  tx: Hex;
  logIndex: number | null;
  blockNumber: bigint | null;
  value: bigint | null; // the amount of a standard ERC-20 log, else null
  kind: 'erc20' | 'erc721';
  standard: boolean; // ERC-20 shape: three topics and the amount as one data word
};

export type HeldToken = { token: Hex; balance: bigint | null; fromLog: boolean };

/** Why the payers of an address are not fully known. */
export type FundingGap = 'unread' | 'sender' | 'eth' | 'spent' | 'token' | 'nothing';
export const FUNDING_GAP: Record<FundingGap, string> = {
  unread: 'the chain could not be read',
  sender: 'the sender of a transaction that paid it could not be read',
  eth: 'part of the ETH on it came from a transaction this app could not find',
  spent: 'it has already sent a transaction, and what reached it can then only be confirmed with Blockscout on',
  token: 'a token on it arrived without a Transfer log this app can read',
  nothing: 'nothing that arrived at it could be found',
};

export type Funding = {
  eth: EthIn[];
  tokens: TokenIn[];
  /** Every ERC-20 candidate (from Transfer logs to the address, or claimed by an announcement) and its balance. */
  held: HeldToken[];
  balance: bigint | null; // ETH, null = not read
  nonce: number | null; // transactions the address signed, null = not read
  /**
   * Every address read from the chain that sent value to this address (the sender of each ETH transfer and of each
   * Transfer log, and the sender of the transaction that carried it), plus the caller and the sender of every
   * announcement for it. Lowercase, unique. H2 compares the destination against all of them.
   */
  payers: Hex[];
  /** True only when every source of what the address received was found and its sender read (fail closed). */
  payersKnown: boolean;
  gap: FundingGap | null;
  /** True when the ETH balance and the Transfer logs to the address were read: what arrived is known. */
  assetsRead: boolean;
};

export type FundingTx = { from: string; to?: string | null; value: bigint; blockNumber?: bigint | null };
/** Incoming ETH an explorer lists for an address: plain transactions to it, and internal transfers to it. */
export type ExplorerIn = { tx: Hex; from: string; value: bigint; internal: boolean };
/** A log as eth_getLogs returns it (viem's formatted logs fit too). */
export type FundLog = {
  address?: string | null;
  topics?: readonly (string | null)[];
  data?: string | null;
  blockNumber?: string | number | bigint | null;
  transactionHash?: string | null;
  logIndex?: string | number | null;
  removed?: boolean;
};

/** The chain reads behind readFunding. Injectable, so tests need no node. */
export type FundingReader = {
  head: () => Promise<bigint>;
  balance: (address: Hex) => Promise<bigint>;
  nonce: (address: Hex) => Promise<number>;
  /** eth_getLogs over [fromBlock, toBlock]; a topic position may be one value, a list (any of them) or null (any). */
  getLogs: (q: { fromBlock: bigint; toBlock: bigint; topics: (Hex | Hex[] | null)[] }) => Promise<FundLog[]>;
  tx: (hash: Hex) => Promise<FundingTx | null>;
  /** Receipt status: true = success, false = reverted, null = unknown. */
  succeeded: (hash: Hex) => Promise<boolean | null>;
  /** The transactions of one block. */
  blockTxs: (n: bigint) => Promise<{ hash: string; from: string; to?: string | null; value: bigint }[]>;
  tokenBalance: (token: Hex, holder: Hex) => Promise<bigint>;
  /** Incoming ETH from an explorer. Left out = no explorer (Blockscout off); a throw = could not be read. */
  explorer?: ((address: Hex, signal?: AbortSignal) => Promise<ExplorerIn[]>) | null;
};

export type FundingQuery = {
  address: Hex;
  announcements: Pick<Announcement, 'txHash' | 'caller' | 'blockNumber'>[];
  claimedTokens?: string[];
};

/** Blocks before the first announcement that are read too: a payer can fund the address first and announce later. */
export const FUNDING_WINDOW = 7_200n;
const CHUNK = 10_000n;
const MIN_CHUNK = 500n;
const PER_QUERY = 50; // addresses per eth_getLogs topic list
const CONCURRENCY = 3;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const ADDRESS_TOPIC = /^0x0{24}[0-9a-f]{40}$/;
const WORD = /^0x[0-9a-fA-F]{64}$/;
const isAddr = (a: unknown): a is string => typeof a === 'string' && ADDRESS.test(a);
const isHash = (h: unknown): h is Hex => typeof h === 'string' && HASH.test(h);
const low = (a: string) => a.toLowerCase() as Hex;
const pad = (a: string) => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}` as Hex;
const topicAddr = (t: string) => `0x${t.slice(-40)}`.toLowerCase() as Hex;
const big = (v: string | number | bigint | null | undefined): bigint | null => {
  if (v === null || v === undefined || v === '') return null;
  try {
    return BigInt(v);
  } catch {
    return null;
  }
};

/** eth_getLogs over [from, to] in ranges of CHUNK blocks; a refused range is retried at half the size, down to MIN_CHUNK. */
async function logsInRange(r: FundingReader, topics: (Hex | Hex[] | null)[], from: bigint, to: bigint, signal?: AbortSignal) {
  const logs: FundLog[] = [];
  let size = CHUNK;
  for (let start = from; start <= to; ) {
    if (signal?.aborted) throw new Error('aborted');
    const end = start + size - 1n < to ? start + size - 1n : to;
    try {
      logs.push(...(await r.getLogs({ fromBlock: start, toBlock: end, topics })));
      start = end + 1n;
    } catch {
      if (size <= MIN_CHUNK) throw new Error('logs');
      size = size / 2n > MIN_CHUNK ? size / 2n : MIN_CHUNK;
    }
  }
  return logs;
}

/**
 * Reads what reached each address and who sent it. ETH: the explorer's incoming transfers (when an explorer is
 * given), each confirmed on the node; EIP-7708 ETH logs where the chain has them; and, while the ETH found does not
 * account for the balance, the plain transactions to the address in the blocks around each announcement. Tokens: one
 * eth_getLogs pass for all addresses (Transfer with `to` = one of them), from FUNDING_WINDOW blocks before the first
 * announcement to the head. The ETH found must account for the balance exactly while the address has signed nothing
 * (nonce 0); after that only an explorer can list what reached it, so without one the payers stay unknown.
 */
export async function readFunding(
  reader: FundingReader,
  queries: FundingQuery[],
  opts: { startBlock: bigint; signal?: AbortSignal },
): Promise<Record<string, Funding>> {
  const out: Record<string, Funding> = {};
  const qs = queries.filter((q) => isAddr(q?.address));
  if (!qs.length) return out;
  const head = await reader.head().catch(() => null);

  // one pass for every address: Transfer logs whose `to` (topic 2) is one of them
  const logsBy = new Map<string, FundLog[]>();
  let logsOk = head !== null;
  if (head !== null) {
    let first = head;
    for (const q of qs) for (const a of q.announcements) if (typeof a.blockNumber === 'bigint' && a.blockNumber < first) first = a.blockNumber;
    let from = first > FUNDING_WINDOW ? first - FUNDING_WINDOW : 0n;
    if (from < opts.startBlock) from = opts.startBlock;
    for (let i = 0; i < qs.length; i += PER_QUERY) {
      const group = qs.slice(i, i + PER_QUERY).map((q) => pad(q.address));
      try {
        for (const l of await logsInRange(reader, [TRANSFER_TOPIC, null, group], from, head, opts.signal)) {
          const t2 = l.topics?.[2];
          if (typeof t2 !== 'string') continue;
          const k = topicAddr(t2);
          logsBy.set(k, [...(logsBy.get(k) ?? []), l]);
        }
      } catch {
        logsOk = false;
      }
    }
  }

  const txCache = new Map<string, Promise<FundingTx | null>>();
  const txOf = (h: Hex) => {
    const k = h.toLowerCase();
    if (!txCache.has(k)) txCache.set(k, reader.tx(h).catch(() => null));
    return txCache.get(k)!;
  };

  const one = async (q: FundingQuery): Promise<Funding> => {
    const a = low(q.address);
    const [balance, nonce] = await Promise.all([
      reader
        .balance(q.address)
        .then((b) => (typeof b === 'bigint' && b >= 0n ? b : null))
        .catch(() => null),
      reader
        .nonce(q.address)
        .then((n) => (Number.isSafeInteger(n) && n >= 0 ? n : null))
        .catch(() => null),
    ]);
    const eth: EthIn[] = [];
    const tokens: TokenIn[] = [];
    // one ETH transfer seen twice (explorer and node, or an EIP-7708 log of a plain transaction) counts once
    const addEth = (e: EthIn) => {
      const same = eth.find((x) => x.tx.toLowerCase() === e.tx.toLowerCase() && x.from === e.from && x.value === e.value);
      if (!same) return void eth.push(e);
      if (e.direct) same.direct = true;
      same.txFrom ??= e.txFrom;
      same.blockNumber ??= e.blockNumber;
    };

    // 1. Transfer logs to the address: EIP-7708 ETH (emitted by SYSTEM_ADDRESS only), ERC-20 and ERC-721
    for (const l of logsBy.get(a) ?? []) {
      const tx = l.transactionHash;
      if (l.removed === true || !isHash(tx)) continue;
      const e = parseEthTransfer(l);
      if (e) {
        if (e.to === a && e.value > 0n) addEth({ tx, from: e.from, txFrom: null, value: e.value, blockNumber: e.blockNumber, direct: false });
        continue;
      }
      const t = (l.topics ?? []).map((x) => (typeof x === 'string' ? x.toLowerCase() : ''));
      if (t[0] !== TRANSFER_TOPIC || !isAddr(l.address) || l.address.toLowerCase() === SYSTEM_ADDRESS) continue;
      if (!ADDRESS_TOPIC.test(t[1] ?? '') || !ADDRESS_TOPIC.test(t[2] ?? '') || topicAddr(t[2] ?? '') !== a) continue;
      const kind = t.length === 4 ? 'erc721' : t.length === 3 ? 'erc20' : null;
      if (!kind) continue;
      const standard = kind === 'erc20' && typeof l.data === 'string' && WORD.test(l.data);
      const li = big(l.logIndex);
      tokens.push({
        token: low(l.address),
        from: topicAddr(t[1] ?? ''),
        txFrom: null,
        tx,
        logIndex: li === null ? null : Number(li),
        blockNumber: big(l.blockNumber),
        value: standard ? BigInt(l.data as string) : null,
        kind,
        standard,
      });
    }

    // 2. ETH the explorer lists, each one confirmed on the node (a plain payment must match the node exactly)
    let explorerOk = false;
    if (reader.explorer) {
      try {
        const items = await reader.explorer(q.address, opts.signal);
        explorerOk = true;
        for (const it of items) {
          if (!isHash(it?.tx) || typeof it.value !== 'bigint' || it.value <= 0n || !isAddr(it.from)) continue;
          const t = await txOf(it.tx);
          if (!t || t.blockNumber === null || t.blockNumber === undefined || !isAddr(t.from)) continue;
          if ((await reader.succeeded(it.tx).catch(() => null)) !== true) continue;
          if (!it.internal) {
            if (!t.to || t.to.toLowerCase() !== a || t.value !== it.value) continue;
            addEth({ tx: it.tx, from: low(t.from), txFrom: low(t.from), value: t.value, blockNumber: t.blockNumber, direct: true });
          } else addEth({ tx: it.tx, from: low(it.from), txFrom: low(t.from), value: it.value, blockNumber: t.blockNumber, direct: false });
        }
      } catch {
        explorerOk = false;
      }
    }

    // 3. ETH not accounted for yet: plain transactions to the address in the blocks around each announcement
    const sum = () => eth.reduce((s, e) => s + e.value, 0n);
    const accounted = () => balance !== null && nonce !== null && (nonce === 0 ? sum() === balance : eth.length > 0 && sum() >= balance);
    if (head !== null && balance !== null && nonce !== null && !accounted()) {
      const blocks: bigint[] = [];
      for (const x of q.announcements) for (const n of blockOrder(x.blockNumber, head)) if (!blocks.includes(n)) blocks.push(n);
      for (const n of blocks) {
        if (accounted() || opts.signal?.aborted) break;
        const txs = await reader.blockTxs(n).catch(() => null);
        if (!txs) break; // unreadable: what is found so far stays, and the sum decides
        for (const t of txs) {
          if (!isHash(t?.hash) || !t.to || t.to.toLowerCase() !== a || typeof t.value !== 'bigint' || t.value <= 0n || !isAddr(t.from)) continue;
          if ((await reader.succeeded(t.hash).catch(() => null)) !== true) continue;
          addEth({ tx: t.hash, from: low(t.from), txFrom: low(t.from), value: t.value, blockNumber: n, direct: true });
        }
      }
    }

    // 4. the sender of every transaction that paid it, and of every announcement for it
    let senderGap = false;
    for (const e of eth)
      if (!e.txFrom || !e.direct) {
        const t = await txOf(e.tx);
        if (t && isAddr(t.from)) {
          e.txFrom ??= low(t.from);
          // an EIP-7708 log of a plain transaction to the address: that transaction is the payment itself
          if (!e.direct && !!t.to && t.to.toLowerCase() === a && t.value === e.value && low(t.from) === e.from) e.direct = true;
        } else if (!e.txFrom) senderGap = true;
      }
    for (const t of tokens) {
      const x = await txOf(t.tx);
      if (x && isAddr(x.from)) t.txFrom = low(x.from);
      else senderGap = true;
    }
    const announcedBy: Hex[] = [];
    for (const x of q.announcements) {
      if (isAddr(x.caller)) announcedBy.push(low(x.caller));
      const t = isHash(x.txHash) ? await txOf(x.txHash) : null;
      if (t && isAddr(t.from)) announcedBy.push(low(t.from));
      else senderGap = true;
    }

    // 5. ERC-20 candidates: every token with a Transfer log to the address, and every token an announcement claims
    const candidates: { token: Hex; fromLog: boolean }[] = [];
    for (const t of tokens) if (t.kind === 'erc20' && !candidates.some((c) => c.token === t.token)) candidates.push({ token: t.token, fromLog: true });
    for (const c of q.claimedTokens ?? [])
      if (isAddr(c) && !/^0x0{40}$/i.test(c) && !candidates.some((x) => x.token === low(c))) candidates.push({ token: low(c), fromLog: false });
    const held: HeldToken[] = await Promise.all(
      candidates.map(async (c) => ({
        ...c,
        balance: await reader
          .tokenBalance(c.token, q.address)
          .then((b) => (typeof b === 'bigint' && b >= 0n ? b : null))
          .catch(() => null),
      })),
    );

    const payers: Hex[] = [];
    for (const p of [...announcedBy, ...eth.flatMap((e) => [e.from, e.txFrom]), ...tokens.flatMap((t) => [t.from, t.txFrom])])
      if (isAddr(p) && !payers.includes(low(p))) payers.push(low(p));

    const arrived =
      eth.length > 0 ||
      tokens.some((t) => t.kind === 'erc721' || !t.standard || (t.value ?? 0n) > 0n) ||
      held.some((h) => (h.balance ?? 0n) > 0n);
    // a held token nobody can be seen sending: who paid it is unknown. A token found through its own log has a sender.
    const tokenGap = held.some((h) => !h.fromLog && (h.balance ?? 0n) > 0n);
    const ethOk =
      balance !== null &&
      nonce !== null &&
      (nonce === 0 ? sum() === balance : explorerOk && eth.length > 0 && sum() >= balance);
    let gap: FundingGap | null = null;
    if (head === null || !logsOk || balance === null || nonce === null) gap = 'unread';
    else if (senderGap) gap = 'sender';
    else if (!ethOk) gap = nonce > 0 && !explorerOk ? 'spent' : 'eth';
    else if (tokenGap) gap = 'token';
    else if (!arrived) gap = 'nothing';
    return {
      eth,
      tokens,
      held,
      balance,
      nonce,
      payers,
      payersKnown: gap === null,
      gap,
      assetsRead: head !== null && logsOk && balance !== null,
    };
  };

  const queue = [...qs];
  const worker = async () => {
    while (queue.length) {
      const q = queue.shift()!;
      out[low(q.address)] = await one(q);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, qs.length) }, worker));
  return out;
}

// ------------------------------------------------------------------ announcements against the evidence

/** What an announcement's metadata claims: ETH or a token, and an amount. Short metadata claims nothing. */
export type Claim = { kind: 'eth'; amount: bigint } | { kind: 'token'; token: Hex; amount: bigint };
export function claimOf(m: ParsedMetadata | undefined): Claim | null {
  if (!m || typeof m.amount !== 'bigint' || !m.selector) return null;
  if (m.isETH) return { kind: 'eth', amount: m.amount };
  if (isAddr(m.token)) return { kind: 'token', token: low(m.token), amount: m.amount };
  return null;
}

/** True when the chain shows what the metadata claims: an ETH transfer of that amount, or that token's log with it. */
export function claimMatches(m: ParsedMetadata | undefined, f: Funding | undefined): boolean {
  const c = claimOf(m);
  if (!c || !f || c.amount <= 0n) return false;
  if (c.kind === 'eth') return f.eth.some((e) => e.value === c.amount);
  return f.tokens.some((t) => t.kind === 'erc20' && t.standard && t.token === c.token && t.value === c.amount);
}

/** Earliest first: lower block, and in the same block the one found later by the scan (scans read newest first). */
function earliestFirst(hits: Hit[]): number[] {
  return hits
    .map((h, i) => ({ i, b: typeof h?.blockNumber === 'bigint' ? h.blockNumber : 0n }))
    .sort((x, y) => (x.b === y.b ? y.i - x.i : x.b < y.b ? -1 : 1))
    .map((x) => x.i);
}

/**
 * The announcement a payment row stands on: the earliest one whose claim matches what the chain shows, else the
 * earliest one. A later announcement cannot push a matching or earlier one aside.
 */
export function pickAnnouncement(hits: Hit[], f: Funding | undefined): { index: number; matched: boolean } {
  const order = earliestFirst(hits);
  for (const i of order) if (claimMatches(hits[i]?.metaParsed, f)) return { index: i, matched: true };
  return { index: order[0] ?? 0, matched: false };
}

/** Shown on a payment when more than one announcement points to its address. */
export const MULTI_ANNOUNCEMENT = 'More than one announcement points to this address; amounts below are read from the chain.';

export type AssetUnknown = 'unread' | 'unseen' | 'nft';
export const ASSET_UNKNOWN: Record<AssetUnknown, string> = {
  unread:
    'What arrived at this address could not be read from the chain. It may hold a token: never top it up with ETH from a wallet linked to you (H5).',
  unseen:
    'Nothing this app can read has arrived at this address. It may hold a token this app does not see: never top it up with ETH from a wallet linked to you (H5).',
  nft: 'This address received a token this app cannot withdraw (ERC-721). Never top it up with ETH from a wallet linked to you (H5).',
};

export type PaymentView = {
  primary: number; // index into the hits of the announcement the row stands on
  matched: boolean; // its claim matches the chain
  multi: boolean; // more than one announcement points to this address
  sentWei: bigint; // ETH that reached the address, from the chain
  receiptTx: Hex | null; // the earliest plain ETH payment to it: what an Unlinked Receipt can be made for
  unpaid: boolean; // announced as an ETH payment, nothing has arrived and nothing ever left
  claimedWei: bigint | null; // what an announcement claims in ETH; shown only labelled as claimed
  assetUnknown: AssetUnknown | null; // why the asset is not known (H5 then treats it as a possible token)
  firstBlock: bigint; // the earliest announcement or arrival
};

/** How a payment row reads, from its announcements and the chain evidence. Nothing here trusts metadata. */
export function paymentView(hits: Hit[], f: Funding | undefined): PaymentView {
  const { index, matched } = pickAnnouncement(hits, f);
  const sentWei = (f?.eth ?? []).reduce((s, e) => s + e.value, 0n);
  const direct = (f?.eth ?? [])
    .filter((e) => e.direct)
    .sort((x, y) => ((x.blockNumber ?? 0n) < (y.blockNumber ?? 0n) ? -1 : (x.blockNumber ?? 0n) > (y.blockNumber ?? 0n) ? 1 : 0));
  const claims = hits.map((h) => claimOf(h.metaParsed));
  const ethClaim = claims.find((c): c is Extract<Claim, { kind: 'eth' }> => c?.kind === 'eth' && c.amount > 0n);
  const arrived =
    !!f &&
    (f.eth.length > 0 ||
      f.tokens.some((t) => t.kind === 'erc721' || !t.standard || (t.value ?? 0n) > 0n) ||
      f.held.some((h) => (h.balance ?? 0n) > 0n) ||
      (f.balance ?? 0n) > 0n);
  const unpaid = !!f && f.assetsRead && !arrived && f.nonce === 0 && f.balance === 0n && !!ethClaim;
  let assetUnknown: AssetUnknown | null = null;
  if (!f || !f.assetsRead) assetUnknown = 'unread';
  else if (!arrived && !unpaid) assetUnknown = 'unseen';
  else if (f.tokens.some((t) => t.kind === 'erc721')) assetUnknown = 'nft';
  let firstBlock: bigint | null = null;
  for (const b of [...hits.map((h) => h.blockNumber), ...(f?.eth ?? []).map((e) => e.blockNumber), ...(f?.tokens ?? []).map((t) => t.blockNumber)])
    if (typeof b === 'bigint' && (firstBlock === null || b < firstBlock)) firstBlock = b;
  return {
    primary: index,
    matched,
    multi: hits.length > 1,
    sentWei,
    receiptTx: direct[0]?.tx ?? null,
    unpaid,
    claimedWei: unpaid && ethClaim ? ethClaim.amount : null,
    assetUnknown,
    firstBlock: firstBlock ?? 0n,
  };
}

/**
 * The order tokens are offered for Withdraw: the token the row's announcement claims when the chain matches it, then
 * a confirmed standard token, then the one that arrived first. Only tokens with a balance are kept.
 */
export function orderTokens<T extends { address: Hex; balance: bigint; check?: { hasCode: boolean | null; standardTransfer: boolean | null } }>(
  tokens: T[],
  f: Funding | undefined,
  claimed: Hex | null,
): T[] {
  const firstSeen = (a: Hex) => {
    let b: bigint | null = null;
    for (const t of f?.tokens ?? []) if (t.token === a.toLowerCase() && t.blockNumber !== null && (b === null || t.blockNumber < b)) b = t.blockNumber;
    return b;
  };
  const rank = (t: T) => (claimed && t.address.toLowerCase() === claimed.toLowerCase() ? 0 : t.check?.hasCode === true && t.check.standardTransfer === true ? 1 : 2);
  return tokens
    .filter((t) => t.balance > 0n)
    .sort((x, y) => {
      const r = rank(x) - rank(y);
      if (r) return r;
      const bx = firstSeen(x.address);
      const by = firstSeen(y.address);
      if (bx === by) return 0;
      if (bx === null) return 1;
      if (by === null) return -1;
      return bx < by ? -1 : 1;
    });
}

// ------------------------------------------------------------------ explorer: incoming ETH from Blockscout

type BsRef = { hash?: string | null } | null | undefined;
type BsIn = {
  hash?: string | null;
  transaction_hash?: string | null;
  tx_hash?: string | null;
  from?: BsRef;
  to?: BsRef;
  value?: string | null;
  status?: string | null;
  success?: boolean | null;
};
type BsPage = { items?: BsIn[]; next_page_params?: Record<string, string | number | null> | null };
const PAGES = 4;
const TIMEOUT_MS = 15_000;

async function getPage(url: URL, signal?: AbortSignal): Promise<BsPage | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal?.aborted) throw new Error('aborted');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort);
    try {
      const res = await fetch(url.toString(), { headers: { accept: 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer', signal: ctrl.signal });
      if (res.status === 404) return null; // the explorer has never seen the address
      if (res.ok) return (await res.json()) as BsPage;
      if (res.status !== 429 && res.status < 500) throw new Error(`http-${res.status}`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith('http-')) throw e;
      if (signal?.aborted) throw new Error('aborted');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    if (attempt < 2) await new Promise((r) => setTimeout(r, 1200 * (attempt + 1)));
  }
  throw new Error('unreachable');
}

/** All items of a Blockscout list with filter=to. More than PAGES pages counts as unreadable (fail safe). */
async function listTo(base: string, path: string, signal?: AbortSignal): Promise<BsIn[]> {
  const out: BsIn[] = [];
  let next: BsPage['next_page_params'] = undefined;
  for (let p = 0; p < PAGES; p++) {
    const url = new URL(base + path);
    url.searchParams.set('filter', 'to');
    for (const [k, v] of Object.entries(next ?? {})) if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
    const page = await getPage(url, signal);
    if (!page) return out;
    out.push(...(page.items ?? []));
    next = page.next_page_params;
    if (!next || !(page.items ?? []).length) return out;
  }
  throw new Error('too many');
}

const wei = (v: unknown): bigint | null => {
  if (typeof v !== 'string' || !/^\d{1,78}$/.test(v)) return null;
  return BigInt(v);
};

/** Incoming ETH from Blockscout's public API: plain transactions to the address, and internal transfers to it. */
export function blockscoutIncoming(base: string) {
  return async (address: Hex, signal?: AbortSignal): Promise<ExplorerIn[]> => {
    const a = address.toLowerCase();
    const out: ExplorerIn[] = [];
    for (const t of await listTo(base, `/addresses/${address}/transactions`, signal)) {
      const v = wei(t.value);
      if (!v || !isHash(t.hash) || (t.to?.hash ?? '').toLowerCase() !== a || !isAddr(t.from?.hash) || (t.status && t.status !== 'ok')) continue;
      out.push({ tx: t.hash, from: t.from!.hash!, value: v, internal: false });
    }
    for (const t of await listTo(base, `/addresses/${address}/internal-transactions`, signal)) {
      const v = wei(t.value);
      const h = t.transaction_hash ?? t.tx_hash;
      if (!v || !isHash(h) || (t.to?.hash ?? '').toLowerCase() !== a || !isAddr(t.from?.hash) || t.success === false) continue;
      out.push({ tx: h, from: t.from!.hash!, value: v, internal: true });
    }
    return out;
  };
}
