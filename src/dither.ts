import type { TDither } from './types.ts';

// Turning a photo into the two colours the panel can actually show. Every
// algorithm here writes pure 0 or 255 into the RGBA buffer in place, so the
// 1bpp packing in epd.ts (which thresholds at 128) is lossless afterwards.

// Ordered threshold matrices, normalized to 0..1 at use.
//
// Bayer matrices are *dispersed*: the on-pixels spread as far apart as
// possible, giving a fine crosshatch. 4x4 is coarser and more visible, 8x8
// smoother.
const BAYER_4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

const BAYER_8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

// A *clustered-dot* matrix - the on-pixels grow outward from cell centres
// instead of spreading, so mid-tones become a grid of round dots of varying
// size. That is what a printed halftone screen does, and it is the one that
// still reads as a photograph from across a room.
const HALFTONE_8 = [
  [24, 10, 12, 26, 35, 47, 49, 37],
  [8, 0, 2, 14, 45, 59, 61, 51],
  [22, 6, 4, 16, 43, 57, 63, 53],
  [30, 20, 18, 28, 33, 41, 55, 39],
  [34, 46, 48, 36, 25, 11, 13, 27],
  [44, 58, 60, 50, 9, 1, 3, 15],
  [42, 56, 62, 52, 23, 7, 5, 17],
  [32, 40, 54, 38, 31, 21, 19, 29],
];

// Error-diffusion kernels: [dx, dy, weight]. Divisor is the weight sum.
const FLOYD_STEINBERG: [number, number, number][] = [
  [1, 0, 7],
  [-1, 1, 3],
  [0, 1, 5],
  [1, 1, 1],
];

// Atkinson deliberately diffuses only 6/8 of the error, which loses some
// shadow detail but keeps contrast crisp - the classic early-Mac look, and it
// suits e-paper for the same reason.
const ATKINSON: [number, number, number][] = [
  [1, 0, 1],
  [2, 0, 1],
  [-1, 1, 1],
  [0, 1, 1],
  [1, 1, 1],
  [0, 2, 1],
];
const ATKINSON_DIVISOR = 8;

const SIERRA_LITE: [number, number, number][] = [
  [1, 0, 2],
  [-1, 1, 1],
  [0, 1, 1],
];

// Perceptual luminance, with any transparency composited over white - the
// panel's background is white, so that is what a transparent pixel becomes.
//
// `bias` shifts every sample before thresholding: positive lightens, negative
// darkens. Biasing the image rather than the threshold means one control
// works identically for the ordered matrices and the error-diffusion kernels,
// and for diffusion it also feeds the shifted value into the propagated
// error, which is what keeps the result looking exposed rather than clipped.
// It is not clamped here: an out-of-range intermediate is fine, since every
// algorithm ends by writing a hard 0 or 255.
function toGray(data: Uint8ClampedArray, width: number, height: number, bias: number): Float32Array {
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; p < gray.length; i += 4, p += 1) {
    const alpha = data[i + 3]! / 255;
    const r = data[i]! * alpha + 255 * (1 - alpha);
    const g = data[i + 1]! * alpha + 255 * (1 - alpha);
    const b = data[i + 2]! * alpha + 255 * (1 - alpha);
    gray[p] = 0.299 * r + 0.587 * g + 0.114 * b + bias;
  }
  return gray;
}

function writeBack(data: Uint8ClampedArray, gray: Float32Array): void {
  for (let i = 0, p = 0; p < gray.length; i += 4, p += 1) {
    const value = gray[p]!;
    data[i] = value;
    data[i + 1] = value;
    data[i + 2] = value;
    data[i + 3] = 255;
  }
}

function ordered(gray: Float32Array, width: number, height: number, matrix: number[][]): void {
  const size = matrix.length;
  const levels = size * size;
  for (let y = 0; y < height; y += 1) {
    const row = matrix[y % size]!;
    for (let x = 0; x < width; x += 1) {
      // +0.5 centres the matrix around mid-grey so the image keeps its
      // average brightness instead of drifting light or dark.
      const threshold = ((row[x % size]! + 0.5) / levels) * 255;
      const p = y * width + x;
      gray[p] = gray[p]! < threshold ? 0 : 255;
    }
  }
}

function diffuse(
  gray: Float32Array,
  width: number,
  height: number,
  kernel: [number, number, number][],
  divisor: number,
): void {
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      const old = gray[p]!;
      const next = old < 128 ? 0 : 255;
      gray[p] = next;
      const error = old - next;
      if (error === 0) continue;

      for (const [dx, dy, weight] of kernel) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= width || ny >= height) continue;
        const q = ny * width + nx;
        gray[q] = gray[q]! + (error * weight) / divisor;
      }
    }
  }
}

function sum(kernel: [number, number, number][]): number {
  return kernel.reduce((total, [, , weight]) => total + weight, 0);
}

// Dithers an RGBA buffer to pure black and white, in place. `bias` is in
// grey levels: +64 is a stop brighter, -64 a stop darker, 0 leaves the
// image's own tones alone.
export function dither(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  algorithm: TDither,
  bias = 0,
): void {
  if (width <= 0 || height <= 0) return;

  const gray = toGray(data, width, height, bias);

  switch (algorithm) {
    case 'threshold':
      for (let p = 0; p < gray.length; p += 1) gray[p] = gray[p]! < 128 ? 0 : 255;
      break;
    case 'bayer4':
      ordered(gray, width, height, BAYER_4);
      break;
    case 'bayer8':
      ordered(gray, width, height, BAYER_8);
      break;
    case 'halftone':
      ordered(gray, width, height, HALFTONE_8);
      break;
    case 'floyd-steinberg':
      diffuse(gray, width, height, FLOYD_STEINBERG, sum(FLOYD_STEINBERG));
      break;
    case 'atkinson':
      diffuse(gray, width, height, ATKINSON, ATKINSON_DIVISOR);
      break;
    case 'sierra-lite':
      diffuse(gray, width, height, SIERRA_LITE, sum(SIERRA_LITE));
      break;
  }

  writeBack(data, gray);
}
