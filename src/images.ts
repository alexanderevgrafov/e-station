import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { createCanvas, loadImage } from 'canvas';
import type { Image } from 'canvas';

import { DATA_DIR, StoreError } from './store.ts';
import type { TGlobal, TLayout } from './types.ts';

// Uploaded images: stored once, resized once, then reused. Lives under data/
// with the layouts document, so it is equally excluded from the deploy rsync
// and equally survives a redeploy.
export const IMAGE_DIR = path.join(DATA_DIR, 'images');

export interface StoredImage {
  id: string;
  width: number;
  height: number;
  bytes: number;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

function looksLikeImage(buffer: Buffer): boolean {
  return buffer.subarray(0, 4).equals(PNG_MAGIC) || buffer.subarray(0, 3).equals(JPEG_MAGIC);
}

function fileFor(id: string): string {
  return path.join(IMAGE_DIR, `${id}.png`);
}

// Ids are a hash of the *original* bytes, so re-uploading the same picture
// reuses the stored copy instead of accumulating duplicates.
function idFor(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

export function isValidImageId(id: string): boolean {
  return /^[0-9a-f]{16}$/.test(id);
}

// Stored at twice the panel's dimensions: enough to stay sharp when an area
// scales it up a little or the panel is replaced with a denser one, without
// keeping a 12-megapixel phone photo on a Pi Zero's SD card. Aspect ratio is
// preserved, and an image already smaller than the box is left alone -
// upscaling on the way in would only waste space, since the renderer can
// scale up just as well at draw time.
export async function saveUpload(buffer: Buffer, global: TGlobal): Promise<StoredImage> {
  if (buffer.length === 0) throw new StoreError('empty upload');
  if (!looksLikeImage(buffer)) throw new StoreError('upload must be a PNG or JPEG');

  const id = idFor(buffer);
  const target = fileFor(id);

  const existing = await stat(id);
  if (existing) return existing;

  let source: Image;
  try {
    source = await loadImage(buffer);
  } catch (error) {
    throw new StoreError(`could not decode image: ${error instanceof Error ? error.message : String(error)}`);
  }

  const maxW = global.screenWidth * 2;
  const maxH = global.screenHeight * 2;
  const scale = Math.min(1, maxW / source.width, maxH / source.height);
  const width = Math.max(1, Math.round(source.width * scale));
  const height = Math.max(1, Math.round(source.height * scale));

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(source, 0, 0, width, height);

  await fs.mkdir(IMAGE_DIR, { recursive: true });
  await fs.writeFile(target, canvas.toBuffer('image/png'));

  const saved = { id, width, height, bytes: (await fs.stat(target)).size };
  cache.delete(id); // in case a previous load cached a miss
  return saved;
}

async function stat(id: string): Promise<StoredImage | null> {
  try {
    const info = await fs.stat(fileFor(id));
    const image = await load(id);
    return image ? { id, width: image.width, height: image.height, bytes: info.size } : null;
  } catch {
    return null;
  }
}

export async function list(): Promise<StoredImage[]> {
  let names: string[];
  try {
    names = await fs.readdir(IMAGE_DIR);
  } catch {
    return [];
  }

  const ids = names.filter((name) => name.endsWith('.png')).map((name) => path.basename(name, '.png'));
  const found = await Promise.all(ids.filter(isValidImageId).map(stat));
  return found.filter((image): image is StoredImage => image !== null);
}

export async function remove(id: string): Promise<void> {
  if (!isValidImageId(id)) throw new StoreError('bad image id');
  cache.delete(id);
  try {
    await fs.unlink(fileFor(id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new StoreError('no such image', 404);
    throw error;
  }
}

export function pathFor(id: string): string | null {
  return isValidImageId(id) ? fileFor(id) : null;
}

// Decoded images, kept in memory. A layout redraws on every /intake that
// changes something, and decoding a PNG per repaint on a Pi Zero is exactly
// the sort of thing that turns a 2-second refresh into a 5-second one.
const cache = new Map<string, Image | null>();

export async function load(id: string): Promise<Image | null> {
  if (!isValidImageId(id)) return null;
  const cached = cache.get(id);
  if (cached !== undefined) return cached;

  try {
    const image = await loadImage(fileFor(id));
    cache.set(id, image);
    return image;
  } catch {
    // A missing or corrupt file caches as a miss so the renderer falls back
    // to the placeholder without retrying the decode on every frame.
    cache.set(id, null);
    return null;
  }
}

export type ImageBank = Map<string, Image>;

// Rendering is synchronous - decoding is not. Everything a layout needs is
// warmed here first, then handed to drawLayout as a plain map.
export async function preload(layout: TLayout): Promise<ImageBank> {
  const bank: ImageBank = new Map();
  const ids = Object.values(layout.areas)
    .filter((area) => area.type === 'image')
    .map((area) => (area.type === 'image' ? area.src : null))
    .filter((src): src is string => typeof src === 'string' && src !== '');

  await Promise.all(
    [...new Set(ids)].map(async (id) => {
      const image = await load(id);
      if (image) bank.set(id, image);
    }),
  );

  return bank;
}
