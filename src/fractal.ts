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
// Half the Mandelbrot rolls start from one of these (jittered); the other
// half from a random point on the edge of the set (see `edgeSeed`).
const MANDELBROT_SPOTS: [number, number][] = [
  [-0.743643887037151, 0.13182590420533], // seahorse valley
  [-0.1011, 0.9563], // mini-brot chain
  [-1.25066, 0.02012], // period-3 bulb
  [0.001643721971153, 0.822467633298876], // spirals
  [0.2549870375144766, -0.0005679790528465602], // elephant valley
  [-1.7497, 0], // antenna mini-brot
];

// Round bulbs of the Mandelbrot set besides the main cardioid: centre and
// (approximate) radius. Julia constants on or near their rims give whole
// families of shapes the cardioid alone never does (rabbits, basilicas,
// four-armed spirals...).
const BULBS: [number, number, number][] = [
  [-1, 0, 0.25], // period 2: basilica family
  [-0.1226, 0.7449, 0.094], // period 3: rabbits
  [-0.1226, -0.7449, 0.094],
  [0.2822, 0.5301, 0.044], // period 4: four-armed spirals
  [0.2822, -0.5301, 0.044],
  [-1.3107, 0, 0.059], // period 4 off the period-2 bulb
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
  // Zoom as a power of ten over the kind's whole-set view.
  depth: number;
  freq: number;
  phase: number;
  // 0..1, how far the pattern fades to white with distance from the set.
  outer: number;
  // Escape speed (smooth iteration count) below which a pixel is plain white.
  cutoff: number;
  // View shift from the seed's position, as a fraction of the view's width / height.
  offsetX: number;
  offsetY: number;
}

// The slider is log-scaled: escape speeds bunch up at the low end, so a
// linear slider would spend nearly all its travel on the last few pixels.
function paramsFor(seed: number, kind: TFractalKind, outerWhite: number, whiteCutoff: number, maxZoom: number, offsetX: number, offsetY: number): Params {
  const params = rawParams(seed, kind, maxZoom);
  return {
    ...params,
    offsetX: offsetX / 100,
    offsetY: offsetY / 100,
    outer: outerWhite / 100,
    cutoff: Math.expm1((whiteCutoff / 100) * Math.log1p(params.maxIter)),
  };
}

// Iterations before (x, y) escapes; maxIter if it never does.
function escape(x: number, y: number, julia: boolean, cx: number, cy: number, maxIter: number): number {
  let zx = julia ? x : 0;
  let zy = julia ? y : 0;
  const ax = julia ? cx : x;
  const ay = julia ? cy : y;
  let i = 0;
  while (i < maxIter && zx * zx + zy * zy <= 4) {
    const t = zx * zx - zy * zy + ax;
    zy = 2 * zx * zy + ay;
    zx = t;
    i += 1;
  }
  return i;
}

// Walks from (x, y) onto the edge of the set: at each scale, probe random
// points around the current one and move to whichever escapes slowest
// without being inside (slow escape = close to the set), then halve the
// scale. Stops once the scale is below the view, so the view is centred on
// fine edge detail rather than a flat inside or outside patch.
function edgePoint(
  rand: () => number,
  x: number,
  y: number,
  radius: number,
  halfHeight: number,
  esc: (x: number, y: number) => number,
  maxIter: number,
): [number, number] {
  const score = (i: number): number => (i >= maxIter ? -1 : i);
  let best = score(esc(x, y));
  for (let r = radius; r > halfHeight / 2; r /= 2) {
    let nx = x;
    let ny = y;
    for (let k = 0; k < 16; k += 1) {
      const px = x + (rand() * 2 - 1) * r;
      const py = y + (rand() * 2 - 1) * r;
      const s = score(esc(px, py));
      if (s > best) {
        best = s;
        nx = px;
        ny = py;
      }
    }
    x = nx;
    y = ny;
  }
  return [x, y];
}

// A point on the Mandelbrot set's boundary: the main cardioid's rim (half the
// time) or one of the round bulbs' rims, pushed outward by `grow` (radially
// from the bulb's centre; for the cardioid, from the origin).
function edgeSeed(rand: () => number, grow: number): [number, number] {
  const theta = rand() * Math.PI * 2;
  if (rand() < 0.5) {
    return [(0.5 * Math.cos(theta) - 0.25 * Math.cos(2 * theta)) * grow, (0.5 * Math.sin(theta) - 0.25 * Math.sin(2 * theta)) * grow];
  }
  const [bx, by, br] = BULBS[Math.floor(rand() * BULBS.length)]!;
  return [bx + br * grow * Math.cos(theta), by + br * grow * Math.sin(theta)];
}

// Julia rolls: most show the whole set, the rest zoom into its edge.
const JULIA_DEEP_SHARE = 0.4; // share of Julia rolls zoomed into the edge
const JULIA_DEEP_MIN = 0.7; // 10^0.7 = 5x
const JULIA_DEEP_MAX = 1.7; // 10^1.7 = 50x

function rawParams(seed: number, kind: TFractalKind, maxZoom: number): Params {
  const rand = rng(seed);
  const julia = kind === 'julia' || (kind === 'random' && rand() < 0.5);
  const base = {
    rotation: rand() * Math.PI * 2,
    freq: 0.12 + rand() * 0.4,
    phase: rand() * Math.PI * 2,
    outer: 0,
    cutoff: 0,
    offsetX: 0,
    offsetY: 0,
  };

  if (julia) {
    // A constant on or just outside the rim of the cardioid or a bulb:
    // connected-ish sets with fine filaments; further out, dust. Squared so
    // most land close to the rim. Bulbs may also dip a little inside, which
    // still gives rabbit / basilica-like sets rather than blobs.
    const g = rand();
    const [cx, cy] = edgeSeed(rand, 1 + g * g * 0.1 - (rand() < 0.3 ? 0.08 : 0));
    const deep = rand() < JULIA_DEEP_SHARE;
    const depth = deep ? JULIA_DEEP_MIN + rand() * (JULIA_DEEP_MAX - JULIA_DEEP_MIN) : rand() * 0.4;
    const view = zoomed(depth, true);
    let centerX = (rand() - 0.5) * 0.3;
    let centerY = (rand() - 0.5) * 0.3;
    if (deep) {
      const esc = (x: number, y: number): number => escape(x, y, true, cx, cy, view.maxIter);
      [centerX, centerY] = edgePoint(rand, (rand() - 0.5) * 2, (rand() - 0.5) * 2, 1, view.halfHeight, esc, view.maxIter);
    }
    return { ...base, julia, cx, cy, centerX, centerY, ...view };
  }

  // zoom of 10^0.5 .. 10^maxZoom (3.5 unless the area says otherwise)
  const depth = MIN_DEPTH + rand() * Math.max(0, maxZoom - MIN_DEPTH);
  const view = zoomed(depth, false);
  let centerX: number;
  let centerY: number;
  if (rand() < 0.5) {
    // A known spot, shifted by up to half the view so it is not always dead centre.
    const [sx, sy] = MANDELBROT_SPOTS[Math.floor(rand() * MANDELBROT_SPOTS.length)]!;
    centerX = sx + (rand() - 0.5) * view.halfHeight;
    centerY = sy + (rand() - 0.5) * view.halfHeight;
  } else {
    const [sx, sy] = edgeSeed(rand, 1.02);
    const esc = (x: number, y: number): number => escape(x, y, false, 0, 0, view.maxIter);
    [centerX, centerY] = edgePoint(rand, sx, sy, 0.05, view.halfHeight, esc, view.maxIter);
  }
  return { ...base, julia, cx: 0, cy: 0, centerX, centerY, ...view };
}

const MIN_DEPTH = 0.5;

// Visible half-height and iteration budget for a zoom depth. Julia's whole
// set fits in a smaller view than Mandelbrot's, and needs fewer iterations.
function zoomed(depth: number, julia: boolean): Pick<Params, 'depth' | 'halfHeight' | 'maxIter'> {
  return julia
    ? { depth, halfHeight: 1.1 / 10 ** depth, maxIter: Math.min(260, Math.round(140 + 60 * depth)) }
    : { depth, halfHeight: 1.3 / 10 ** depth, maxIter: Math.min(260, Math.round(90 + 45 * depth)) };
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
      const ux = (px - w / 2 + p.offsetX * w) * scale;
      const uy = (py - h / 2 + p.offsetY * h) * scale;
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

// A zoomed-in view can end up in a featureless patch. If its
// detail is below this, zoom out in steps until it is not.
const MIN_DETAIL = 0.02;
const ZOOM_STEP = 0.5;

function renderBackingOff(w: number, h: number, p: Params): ReturnType<typeof render> {
  let result = render(w, h, p);
  const floor = p.julia ? 0 : MIN_DEPTH;
  for (let depth = p.depth - ZOOM_STEP; result.detail < MIN_DETAIL && depth >= floor; depth -= ZOOM_STEP) {
    result = render(w, h, { ...p, ...zoomed(depth, p.julia) });
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
  offsetX = 0,
  offsetY = 0,
): Uint8Array {
  let best: Uint8Array | null = null;
  let bestSpread = -1;

  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const { gray, interior } = renderBackingOff(w, h, paramsFor((seed + attempt * 7919) >>> 0, kind, outerWhite, whiteCutoff, maxZoom, offsetX, offsetY));
    const score = interior > 0.7 ? 0 : spread(gray);
    if (score > 40) return gray;
    if (score > bestSpread) {
      best = gray;
      bestSpread = score;
    }
  }

  return best!;
}
