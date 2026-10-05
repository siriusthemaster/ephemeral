/**
 * End-to-end: the full scan against a fake JSON-RPC node that serves the fixture world.
 * The node enforces a block-range limit (like Alchemy's "this block range should work"),
 * answers batches, rate-limits the first request, supports the finalized tag and paginates
 * asset transfers.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { encodeAbiParameters, encodeEventTopics, type AbiEvent, type Hex } from 'viem';
import { CHAINS, EVENTS } from '../lib/config.ts';
import { hex } from '../lib/util.ts';
import { runScan } from '../scan.ts';
import * as fx from './fixture.ts';

const cfg = CHAINS.sepolia;
const FINALIZED = 5_600_000;
const MAX_RANGE = 400_000n;

interface FakeLog {
  address: string;
  topics: Hex[];
  data: Hex;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
}

function mkLog(address: string, event: AbiEvent, args: Record<string, unknown>, block: number, tx: string): FakeLog {
  const topics = encodeEventTopics({ abi: [event], args } as never) as Hex[];
  const nonIndexed = event.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name as string]) as never) as Hex;
  return { address, topics, data, blockNumber: block, transactionHash: tx, logIndex: 0 };
}

const meta = (selector: string, token: string | null) =>
  ('0x99' + selector + (token ? token.slice(2) : 'ee'.repeat(20)) + '00'.repeat(32)) as Hex;
const KEY = ('0x02' + '22'.repeat(32)) as Hex;
const ZERO32 = ('0x' + '00'.repeat(32)) as Hex;

const logs: FakeLog[] = [];
for (const p of fx.payments) {
  if (p.source === 'umbra') {
    const token = p.asset === 'ETH' ? '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' : p.token;
    logs.push(mkLog(cfg.umbra, EVENTS.umbraAnnouncement, { receiver: p.stealth, amount: 10n ** 17n, token, pkx: ZERO32, ciphertext: ZERO32 }, p.block, p.tx));
  } else {
    const metadata = p.asset === 'ETH' ? meta('eeeeeeee', null) : meta('a9059cbb', p.token);
    logs.push(mkLog(cfg.announcer, EVENTS.erc5564Announcement, { schemeId: 1n, stealthAddress: p.stealth, caller: p.sender, ephemeralPubKey: KEY, metadata }, p.block, p.tx));
  }
}
for (const w of fx.withdrawals.filter((w) => w.kind === 'umbra-token')) {
  logs.push(mkLog(cfg.umbra, EVENTS.umbraTokenWithdrawal, { receiver: w.stealth, acceptor: w.to, amount: 1n, token: w.token }, w.block, w.tx));
}
for (const r of fx.registrations) {
  if (r.registry === 'umbra') {
    logs.push(mkLog(cfg.umbraRegistry, EVENTS.umbraStealthKeyChanged, { registrant: r.registrant, spendingPubKeyPrefix: 2n, spendingPubKey: 1n, viewingPubKeyPrefix: 3n, viewingPubKey: 1n }, r.block, fx.h(401)));
  } else {
    logs.push(mkLog(cfg.registry6538, EVENTS.erc6538MetaAddressSet, { registrant: r.registrant, schemeId: 1n, stealthMetaAddress: (KEY + KEY.slice(2)) as Hex }, r.block, fx.h(402)));
  }
}

const txs = new Map<string, Record<string, unknown>>();
for (const p of fx.payments) txs.set(p.tx, { hash: p.tx, from: p.sender, type: '0x2', maxPriorityFeePerGas: '0x3b9aca00' });
for (const w of fx.withdrawals) {
  txs.set(w.tx, { hash: w.tx, from: w.txFrom, type: hex(w.type), ...(w.fee && w.type >= 2 ? { maxPriorityFeePerGas: hex(BigInt(w.fee)) } : { gasPrice: '0x1' }) });
}

type Transfer = { hash: string; blockNum: string; from: string; to: string; category: string; rawContract: { address: string | null } };
const outgoing = new Map<string, Transfer[]>();
for (const w of fx.withdrawals.filter((w) => w.kind !== 'umbra-token')) {
  const list = outgoing.get(w.stealth) ?? [];
  list.push({ hash: w.tx, blockNum: hex(w.block), from: w.stealth, to: w.to, category: w.kind === 'eth' ? 'external' : 'erc20', rawContract: { address: w.token } });
  outgoing.set(w.stealth, list);
}
const incoming = new Map<string, Transfer[]>();
for (const f of fx.fundings) {
  const list = incoming.get(f.stealth) ?? [];
  list.push({ hash: f.tx, blockNum: hex(f.block), from: f.from, to: f.stealth, category: 'external', rawContract: { address: null } });
  incoming.set(f.stealth, list);
}

let requests = 0;
let rangeErrors = 0;

function handle(method: string, params: any[]): { result?: unknown; error?: { code: number; message: string } } {
  switch (method) {
    case 'eth_chainId':
      return { result: hex(cfg.chainId) };
    case 'eth_blockNumber':
      return { result: hex(FINALIZED + 70) };
    case 'eth_getLogs': {
      const q = params[0];
      const from = BigInt(q.fromBlock);
      const to = BigInt(q.toBlock);
      if (to - from + 1n > MAX_RANGE) {
        rangeErrors++;
        return {
          error: {
            code: -32602,
            message: `Log response size exceeded. Based on your parameters, this block range should work: [${hex(from)}, ${hex(from + MAX_RANGE - 1n)}]`,
          },
        };
      }
      const addrs = new Set((q.address as string[]).map((x) => x.toLowerCase()));
      const t0 = new Set((q.topics[0] as string[]).map((x) => x.toLowerCase()));
      const result = logs
        .filter((l) => BigInt(l.blockNumber) >= from && BigInt(l.blockNumber) <= to && addrs.has(l.address.toLowerCase()) && t0.has(l.topics[0]!.toLowerCase()))
        .map((l) => ({ ...l, blockNumber: hex(l.blockNumber), logIndex: hex(l.logIndex), removed: false }));
      return { result };
    }
    case 'eth_getTransactionByHash':
      return { result: txs.get(params[0]) ?? null };
    case 'eth_getBlockByNumber': {
      const n = params[0] === 'finalized' ? FINALIZED : Number(BigInt(params[0]));
      return { result: { number: hex(n), timestamp: hex(fx.timeOf(n)) } };
    }
    case 'eth_getTransactionCount': {
      const at = Number(BigInt(params[1]));
      return { result: hex(fx.withdrawals.filter((w) => w.txFrom === params[0] && w.block <= at).length) };
    }
    case 'eth_getCode':
      return { result: params[0] === fx.UMBRA ? '0x6080604052' : '0x' };
    case 'alchemy_getAssetTransfers': {
      const q = params[0];
      const all = q.fromAddress ? (outgoing.get(q.fromAddress) ?? []) : (incoming.get(q.toAddress) ?? []);
      const page = q.pageKey ? Number(q.pageKey) : 0;
      const pageKey = page + 1 < all.length ? String(page + 1) : undefined;
      return { result: { transfers: all.slice(page, page + 1), ...(pageKey ? { pageKey } : {}) } };
    }
    default:
      return { error: { code: -32601, message: `the method ${method} does not exist/is not available` } };
  }
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    requests++;
    if (requests === 1) {
      res.writeHead(429).end('slow down');
      return;
    }
    const msg = JSON.parse(body);
    const one = (m: { id: number; method: string; params: any[] }) => ({ jsonrpc: '2.0', id: m.id, ...handle(m.method, m.params) });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(Array.isArray(msg) ? msg.map(one) : one(msg)));
  });
});

let url = '';
let work = '';

before(async () => {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  work = mkdtempSync(join(tmpdir(), 'eph-scan-'));
});

after(() => {
  server.close();
  rmSync(work, { recursive: true, force: true });
});

const quiet = () => {};
const base = () => ({ chain: 'sepolia' as const, rpcUrl: url, cacheDir: join(work, 'cache'), outDir: join(work, 'out'), concurrency: 3, log: quiet });

test('full scan reproduces the fixture numbers', async () => {
  const s = await runScan(base());
  // The cutoff block is found by binary search on the fake chain; its exact value does not change any count.
  const { paperComparable, all, sinceCutoff, byYear, h3, h4 } = s.results;
  assert.deepEqual({ paperComparable, all, sinceCutoff, byYear, h3, h4 }, fx.expected);
  assert.equal(s.blocks.to, String(FINALIZED));
  assert.ok(Number(s.blocks.cutoff) > 3_710_000 && Number(s.blocks.cutoff) < 3_800_000);
  assert.deepEqual(
    { total: s.payments.total, umbra: s.payments.umbra, erc5564: s.payments.erc5564, eth: s.payments.eth, token: s.payments.token, unknown: s.payments.unknown },
    { total: 12, umbra: 6, erc5564: 6, eth: 7, token: 5, unknown: 0 },
  );
  assert.deepEqual(s.registrants, { umbraRegistry: 1, erc6538: 1, total: 2 });
  assert.deepEqual(s.quality, { undecodedLogs: 0, truncatedTransferLookups: 0, notFreshStealthAddresses: 1 });
  assert.ok(rangeErrors > 0, 'range limit was exercised');
  assert.ok(s.rpc.retries > 0, '429 was retried');

  const written = readFileSync(join(work, 'out', 'summary.json'), 'utf8') + readFileSync(join(work, 'out', 'summary.md'), 'utf8');
  for (const addr of [fx.R1, fx.R2, fx.D(1), fx.S(1), fx.A(2), fx.T1]) assert.ok(!written.toLowerCase().includes(addr.slice(2)), 'output holds no addresses');
});

test('a cached run and a fresh re-download of the same range give the same fingerprint', async () => {
  const cached = await runScan(base());
  const fresh = await runScan({ ...base(), fresh: true, toBlock: BigInt(FINALIZED) });
  assert.equal(cached.fingerprint, fresh.fingerprint);
  assert.ok(cached.rpc.calls < fresh.rpc.calls);
});

test('asking for another end block starts clean instead of mixing caches', async () => {
  const other = await runScan({ ...base(), toBlock: 3_800_000n });
  assert.equal(other.blocks.to, '3800000');
  assert.equal(other.payments.erc5564, 0);
  const back = await runScan({ ...base(), toBlock: BigInt(FINALIZED) });
  assert.deepEqual(back.results.all, fx.expected.all);
});
