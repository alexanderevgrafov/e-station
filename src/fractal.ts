import type { TFractalKind } from './types.ts';

// Black-and-white fractal art, generated from a seed. Pure and free of node
// builtins and canvas: it fills an RGBA buffer, and the renderer dithers and
// paints it. Same seed + kind + size always gives the same picture.

// Small, fast, seedable PRNG (mulberry32).
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Well-known Mandelbrot neighbourhoods that stay interesting when zoomed.
const MANDELBROT_SPOTS: [number, number][] = [
  [-0.743643887037151, 0.13182590420533], // seahorse valley
  [-0.1011, 0.9563], // mini-brot chain
  [-1.25066, 0.02012], // period-3 bulb
  [0.001643721971153, 0.822467633298876], // spirals
  [0.2549870375144766, -0.0005679790528465602], // elephant valley
  [-1.7497, 0], // antenna mini-brot
  [-0.7453, 0.1127], // double spiral
];

const MAX_ESCAPE = 256; // large bailout makes the smooth iteration count smooth

interface Params {
  julia: boolean;
  cx: number; // julia constant
  cy: number;
  centerX: number;
  centerY: number;
  halfHeight: number; // half the visible height, in complex-plane units
  rotation: number;
  maxIter: number;
  // Mandelbrot zoom as a power of ten (0 for julia).
  depth: number;
  freq: number;
  phase: number;
  // 0..1, how far the pattern fades to white with distance from the set.
  outer: number;
  // Escape speed (smooth iteration count) below which a pixel is plain white.
  cutoff: number;
}

// The slider is log-scaled: escape speeds bunch up at the low end, so a
// linear slider would spend nearly all its travel on the last few pixels.
function paramsFor(seed: number, kind: TFractalKind, outerWhite: number, whiteCutoff: number, maxZoom: number): Params {
  const params = rawParams(seed, kind, maxZoom);
  return {
    ...params,
    outer: outerWhite / 100,
    cutoff: Math.expm1((whiteCutoff / 100) * Math.log1p(params.maxIter)),
  };
}

function rawParams(seed: number, kind: TFractalKind, maxZoom: number): Params {
  const rand = rng(seed);
  const julia = kind === 'julia' || (kind === 'random' && rand() < 0.5);
  const base = {
    cx: 0,
    cy: 0,
    rotation: julia ? rand() * Math.PI * 2 : 0,
    freq: 0.12 + rand() * 0.4,
    phase: rand() * Math.PI * 2,
    outer: 0,
    cutoff: 0,
  };

  if (julia) {
    // A point just outside the main cardioid's boundary: connected-ish sets
    // with fine filaments, rather than featureless blobs or pure dust.
    const theta = rand() * Math.PI * 2;
    const grow = 1 + rand() * 0.04;
    const cx = (0.5 * Math.cos(theta) - 0.25 * Math.cos(2 * theta)) * grow;
    const cy = (0.5 * Math.sin(theta) - 0.25 * Math.sin(2 * theta)) * grow;
    return {
      ...base,
      julia,
      cx,
      cy,
      centerX: (rand() - 0.5) * 0.3,
      centerY: (rand() - 0.5) * 0.3,
      halfHeight: 1.1 / (1 + rand() * 1.5),
      maxIter: 140,
      depth: 0,
    };
  }

  const [centerX, centerY] = MANDELBROT_SPOTS[Math.floor(rand() * MANDELBROT_SPOTS.length)]!;
  // zoom of 10^0.5 .. 10^maxZoom (3.5 unless the area says otherwise)
  const depth = MIN_DEPTH + rand() * Math.max(0, maxZoom - MIN_DEPTH);
  return { ...base, julia, centerX, centerY, ...zoomed(depth) };
}

const MIN_DEPTH = 0.5;

function zoomed(depth: number): Pick<Params, 'depth' | 'halfHeight' | 'maxIter'> {
  return { depth, halfHeight: 1.3 / 10 ** depth, maxIter: Math.min(260, Math.round(90 + 45 * depth)) };
}

// Greyscale 0..255, one byte per pixel, the share of pixels that never
// escaped (the "interior"), and how much detail there is (see `detail`).
function render(w: number, h: number, p: Params): { gray: Uint8Array; interior: number; detail: number } {
  const gray = new Uint8Array(w * h);
  const scale = (2 * p.halfHeight) / h;
  const cos = Math.cos(p.rotation);
  const sin = Math.sin(p.rotation);
  const bail = MAX_ESCAPE * MAX_ESCAPE;
  // How sharply the pattern dies off with distance from the set (log scale,
  // like the cutoff, since escape speeds bunch up at the low end).
  const falloff = 3 * p.outer;
  const logMax = Math.log1p(p.maxIter);
  let interior = 0;

  for (let py = 0; py < h; py += 1) {
    for (let px = 0; px < w; px += 1) {
      const ux = (px - w / 2) * scale;
      const uy = (py - h / 2) * scale;
      const x0 = p.centerX + ux * cos - uy * sin;
      const y0 = p.centerY + ux * sin + uy * cos;

      let zx = p.julia ? x0 : 0;
      let zy = p.julia ? y0 : 0;
      const cx = p.julia ? p.cx : x0;
      const cy = p.julia ? p.cy : y0;

      let i = 0;
      let zx2 = zx * zx;
      let zy2 = zy * zy;
      while (i < p.maxIter && zx2 + zy2 <= bail) {
        zy = 2 * zx * zy + cy;
        zx = zx2 - zy2 + cx;
        zx2 = zx * zx;
        zy2 = zy * zy;
        i += 1;
      }

      if (i >= p.maxIter) {
        gray[py * w + px] = 0;
        interior += 1;
        continue;
      }

      const mu = i + 1 - Math.log2(Math.log(zx2 + zy2) / 2);
      const v = 0.5 + 0.5 * Math.sin(mu * p.freq * Math.PI * 2 + p.phase);
      // Escaped faster than the cutoff: plain white, no ribbons. Beyond it the
      // ribbons still fade with distance, by the outer-white amount.
      if (mu < p.cutoff) {
        gray[py * w + px] = 255;
        continue;
      }
      const keep = Math.min(1, Math.max(0, Math.log1p(Math.max(0, mu)) / logMax)) ** falloff;
      gray[py * w + px] = Math.round(255 - (255 - 255 * v) * keep);
    }
  }

  return { gray, interior: interior / (w * h), detail: detail(gray, w, h) };
}

// Share of pixels whose black/white state differs from the right or lower
// neighbour. Plain ink share is a poor "is this boring" test: a solid blob
// edge is 10% ink and sparse filament dust is 3%. Measured on 200x120 views,
// boring ones (empty, or one smooth edge) score under 1.3% here and
// interesting ones, however sparse, 3% and up.
function detail(gray: Uint8Array, w: number, h: number): number {
  let edges = 0;
  for (let y = 0; y < h - 1; y += 1) {
    for (let x = 0; x < w - 1; x += 1) {
      const dark = gray[y * w + x]! < 128;
      if (dark !== gray[y * w + x + 1]! < 128 || dark !== gray[(y + 1) * w + x]! < 128) edges += 1;
    }
  }
  return edges / (w * h);
}

function spread(gray: Uint8Array): number {
  let sum = 0;
  let sumSq = 0;
  for (const v of gray) {
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / gray.length;
  return Math.sqrt(Math.max(0, sumSq / gray.length - mean * mean));
}

// Some seeds land on a flat field of interior or exterior. Those are skipped
// deterministically - the retry seeds derive from the original - so a seed
// still always means one picture.
const ATTEMPTS = 6;

// A zoomed-in Mandelbrot view can end up in a featureless patch. If its
// detail is below this, zoom out in steps until it is not.
const MIN_DETAIL = 0.02;
const ZOOM_STEP = 0.5;

function renderBackingOff(w: number, h: number, p: Params): ReturnType<typeof render> {
  let result = render(w, h, p);
  for (let depth = p.depth - ZOOM_STEP; !p.julia && result.detail < MIN_DETAIL && depth >= MIN_DEPTH; depth -= ZOOM_STEP) {
    result = render(w, h, { ...p, ...zoomed(depth) });
  }
  return result;
}

export function fractalGray(
  seed: number,
  kind: TFractalKind,
  w: number,
  h: number,
  outerWhite: number,
  whiteCutoff: number,
  maxZoom = 3.5,
): Uint8Array {
  let best: Uint8Array | null = null;
  let bestSpread = -1;

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const { gray, interior } = renderBackingOff(w, h, paramsFor((seed + attempt * 7919) >>> 0, kind, outerWhite, whiteCutoff, maxZoom));
    const score = interior > 0.7 ? 0 : spread(gray);
    if (score > 40) return gray;
    if (score > bestSpread) {
      best = gray;
      bestSpread = score;
    }
  }

  return best!;
}
