import type {
  TArea,
  TAreaState,
  TAreaType,
  TDither,
  TGlobal,
  THAlign,
  TJsonObject,
  TMeasure,
  TSizeAxis,
  TTextArea,
  TUnit,
} from './types.ts';
import { AREA_TYPES, DITHERS, H_ALIGNS, SIZE_AXES, UNITS } from './types.ts';

// Pure area rules, shared with the browser: geometry, z-ordering, overlap
// derivation, defaults and normalization. Nothing here may import node
// builtins - the editor runs the same code to keep its preview honest.

// The panel's partial-refresh window is addressed in byte columns, so a
// window edge that isn't a multiple of 8 shifts the refreshed region relative
// to the pixel data sent for it. Areas are snapped on the x axis at edit
// time; y needs no alignment.
export const X_ALIGN = 8;

export function snapDown(value: number, step = X_ALIGN): number {
  return Math.floor(value / step) * step;
}

export function snapUp(value: number, step = X_ALIGN): number {
  return Math.ceil(value / step) * step;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function boundingBox(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const x1 = Math.min(...rects.map((r) => r.x));
  const y1 = Math.min(...rects.map((r) => r.y));
  const x2 = Math.max(...rects.map((r) => r.x + r.w));
  const y2 = Math.max(...rects.map((r) => r.y + r.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

// Clamp to the panel and snap x/w to byte columns. Width and height stay at
// least one byte column / one row so an area can never become unclickable.
export function normalizeGeometry(rect: Rect, global: TGlobal): Rect {
  const maxW = snapDown(global.screenWidth);
  const x = Math.max(0, Math.min(snapDown(rect.x), Math.max(0, maxW - X_ALIGN)));
  const y = Math.max(0, Math.min(Math.round(rect.y), Math.max(0, global.screenHeight - 1)));
  const w = Math.max(X_ALIGN, Math.min(snapUp(rect.w), global.screenWidth - x));
  const h = Math.max(1, Math.min(Math.round(rect.h), global.screenHeight - y));
  return { x, y, w, h };
}

// Next z is one above the current maximum, so it is unique and on top.
// Existing z values are never renumbered - only "bring to front" moves one.
export function nextZ(areas: Record<string, TArea>): number {
  const values = Object.values(areas).map((a) => a.z);
  return values.length === 0 ? 1 : Math.max(...values) + 1;
}

export function byZ(areas: Record<string, TArea>): [string, TArea][] {
  return Object.entries(areas).sort(([, a], [, b]) => a.z - b.z);
}

// The derived `overlaps` list on every area: who it intersects, in z order.
// Recomputed wholesale rather than patched, so it cannot drift from geometry.
export function computeOverlaps(areas: Record<string, TArea>): Record<string, string[]> {
  const entries = Object.entries(areas);
  const out: Record<string, string[]> = {};

  for (const [name, area] of entries) {
    out[name] = entries
      .filter(([other, otherArea]) => other !== name && rectsOverlap(area, otherArea))
      .sort(([, a], [, b]) => a.z - b.z)
      .map(([other]) => other);
  }

  return out;
}

// Repainting an area means repainting everything stacked on top of whatever
// gets touched - otherwise the area's own fresh pixels cover a neighbour that
// was drawn above it. Transitive, because an area pulled in this way can
// itself have things above it.
export function withAreasAbove(areas: Record<string, TArea>, seed: string[]): string[] {
  const included = new Set<string>();
  const queue = [...seed];

  while (queue.length > 0) {
    const name = queue.shift();
    if (name === undefined || included.has(name)) continue;
    const area = areas[name];
    if (!area) continue;
    included.add(name);

    for (const other of area.overlaps) {
      const otherArea = areas[other];
      if (otherArea && otherArea.z > area.z && !included.has(other)) queue.push(other);
    }
  }

  return [...included].sort((a, b) => (areas[a]?.z ?? 0) - (areas[b]?.z ?? 0));
}

export function isAreaType(value: unknown): value is TAreaType {
  return typeof value === 'string' && (AREA_TYPES as readonly string[]).includes(value);
}

function asHAlign(value: unknown): THAlign {
  return typeof value === 'string' && (H_ALIGNS as readonly string[]).includes(value)
    ? (value as THAlign)
    : 'center';
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function measure(value: unknown, fallback: TMeasure): TMeasure {
  const source: TJsonObject =
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as TJsonObject) : {};
  return {
    value: num(source['value'], fallback.value),
    unit: oneOf<TUnit>(source['unit'], UNITS, fallback.unit),
  };
}

export function defaultArea(type: TAreaType, global: TGlobal, z: number): TArea {
  const geometry = normalizeGeometry(
    { x: 0, y: 0, w: Math.min(160, global.screenWidth), h: Math.min(80, global.screenHeight) },
    global,
  );
  const common = { ...geometry, z, overlaps: [] };

  if (type === 'text') {
    return { ...common, type, text: 'Text', font: 'Ubuntu', fontSize: 32, fontWeight: 'normal', align: 'center' };
  }
  if (type === 'image') {
    return {
      ...common,
      type,
      src: null,
      // Centred and filling the area's width - the "just show me the picture"
      // starting point, from which one number usually gets it right.
      posX: { value: 50, unit: '%' },
      posY: { value: 50, unit: '%' },
      sizeAxis: 'width',
      size: { value: 100, unit: '%' },
      dither: 'floyd-steinberg',
      bias: 0,
    };
  }
  return { ...common, type };
}

// Anything arriving from disk or the network is untrusted: missing or
// wrong-typed fields fall back to a default rather than throwing, so one bad
// hand-edit costs that field instead of the whole layout.
export function normalizeArea(raw: unknown, global: TGlobal, z: number): TArea {
  const source: TJsonObject = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as TJsonObject) : {};
  const type: TAreaType = isAreaType(source['type']) ? source['type'] : 'text';
  const base = defaultArea(type, global, num(source['z'], z));

  const geometry = normalizeGeometry(
    { x: num(source['x'], base.x), y: num(source['y'], base.y), w: num(source['w'], base.w), h: num(source['h'], base.h) },
    global,
  );

  const overlaps = Array.isArray(source['overlaps'])
    ? source['overlaps'].filter((v): v is string => typeof v === 'string')
    : [];

  if (base.type === 'text') {
    return {
      ...base,
      ...geometry,
      overlaps,
      text: str(source['text'], base.text),
      font: str(source['font'], base.font),
      fontSize: Math.max(1, num(source['fontSize'], base.fontSize)),
      fontWeight: str(source['fontWeight'], base.fontWeight),
      align: asHAlign(source['align']),
    };
  }

  if (base.type === 'image') {
    const src = source['src'];
    return {
      ...base,
      ...geometry,
      overlaps,
      src: typeof src === 'string' && src !== '' ? src : null,
      posX: measure(source['posX'], base.posX),
      posY: measure(source['posY'], base.posY),
      sizeAxis: oneOf<TSizeAxis>(source['sizeAxis'], SIZE_AXES, base.sizeAxis),
      size: measure(source['size'], base.size),
      dither: oneOf<TDither>(source['dither'], DITHERS, base.dither),
      bias: Math.max(-128, Math.min(128, num(source['bias'], base.bias))),
    };
  }

  return { ...base, ...geometry, overlaps };
}

// The state an area starts with. Text seeds from its default text, so a
// layout renders something sensible before anything calls /intake; image and
// svg carry no state yet.
export function defaultStateFor(area: TArea): TAreaState {
  return area.type === 'text' ? { text: (area as TTextArea).text } : {};
}

export function defaultLayoutState(areas: Record<string, TArea>): Record<string, TAreaState> {
  return Object.fromEntries(Object.entries(areas).map(([name, area]) => [name, defaultStateFor(area)]));
}
