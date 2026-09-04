import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TStore } from './types.ts';
import { EMPTY_STORE } from './types.ts';
import { DocumentError, normalizeStore } from './document.ts';

// Persistence only. Every rule about what a valid document is lives in
// document.ts, which the browser runs too.

export { DocumentError as StoreError } from './document.ts';
export { deepMerge, mergeSettings } from './settings.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Lives outside the synced tree on purpose: deploy.sh rsyncs with --delete
// and excludes `data/`, so what the editor writes on the device survives a
// redeploy instead of being clobbered by whatever is on the dev machine.
export const DATA_DIR = process.env.ESTATION_DATA_DIR ?? path.join(HERE, '..', 'data');
export const STORE_PATH = path.join(DATA_DIR, 'layouts.json');

// Read-modify-write on one file, so reads and writes are chained - the same
// pattern EPaperDisplay uses for hardware pushes. Without it two concurrent
// saves can both read the old document and the second silently drops the
// first one's change.
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const result = queue.then(fn, fn);
  queue = result.catch(() => {});
  return result;
}

async function readStore(): Promise<TStore> {
  try {
    const raw = await fs.readFile(STORE_PATH, 'utf8');
    return normalizeStore(JSON.parse(raw));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return structuredClone(EMPTY_STORE);
    if (error instanceof SyntaxError) {
      throw new DocumentError(`${STORE_PATH} is not valid JSON: ${error.message}`, 500);
    }
    throw error;
  }
}

async function writeStore(store: TStore): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  // Write-then-rename: a crash mid-write leaves the previous good document
  // in place rather than a truncated one. rename is atomic within a dir.
  const tmp = `${STORE_PATH}.${process.pid}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, STORE_PATH);
}

export function load(): Promise<TStore> {
  return serialized(readStore);
}

// Whole-document save - what Sync&Save sends. The incoming document is
// normalized rather than trusted: it arrived over the wire, and `z` and
// `overlapped` are derived regardless of what the client computed.
export function save(incoming: unknown): Promise<TStore> {
  return serialized(async () => {
    const store = normalizeStore(incoming);
    await writeStore(store);
    return store;
  });
}
