import type { CanvasRenderingContext2D } from 'canvas';

import type { TArea, TAreaState, TFractalArea, TGlobal, TImageArea, TLayout, TLayoutState, TMeasure, TTextArea } from './types.ts';
import { byZ } from './area.ts';
import { dither } from './dither.ts';
import { fractalGray } from './fractal.ts';
import type { ImageBank } from './images.ts';

// Draws a layout onto a node-canvas context. Pure with respect to the panel -
// src/panel.ts decides what to push and when; this only puts pixels down, so
// the same code serves both the hardware and the editor's preview PNG.

const WHITE = '#FFFFFF';
const BLACK = '#000000';

// State arrives from /intake and from POST bodies, so a number or boolean is
// entirely possible. Render it rather than silently falling back to the
// area's default, which would show stale text and look like a lost update.
function textOf(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return fallback;
}

function drawText(ctx: CanvasRenderingContext2D, area: TTextArea, state: TAreaState): void {
  // State wins over the area's default text: the default is only the seed
  // value, and /intake replaces it.
  const text = textOf(state['text'], area.text);
  if (text === '') return;

  ctx.fillStyle = BLACK;
  ctx.font = `${area.fontWeight} ${area.fontSize}px "${area.font}", serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = area.align;

  const y = area.y + area.h / 2;
  const x = area.align === 'left' ? area.x : area.align === 'right' ? area.x + area.w : area.x + area.w / 2;

  ctx.save();
  // Clip so an overlong string cannot bleed into a neighbouring area and
  // desynchronise what the overlap bookkeeping thinks was repainted.
  ctx.beginPath();
  ctx.rect(area.x, area.y, area.w, area.h);
  ctx.clip();
  ctx.fillText(text, x, y);
  ctx.restore();
}

// background-size along one axis: px is literal, % is relative to the area.
function resolveSize(size: TMeasure, areaExtent: number): number {
  return size.unit === '%' ? (areaExtent * size.value) / 100 : size.value;
}

// background-position. px is a plain offset from the area's top-left. % uses
// the CSS definition - the percentage of the *leftover* space - so 0% is
// flush left, 50% centres, and 100% is flush right, whatever the image size.
function resolvePosition(pos: TMeasure, areaExtent: number, drawExtent: number): number {
  return pos.unit === '%' ? ((areaExtent - drawExtent) * pos.value) / 100 : pos.value;
}

function drawImageArea(
  ctx: CanvasRenderingContext2D,
  area: TImageArea,
  images: ImageBank,
): boolean {
  const image = area.src === null ? undefined : images.get(area.src);
  if (!image || image.width === 0 || image.height === 0) return false;

  const aspect = image.width / image.height;
  // Only one axis is given; the other follows from the source's aspect, so
  // the picture is never stretched.
  const drawW = area.sizeAxis === 'width' ? resolveSize(area.size, area.w) : resolveSize(area.size, area.h) * aspect;
  const drawH = area.sizeAxis === 'width' ? resolveSize(area.size, area.w) / aspect : resolveSize(area.size, area.h);
  if (drawW <= 0 || drawH <= 0) return false;

  const dx = area.x + resolvePosition(area.posX, area.w, drawW);
  const dy = area.y + resolvePosition(area.posY, area.h, drawH);

  ctx.save();
  ctx.beginPath();
  ctx.rect(area.x, area.y, area.w, area.h);
  ctx.clip();
  ctx.drawImage(image, dx, dy, drawW, drawH);
  ctx.restore();

  // Dither the area's whole rectangle, not just where the image landed: the
  // white margin around it is already pure white, so including it costs
  // nothing and keeps the error diffusion continuous across the box instead
  // of restarting at an arbitrary edge.
  const region = ctx.getImageData(area.x, area.y, area.w, area.h);
  dither(region.data, area.w, area.h, area.dither, area.bias);
  ctx.putImageData(region, area.x, area.y);
  return true;
}

// Seeds come from /intake as strings and from the timer as numbers.
export function seedOf(state: TAreaState): number {
  const value = Number(state['seed']);
  return Number.isFinite(value) ? Math.trunc(value) >>> 0 : 1;
}

// The last dithered fractal, kept so the repaints an overlapping neighbour
// causes do not recompute a picture that has not changed. One entry is
// enough: the timer replaces the picture, it never alternates between two.
const fractalCache = new Map<string, Uint8ClampedArray>();

function drawFractalArea(ctx: CanvasRenderingContext2D, area: TFractalArea, state: TAreaState, name = ''): void {
  const seed = seedOf(state);
  const key = [name, seed, area.kind, area.w, area.h, area.outerWhite, area.whiteCutoff, area.negative, area.dither, area.bias].join('|');

  let pixels = fractalCache.get(key);
  if (!pixels) {
    const gray = fractalGray(seed, area.kind, area.w, area.h, area.outerWhite, area.whiteCutoff);
    const rgba = new Uint8ClampedArray(area.w * area.h * 4);
    for (let p = 0; p < gray.length; p += 1) {
      const v = area.negative ? 255 - gray[p]! : gray[p]!;
      rgba[p * 4] = v;
      rgba[p * 4 + 1] = v;
      rgba[p * 4 + 2] = v;
      rgba[p * 4 + 3] = 255;
    }
    dither(rgba, area.w, area.h, area.dither, area.bias);
    pixels = rgba;
    // Entries for this area's earlier pictures are dead weight.
    for (const old of fractalCache.keys()) if (old.startsWith(`${name}|`)) fractalCache.delete(old);
    fractalCache.set(key, pixels);
  }

  const image = ctx.createImageData(area.w, area.h);
  image.data.set(pixels);
  ctx.putImageData(image, area.x, area.y);
}

function drawPlaceholder(ctx: CanvasRenderingContext2D, area: TArea, label: string): void {
  ctx.strokeStyle = BLACK;
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.strokeRect(area.x + 0.5, area.y + 0.5, area.w - 1, area.h - 1);
  ctx.setLineDash([]);

  ctx.fillStyle = BLACK;
  ctx.font = '12px serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, area.x + area.w / 2, area.y + area.h / 2);
}

export function clearArea(ctx: CanvasRenderingContext2D, area: TArea): void {
  ctx.fillStyle = WHITE;
  ctx.fillRect(area.x, area.y, area.w, area.h);
}

export function drawArea(
  ctx: CanvasRenderingContext2D,
  area: TArea,
  state: TAreaState,
  images: ImageBank,
  name = '',
): void {
  clearArea(ctx, area);

  switch (area.type) {
    case 'text':
      drawText(ctx, area, state);
      break;
    case 'image':
      // Falls back to the placeholder when nothing is uploaded yet, or when
      // the stored file has gone missing.
      if (!drawImageArea(ctx, area, images)) drawPlaceholder(ctx, area, 'image');
      break;
    case 'svg':
      drawPlaceholder(ctx, area, 'svg');
      break;
    case 'fractal':
      drawFractalArea(ctx, area, state, name);
      break;
  }
}

// Repaints the named areas in z order onto whatever is already on the canvas.
// Callers are responsible for having expanded the list with everything
// stacked above - see withAreasAbove in src/area.ts.
export function drawAreas(
  ctx: CanvasRenderingContext2D,
  layout: TLayout,
  state: TLayoutState,
  names: string[],
  images: ImageBank,
): void {
  const wanted = new Set(names);
  for (const [name, area] of byZ(layout.areas)) {
    if (!wanted.has(name) || !area.enabled) continue;
    drawArea(ctx, area, state[name] ?? {}, images, name);
  }
}

export function drawLayout(
  ctx: CanvasRenderingContext2D,
  layout: TLayout,
  state: TLayoutState,
  global: TGlobal,
  images: ImageBank,
): void {
  ctx.fillStyle = WHITE;
  ctx.fillRect(0, 0, global.screenWidth, global.screenHeight);
  drawAreas(ctx, layout, state, Object.keys(layout.areas), images);
}
