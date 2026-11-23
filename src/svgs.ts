import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { Image } from 'canvas';

import { DATA_DIR, StoreError } from './store.ts';
import type { TLayout } from './types.ts';

// Uploaded SVGs: kept verbatim (they are small, and the original is what the
// user would want back), rasterized at draw time. Lives next to the raster
// images under data/, so it survives a redeploy the same way.
export const SVG_DIR = path.join(DATA_DIR, 'svgs');

const MAX_BYTES = 1024 * 1024;

export interface StoredSvg {
  id: string;
  // The drawing's own size: its viewBox, or its width/height when there is
  // no viewBox. Only the aspect ratio really matters; 'natural' fit uses the
  // numbers as pixels.
  width: number;
  height: number;
  bytes: number;
}

interface Source {
  text: string;
  width: number;
  height: number;
}

function fileFor(id: string): string {
  return path.join(SVG_DIR, `${id}.svg`);
}

export function isValidSvgId(id: string): boolean {
  return /^[0-9a-f]{16}$/.test(id);
}

function idFor(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

// ---- parsing -------------------------------------------------------------

const ROOT_TAG = /<svg\b[^>]*>/i;

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? '') : null;
}

// "12", "12.5px", "3mm" -> the number; "50%", "auto", "" -> null. Units are not
// converted: node-canvas needs *a* size, and the aspect is what we use.
function plainNumber(value: string | null): number | null {
  if (value === null || value.includes('%')) return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function viewBoxOf(tag: string): { x: number; y: number; w: number; h: number } | null {
  const raw = attr(tag, 'viewBox');
  if (raw === null) return null;
  const parts = raw.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) return null;
  const [x, y, w, h] = parts as [number, number, number, number];
  return w > 0 && h > 0 ? { x, y, w, h } : null;
}

function parseSource(text: string): Source | null {
  const tag = ROOT_TAG.exec(text)?.[0];
  if (!tag) return null;
  const box = viewBoxOf(tag);
  const width = box?.w ?? plainNumber(attr(tag, 'width'));
  const height = box?.h ?? plainNumber(attr(tag, 'height'));
  return width && height ? { text, width, height } : null;
}

// node-canvas rasterizes an SVG at the size its root element declares, then
// scales that bitmap - so a viewBox-only icon fails to load, and a 24px icon
// drawn at 300px comes out blurry. Rewriting the root's width/height to the
// size about to be drawn makes librsvg render the vectors at that size.
function sizedMarkup(source: Source, w: number, h: number, stretch: boolean): string {
  const tag = ROOT_TAG.exec(source.text)![0];
  const box = viewBoxOf(tag);

  let next = tag
    .replace(/\s(?:width|height|preserveAspectRatio)\s*=\s*(?:"[^"]*"|'[^']*')/gi, '')
    .replace(/\s*\/?>$/, '');
  const closing = tag.endsWith('/>') ? '/>' : '>';
  if (!box) next += ` viewBox="0 0 ${source.width} ${source.height}"`;
  next += ` width="${w}" height="${h}"`;
  if (stretch) next += ' preserveAspectRatio="none"';

  return source.text.replace(tag, next + closing);
}

// ---- storage -------------------------------------------------------------

export async function saveSvg(buffer: Buffer): Promise<StoredSvg> {
  if (buffer.length === 0) throw new StoreError('empty upload');
  if (buffer.length > MAX_BYTES) throw new StoreError('svg is larger than 1 MB');

  const text = buffer.toString('utf8');
  const source = parseSource(text);
  if (!source) throw new StoreError('not an SVG with a viewBox or numeric width and height');
  // The renderer would happily follow these; an uploaded file has no business
  // making the device read other files or run anything.
  if (/<script|<!ENTITY|<foreignObject/i.test(text)) throw new StoreError('svg uses scripts, entities or foreignObject');
  if (/href\s*=\s*["'](?!#|data:)/i.test(text)) throw new StoreError('svg references external files');

  const id = idFor(buffer);
  await fs.mkdir(SVG_DIR, { recursive: true });
  await fs.writeFile(fileFor(id), buffer);
  sources.delete(id);
  return { id, width: source.width, height: source.height, bytes: buffer.length };
}

export async function list(): Promise<StoredSvg[]> {
  let names: string[];
  try {
    names = await fs.readdir(SVG_DIR);
  } catch {
    return [];
  }

  const ids = names.filter((name) => name.endsWith('.svg')).map((name) => path.basename(name, '.svg'));
  const found = await Promise.all(
    ids.filter(isValidSvgId).map(async (id) => {
      const source = await loadSource(id);
      if (!source) return null;
      return { id, width: source.width, height: source.height, bytes: Buffer.byteLength(source.text) };
    }),
  );
  return found.filter((svg): svg is StoredSvg => svg !== null);
}

export async function remove(id: string): Promise<void> {
  if (!isValidSvgId(id)) throw new StoreError('bad svg id');
  sources.delete(id);
  try {
    await fs.unlink(fileFor(id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new StoreError('no such svg', 404);
    throw error;
  }
}

export function pathFor(id: string): string | null {
  return isValidSvgId(id) ? fileFor(id) : null;
}

// ---- rendering -----------------------------------------------------------

// Parsed sources, kept in memory. A miss caches as null so a deleted file
// does not cost a disk read per frame.
const sources = new Map<string, Source | null>();

async function loadSource(id: string): Promise<Source | null> {
  if (!isValidSvgId(id)) return null;
  const cached = sources.get(id);
  if (cached !== undefined) return cached;
  try {
    const source = parseSource(await fs.readFile(fileFor(id), 'utf8'));
    sources.set(id, source);
    return source;
  } catch {
    sources.set(id, null);
    return null;
  }
}

// Rendering is synchronous, reading files is not: everything a layout needs is
// read here first (see images.preload), and drawing then only touches memory.
export async function warm(layout: TLayout): Promise<void> {
  const ids = Object.values(layout.areas).flatMap((area) => (area.type === 'svg' && area.src ? [area.src] : []));
  await Promise.all([...new Set(ids)].map(loadSource));
}

export function naturalSize(id: string): { width: number; height: number } | null {
  const source = sources.get(id);
  return source ? { width: source.width, height: source.height } : null;
}

// Rasterized images, newest last. A repaint caused by an overlapping
// neighbour asks for the same size again; a few entries cover that.
const MAX_RASTERS = 8;
const rasters = new Map<string, Image>();

// The drawing as a bitmap exactly w x h, vectors rendered at that size.
export function rasterize(id: string, w: number, h: number, stretch: boolean): Image | null {
  const source = sources.get(id);
  if (!source) return null;

  const width = Math.max(1, Math.round(w));
  const height = Math.max(1, Math.round(h));
  const key = `${id}|${width}|${height}|${stretch}`;

  const hit = rasters.get(key);
  if (hit) {
    rasters.delete(key);
    rasters.set(key, hit);
    return hit;
  }

  const image = new Image();
  try {
    // A Buffer source decodes synchronously.
    image.src = Buffer.from(sizedMarkup(source, width, height, stretch));
  } catch {
    return null;
  }

  rasters.set(key, image);
  if (rasters.size > MAX_RASTERS) rasters.delete(rasters.keys().next().value as string);
  return image;
}
