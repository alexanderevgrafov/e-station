import type { TArea, TAreaType, TGlobal, TJsonObject, TLayout, TStore } from './types.ts';
import { DEFAULT_GLOBAL, EMPTY_STORE, isValidName } from './types.ts';
import { isPlainObject } from './settings.ts';
import {
  computeOverlapped,
  defaultArea,
  isAreaType,
  nextZ,
  normalizeArea,
  normalizeGeometry,
  X_ALIGN,
} from './area.ts';

// Every operation on the layouts document, as pure functions: take a store,
// return a new one. Shared with the browser, which is the point - the editor
// applies edits to a local draft and only sends the finished document on
// Sync&Save, so an edit in progress can never reach the panel. Both sides run
// this same code, so a draft the editor accepted is a draft the server will.
//
// Nothing here may import node builtins; file IO lives in store.ts.

export class DocumentError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'DocumentError';
    this.status = status;
  }
}

const NAME_RULE = 'name must be 1-64 chars: letters, digits, spaces, _ or -, starting alphanumeric';

function asJsonObject(value: unknown, what: string): TJsonObject {
  if (!isPlainObject(value)) throw new DocumentError(`${what} must be a JSON object`);
  return value;
}

// z must be unique for "draws later" to be well defined. A hand-edited file
// can easily break that, so ties are broken here rather than trusted.
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

// `overlapped` is derived, so it is recomputed on every read and every write
// and whatever the input claimed is discarded.
function withOverlapped(areas: Record<string, TArea>): Record<string, TArea> {
  const overlapped = computeOverlapped(areas);
  return Object.fromEntries(
    Object.entries(areas).map(([name, area]) => [name, { ...area, overlapped: overlapped[name] ?? [] }]),
  );
}

function normalizeAreas(raw: TJsonObject, global: TGlobal, strict: boolean): Record<string, TArea> {
  const areas: Record<string, TArea> = {};
  let fallbackZ = 1;

  for (const [name, area] of Object.entries(raw)) {
    if (!isValidName(name)) {
      // On load a bad key is skipped (one hand-edit mistake shouldn't cost
      // the layout); on an explicit write it is an error worth reporting.
      if (strict) throw new DocumentError(`area ${NAME_RULE}`);
      continue;
    }
    areas[name] = normalizeArea(area, global, fallbackZ++);
  }

  return withOverlapped(withUniqueZ(areas));
}

function normalizeLayout(value: unknown, name: string, global: TGlobal): TLayout {
  const raw = asJsonObject(value, `layout "${name}"`);
  return {
    settings: isPlainObject(raw['settings']) ? raw['settings'] : {},
    areas: normalizeAreas(isPlainObject(raw['areas']) ? raw['areas'] : {}, global, false),
  };
}

// Anything arriving from disk or over the wire is untrusted - the file is
// hand-editable and older versions of it will not have every key. Missing or
// wrong-typed pieces fall back rather than throwing, so a mistake costs that
// key, not the whole document.
export function normalizeStore(value: unknown): TStore {
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

// Clone-then-mutate: the callers are UI code holding the previous document in
// React state, so operations must not touch what they were given.
function edit(store: TStore, fn: (draft: TStore) => void): TStore {
  const draft = structuredClone(store);
  fn(draft);
  return draft;
}

function requireLayout(store: TStore, name: string): TLayout {
  const layout = store.layouts[name];
  if (!layout) throw new DocumentError(`no layout named "${name}"`, 404);
  return layout;
}

function requireArea(store: TStore, layoutName: string, areaName: string): TArea {
  const area = requireLayout(store, layoutName).areas[areaName];
  if (!area) throw new DocumentError(`no area named "${areaName}" in layout "${layoutName}"`, 404);
  return area;
}

export function setGlobal(store: TStore, global: unknown): TStore {
  const next = asJsonObject(global, 'global');
  for (const key of ['screenWidth', 'screenHeight'] as const) {
    const value = next[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new DocumentError(`global.${key} must be a positive number`);
    }
  }
  for (const key of ['fullRefreshEveryMins', 'fullRefreshEveryNPartials', 'timezoneOffsetMinutes'] as const) {
    const value = next[key];
    if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new DocumentError(`global.${key} must be a number`);
    }
  }

  return edit(store, (draft) => {
    draft.global = { ...DEFAULT_GLOBAL, ...next };
    // A screen-size change can push areas off the panel, so every layout's
    // geometry is re-clamped against the new bounds.
    for (const layout of Object.values(draft.layouts)) {
      layout.areas = withOverlapped(
        Object.fromEntries(
          Object.entries(layout.areas).map(([name, area]) => [
            name,
            { ...area, ...normalizeGeometry(area, draft.global) },
          ]),
        ),
      );
    }
  });
}

export function setGlobalSettings(store: TStore, settings: unknown): TStore {
  const next = asJsonObject(settings, 'settings');
  return edit(store, (draft) => {
    draft.settings = next;
  });
}

export function createLayout(store: TStore, name: string): TStore {
  if (!isValidName(name)) throw new DocumentError(`layout ${NAME_RULE}`);
  return edit(store, (draft) => {
    if (draft.layouts[name]) throw new DocumentError(`layout "${name}" already exists`, 409);
    draft.layouts[name] = { settings: {}, areas: {} };
  });
}

export function setLayoutSettings(store: TStore, name: string, settings: unknown): TStore {
  const next = asJsonObject(settings, 'settings');
  return edit(store, (draft) => {
    requireLayout(draft, name).settings = next;
  });
}

export function setLayoutAreas(store: TStore, layoutName: string, areas: unknown): TStore {
  const next = asJsonObject(areas, 'areas');
  return edit(store, (draft) => {
    requireLayout(draft, layoutName).areas = normalizeAreas(next, draft.global, true);
  });
}

export function renameLayout(store: TStore, from: string, to: string): TStore {
  if (!isValidName(to)) throw new DocumentError(`layout ${NAME_RULE}`);
  return edit(store, (draft) => {
    const layout = requireLayout(draft, from);
    if (from === to) return;
    if (draft.layouts[to]) throw new DocumentError(`layout "${to}" already exists`, 409);
    // Rebuild rather than delete-then-set, so the renamed layout keeps its
    // position in the list instead of jumping to the end.
    draft.layouts = Object.fromEntries(
      Object.entries(draft.layouts).map<[string, TLayout]>(([key, value]) =>
        key === from ? [to, layout] : [key, value],
      ),
    );
  });
}

export function deleteLayout(store: TStore, name: string): TStore {
  return edit(store, (draft) => {
    requireLayout(draft, name);
    delete draft.layouts[name];
  });
}

export function createArea(store: TStore, layoutName: string, areaName: string, type: unknown): TStore {
  if (!isValidName(areaName)) throw new DocumentError(`area ${NAME_RULE}`);
  const areaType: TAreaType = isAreaType(type) ? type : 'text';
  return edit(store, (draft) => {
    const layout = requireLayout(draft, layoutName);
    if (layout.areas[areaName]) throw new DocumentError(`area "${areaName}" already exists`, 409);
    layout.areas[areaName] = defaultArea(areaType, draft.global, nextZ(layout.areas));
    layout.areas = withOverlapped(layout.areas);
  });
}

// One write path for every field of an area. `overlapped` and `z` in the
// patch are ignored - the first is derived, the second only moves via
// bringAreaToFront.
export function updateArea(store: TStore, layoutName: string, areaName: string, patch: unknown): TStore {
  const next = asJsonObject(patch, 'area');
  return edit(store, (draft) => {
    const layout = requireLayout(draft, layoutName);
    const current = requireArea(draft, layoutName, areaName);
    const merged = { ...current, ...next, z: current.z, overlapped: current.overlapped };
    layout.areas[areaName] = normalizeArea(merged, draft.global, current.z);
    layout.areas = withOverlapped(layout.areas);
  });
}

export function renameArea(store: TStore, layoutName: string, from: string, to: string): TStore {
  if (!isValidName(to)) throw new DocumentError(`area ${NAME_RULE}`);
  return edit(store, (draft) => {
    const layout = requireLayout(draft, layoutName);
    const area = requireArea(draft, layoutName, from);
    if (from === to) return;
    if (layout.areas[to]) throw new DocumentError(`area "${to}" already exists`, 409);
    layout.areas = withOverlapped(
      Object.fromEntries(
        Object.entries(layout.areas).map<[string, TArea]>(([key, value]) => (key === from ? [to, area] : [key, value])),
      ),
    );
  });
}

export function deleteArea(store: TStore, layoutName: string, areaName: string): TStore {
  return edit(store, (draft) => {
    const layout = requireLayout(draft, layoutName);
    requireArea(draft, layoutName, areaName);
    delete layout.areas[areaName];
    layout.areas = withOverlapped(layout.areas);
  });
}

export function bringAreaToFront(store: TStore, layoutName: string, areaName: string): TStore {
  return edit(store, (draft) => {
    const layout = requireLayout(draft, layoutName);
    const area = requireArea(draft, layoutName, areaName);
    const top = nextZ(layout.areas) - 1;
    if (area.z === top) return;
    layout.areas[areaName] = { ...area, z: top + 1 };
    layout.areas = withOverlapped(layout.areas);
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
  throw new DocumentError(`could not find a free name based on "${base}"`);
}

export function cloneArea(store: TStore, layoutName: string, from: string, to?: string): TStore {
  if (to !== undefined && !isValidName(to)) throw new DocumentError(`area ${NAME_RULE}`);
  return edit(store, (draft) => {
    const layout = requireLayout(draft, layoutName);
    const source = requireArea(draft, layoutName, from);
    const name = to ?? uniqueAreaName(layout.areas, from);
    if (layout.areas[name]) throw new DocumentError(`area "${name}" already exists`, 409);

    // Offset so the copy is visibly its own box rather than sitting exactly
    // under the original, and put it on top.
    const nudged = normalizeGeometry({ ...source, x: source.x + X_ALIGN, y: source.y + X_ALIGN }, draft.global);
    layout.areas[name] = { ...source, ...nudged, z: nextZ(layout.areas), overlapped: [] };
    layout.areas = withOverlapped(layout.areas);
  });
}

// Which name cloneArea would pick, so the editor can select the copy without
// diffing the result.
export function clonedAreaName(store: TStore, layoutName: string, from: string, to?: string): string {
  const layout = store.layouts[layoutName];
  if (!layout) return from;
  return to ?? uniqueAreaName(layout.areas, from);
}
