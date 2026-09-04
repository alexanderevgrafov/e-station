import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TArea, TAreaType, TGlobal, TJsonObject, TLayout, TStore } from './types.ts';
import { DEFAULT_GLOBAL, EMPTY_STORE, isValidName } from './types.ts';
import { isPlainObject } from './settings.ts';
import {
  computeOverlaps,
  defaultArea,
  isAreaType,
  nextZ,
  normalizeArea,
  normalizeGeometry,
  X_ALIGN,
} from './area.ts';

export { deepMerge, mergeSettings } from './settings.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Lives outside the synced tree on purpose: deploy.sh rsyncs with --delete
// and excludes `data/`, so what the editor writes on the device survives a
// redeploy instead of being clobbered by whatever is on the dev machine.
export const DATA_DIR = process.env.ESTATION_DATA_DIR ?? path.join(HERE, '..', 'data');
export const STORE_PATH = path.join(DATA_DIR, 'layouts.json');

export class StoreError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
  }
}

function asJsonObject(value: unknown, what: string): TJsonObject {
  if (!isPlainObject(value)) throw new StoreError(`${what} must be a JSON object`);
  return value;
}

function normalizeLayout(value: unknown, name: string, global: TGlobal): TLayout {
  const raw = asJsonObject(value, `layout "${name}"`);
  const rawAreas = isPlainObject(raw['areas']) ? raw['areas'] : {};
  const areas: Record<string, TArea> = {};

  let fallbackZ = 1;
  for (const [areaName, area] of Object.entries(rawAreas)) {
    if (!isValidName(areaName)) continue;
    areas[areaName] = normalizeArea(area, global, fallbackZ++);
  }

  return {
    settings: isPlainObject(raw['settings']) ? raw['settings'] : {},
    areas: withOverlaps(withUniqueZ(areas)),
  };
}

// z must be unique for "draw later" to be well defined. A hand-edited file
// can easily break that, so ties are broken here on load rather than trusted.
function withUniqueZ(areas: Record<string, TArea>): Record<string, TArea> {
  const seen = new Set<number>();
  const out: Record<string, TArea> = {};

  for (const [name, area] of Object.entries(areas).sort(([, a], [, b]) => a.z - b.z)) {
    let z = area.z;
    while (seen.has(z)) z += 1;
    seen.add(z);
    out[name] = { ...area, z };
  }

  return out;
}

// `overlaps` is derived, so it is recomputed on every read and every write
// and whatever the file claimed is discarded.
function withOverlaps(areas: Record<string, TArea>): Record<string, TArea> {
  const overlaps = computeOverlaps(areas);
  return Object.fromEntries(
    Object.entries(areas).map(([name, area]) => [name, { ...area, overlaps: overlaps[name] ?? [] }]),
  );
}

// Anything on disk is treated as untrusted - the file is hand-editable and
// older versions of it will not have every key. Missing or wrong-typed
// pieces fall back to empty rather than throwing, so a hand-edit mistake
// costs you that key, not the whole editor.
function normalizeStore(value: unknown): TStore {
  if (!isPlainObject(value)) return structuredClone(EMPTY_STORE);

  const global: TGlobal = { ...DEFAULT_GLOBAL, ...(isPlainObject(value['global']) ? value['global'] : {}) };
  const layouts: Record<string, TLayout> = {};

  if (isPlainObject(value['layouts'])) {
    for (const [name, layout] of Object.entries(value['layouts'])) {
      if (!isValidName(name)) continue;
      layouts[name] = normalizeLayout(layout, name, global);
    }
  }

  return {
    global,
    settings: isPlainObject(value['settings']) ? value['settings'] : {},
    layouts,
  };
}

// Every mutation is read-modify-write on one file, so they are chained
// through a queue - the same pattern EPaperDisplay uses for hardware pushes.
// Without it two concurrent saves can both read the old document and the
// second write silently drops the first one's change.
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
      throw new StoreError(`${STORE_PATH} is not valid JSON: ${error.message}`, 500);
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

async function mutate(fn: (store: TStore) => void): Promise<TStore> {
  return serialized(async () => {
    const store = await readStore();
    fn(store);
    await writeStore(store);
    return store;
  });
}

function requireLayout(store: TStore, name: string): TLayout {
  const layout = store.layouts[name];
  if (!layout) throw new StoreError(`no layout named "${name}"`, 404);
  return layout;
}

export function setGlobal(global: unknown): Promise<TStore> {
  const next = asJsonObject(global, 'global');
  for (const key of ['screenWidth', 'screenHeight'] as const) {
    const value = next[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new StoreError(`global.${key} must be a positive number`);
    }
  }
  for (const key of ['fullRefreshEveryMins', 'fullRefreshEveryNPartials', 'timezoneOffsetMinutes'] as const) {
    const value = next[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new StoreError(`global.${key} must be a number`);
    }
  }
  return mutate((store) => {
    store.global = { ...DEFAULT_GLOBAL, ...next };
    // Screen size changes can push areas off the panel, so every layout's
    // geometry is re-clamped against the new bounds.
    for (const layout of Object.values(store.layouts)) {
      layout.areas = withOverlaps(
        Object.fromEntries(
          Object.entries(layout.areas).map(([name, area]) => [
            name,
            { ...area, ...normalizeGeometry(area, store.global) },
          ]),
        ),
      );
    }
  });
}

export function setGlobalSettings(settings: unknown): Promise<TStore> {
  const next = asJsonObject(settings, 'settings');
  return mutate((store) => {
    store.settings = next;
  });
}

const NAME_RULE = 'name must be 1-64 chars: letters, digits, spaces, _ or -, starting alphanumeric';

export function createLayout(name: string): Promise<TStore> {
  if (!isValidName(name)) throw new StoreError(`layout ${NAME_RULE}`);
  return mutate((store) => {
    if (store.layouts[name]) throw new StoreError(`layout "${name}" already exists`, 409);
    store.layouts[name] = { settings: {}, areas: {} };
  });
}

export function setLayoutSettings(name: string, settings: unknown): Promise<TStore> {
  const next = asJsonObject(settings, 'settings');
  return mutate((store) => {
    requireLayout(store, name).settings = next;
  });
}

// Areas are edited one at a time through forms now, but the bulk setter stays
// for hand-repair of a whole layout.
export function setLayoutAreas(layoutName: string, areas: unknown): Promise<TStore> {
  const next = asJsonObject(areas, 'areas');
  return mutate((store) => {
    const layout = requireLayout(store, layoutName);
    const normalized: Record<string, TArea> = {};
    let fallbackZ = 1;
    for (const [areaName, area] of Object.entries(next)) {
      if (!isValidName(areaName)) throw new StoreError(`area ${NAME_RULE}`);
      normalized[areaName] = normalizeArea(area, store.global, fallbackZ++);
    }
    layout.areas = withOverlaps(withUniqueZ(normalized));
  });
}

function requireArea(store: TStore, layoutName: string, areaName: string): TArea {
  const area = requireLayout(store, layoutName).areas[areaName];
  if (!area) throw new StoreError(`no area named "${areaName}" in layout "${layoutName}"`, 404);
  return area;
}

export function createArea(layoutName: string, areaName: string, type: unknown): Promise<TStore> {
  if (!isValidName(areaName)) throw new StoreError(`area ${NAME_RULE}`);
  const areaType: TAreaType = isAreaType(type) ? type : 'text';
  return mutate((store) => {
    const layout = requireLayout(store, layoutName);
    if (layout.areas[areaName]) throw new StoreError(`area "${areaName}" already exists`, 409);
    layout.areas[areaName] = defaultArea(areaType, store.global, nextZ(layout.areas));
    layout.areas = withOverlaps(layout.areas);
  });
}

// One write path for every field of an area: geometry, type-specific
// properties, all of it. `overlaps` and `z` in the patch are ignored - the
// first is derived, the second only moves via bringAreaToFront.
export function updateArea(layoutName: string, areaName: string, patch: unknown): Promise<TStore> {
  const next = asJsonObject(patch, 'area');
  return mutate((store) => {
    const layout = requireLayout(store, layoutName);
    const current = requireArea(store, layoutName, areaName);
    const merged = { ...current, ...next, z: current.z, overlaps: current.overlaps };
    layout.areas[areaName] = normalizeArea(merged, store.global, current.z);
    layout.areas = withOverlaps(layout.areas);
  });
}

export function renameArea(layoutName: string, from: string, to: string): Promise<TStore> {
  if (!isValidName(to)) throw new StoreError(`area ${NAME_RULE}`);
  return mutate((store) => {
    const layout = requireLayout(store, layoutName);
    const area = requireArea(store, layoutName, from);
    if (from === to) return;
    if (layout.areas[to]) throw new StoreError(`area "${to}" already exists`, 409);
    const entries = Object.entries(layout.areas).map<[string, TArea]>(([key, value]) =>
      key === from ? [to, area] : [key, value],
    );
    layout.areas = withOverlaps(Object.fromEntries(entries));
  });
}

// Auto-names "hours" -> "hours 2", "hours 3", ... so cloning is one click.
function uniqueAreaName(areas: Record<string, TArea>, base: string): string {
  // Strip an existing trailing counter so cloning a clone doesn't produce
  // "hours 2 2".
  const stem = base.replace(/ \d+$/, '');
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${stem} ${n}`;
    if (!areas[candidate] && isValidName(candidate)) return candidate;
  }
  throw new StoreError(`could not find a free name based on "${base}"`);
}

export function cloneArea(layoutName: string, from: string, to?: string): Promise<TStore> {
  if (to !== undefined && !isValidName(to)) throw new StoreError(`area ${NAME_RULE}`);
  return mutate((store) => {
    const layout = requireLayout(store, layoutName);
    const source = requireArea(store, layoutName, from);
    const name = to ?? uniqueAreaName(layout.areas, from);
    if (layout.areas[name]) throw new StoreError(`area "${name}" already exists`, 409);

    // Offset so the copy is visibly its own box rather than sitting exactly
    // under the original, and put it on top.
    const nudged = normalizeGeometry({ ...source, x: source.x + X_ALIGN, y: source.y + X_ALIGN }, store.global);
    layout.areas[name] = { ...source, ...nudged, z: nextZ(layout.areas), overlaps: [] };
    layout.areas = withOverlaps(layout.areas);
  });
}

export function deleteArea(layoutName: string, areaName: string): Promise<TStore> {
  return mutate((store) => {
    const layout = requireLayout(store, layoutName);
    requireArea(store, layoutName, areaName);
    delete layout.areas[areaName];
    layout.areas = withOverlaps(layout.areas);
  });
}

export function bringAreaToFront(layoutName: string, areaName: string): Promise<TStore> {
  return mutate((store) => {
    const layout = requireLayout(store, layoutName);
    const area = requireArea(store, layoutName, areaName);
    const top = nextZ(layout.areas) - 1;
    if (area.z === top) return;
    layout.areas[areaName] = { ...area, z: top + 1 };
    layout.areas = withOverlaps(layout.areas);
  });
}

export function renameLayout(from: string, to: string): Promise<TStore> {
  if (!isValidName(to)) throw new StoreError(`layout ${NAME_RULE}`);
  return mutate((store) => {
    const layout = requireLayout(store, from);
    if (from === to) return;
    if (store.layouts[to]) throw new StoreError(`layout "${to}" already exists`, 409);
    // Rebuild rather than delete-then-set, so the renamed layout keeps its
    // position in the list instead of jumping to the end.
    const entries = Object.entries(store.layouts).map<[string, TLayout]>(([key, value]) =>
      key === from ? [to, layout] : [key, value],
    );
    store.layouts = Object.fromEntries(entries);
  });
}

export function deleteLayout(name: string): Promise<TStore> {
  return mutate((store) => {
    requireLayout(store, name);
    delete store.layouts[name];
  });
}
