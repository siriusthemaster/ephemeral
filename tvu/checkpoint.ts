/**
 * Checkpoint: per chain the last scanned block and the set of stealth addresses seen.
 *
 * Files in the checkpoint directory:
 *   checkpoint.json      { schema, chains: { <chain>: { lastBlock, umbra, erc5564, complete } } }
 *   <chain>.addr.gz      20 byte addresses, sorted, gzip
 *   <chain>.skip.gz      8 byte hash prefixes (sha256) of addresses to leave out, sorted, gzip
 *
 * The skip file records the addresses an excluded router announced. It holds hash prefixes, not addresses, and no count
 * of it is published. It no longer takes an address out of the number (bug bounty 8 Nov: anyone could make a router
 * announce somebody else's address and erase it for good): an address counts once anyone but a router announced it.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

export interface ChainState {
  /** Last block fully scanned (inclusive). 0 means nothing scanned yet. */
  lastBlock: number;
  /** All time announcements seen, excluded routers left out. For the cross check against sector.json only. */
  umbra: number;
  erc5564: number;
  /** Adaptive range size, kept between runs. */
  span: number;
  addresses: Set<string>;
  skip: Set<string>;
}

export const newState = (): ChainState => ({ lastBlock: 0, umbra: 0, erc5564: 0, span: 2000, addresses: new Set(), skip: new Set() });

export const skipHash = (addr: string): string =>
  createHash('sha256').update(Buffer.from(addr.toLowerCase().replace(/^0x/, ''), 'hex')).digest('hex').slice(0, 16);

const packHex = (items: string[], bytes: number): Buffer =>
  gzipSync(Buffer.concat(items.sort().map((x) => Buffer.from(x.replace(/^0x/, ''), 'hex').subarray(0, bytes))), { level: 9 });

function unpackHex(buf: Buffer, bytes: number, prefix: string): Set<string> {
  const raw = gunzipSync(buf);
  const out = new Set<string>();
  for (let i = 0; i + bytes <= raw.length; i += bytes) out.add(prefix + raw.subarray(i, i + bytes).toString('hex'));
  return out;
}

function atomicWrite(path: string, data: Buffer | string): void {
  const tmp = path + '.tmp';
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

export function saveCheckpoint(dir: string, chains: Record<string, ChainState>, complete: Record<string, boolean>): void {
  mkdirSync(dir, { recursive: true });
  const meta: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(chains)) {
    atomicWrite(join(dir, `${k}.addr.gz`), packHex([...s.addresses], 20));
    atomicWrite(join(dir, `${k}.skip.gz`), packHex([...s.skip], 8));
    meta[k] = { lastBlock: s.lastBlock, umbra: s.umbra, erc5564: s.erc5564, span: s.span, complete: complete[k] === true };
  }
  // checkpoint.json last: it is the commit marker of a consistent save
  atomicWrite(join(dir, 'checkpoint.json'), JSON.stringify({ schema: 1, chains: meta }, null, 1) + '\n');
}

export function loadCheckpoint(dir: string, keys: string[]): Record<string, ChainState> {
  const out: Record<string, ChainState> = {};
  const metaPath = join(dir, 'checkpoint.json');
  const meta = existsSync(metaPath) ? (JSON.parse(readFileSync(metaPath, 'utf8')) as { schema: number; chains: Record<string, Partial<ChainState>> }) : null;
  for (const k of keys) {
    const s = newState();
    const m = meta && meta.schema === 1 ? meta.chains[k] : undefined;
    if (m && existsSync(join(dir, `${k}.addr.gz`)) && existsSync(join(dir, `${k}.skip.gz`))) {
      s.lastBlock = m.lastBlock ?? 0;
      s.umbra = m.umbra ?? 0;
      s.erc5564 = m.erc5564 ?? 0;
      s.span = m.span ?? 2000;
      s.addresses = unpackHex(readFileSync(join(dir, `${k}.addr.gz`)), 20, '0x');
      s.skip = unpackHex(readFileSync(join(dir, `${k}.skip.gz`)), 8, '');
    }
    out[k] = s;
  }
  return out;
}
