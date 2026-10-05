import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Tiny JSON key-value cache on disk. Makes the scan resumable and a re-run with the same
 * --to-block reproducible. Lives in .cache/ (gitignored): it holds raw public chain data,
 * never published. Pass file = null for an in-memory cache (tests, --fresh).
 */
export class KV<T> {
  private readonly map = new Map<string, T>();
  private dirty = 0;

  constructor(
    private readonly file: string | null,
    private readonly flushEvery = 500,
  ) {
    if (file && existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, T>;
      for (const [k, v] of Object.entries(raw)) this.map.set(k, v);
    }
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  get(key: string): T | undefined {
    return this.map.get(key);
  }

  set(key: string, value: T): void {
    this.map.set(key, value);
    if (++this.dirty >= this.flushEvery) this.flush();
  }

  get size(): number {
    return this.map.size;
  }

  entries(): IterableIterator<[string, T]> {
    return this.map.entries();
  }

  flush(): void {
    if (!this.file || this.dirty === 0) return;
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.map)));
    renameSync(tmp, this.file);
    this.dirty = 0;
  }
}

export function readJson<T>(file: string): T | undefined {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : undefined;
}

export function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, file);
}
