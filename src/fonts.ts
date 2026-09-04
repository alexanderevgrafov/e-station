import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { registerFont } from 'canvas';
import * as fontkit from 'fontkit';

// Font discovery. node-canvas's registerFont needs the family name handed to
// it - it will not read one out of the file - so every candidate is opened
// with fontkit to get its real family and subfamily first. That is also what
// lets the editor offer a font list instead of a free-text box.

export interface FontFace {
  id: string; // stable, URL-safe: what the editor asks for to fetch the file
  file: string;
  family: string;
  weight: string; // 'normal' | 'bold' | a numeric weight class
  style: 'normal' | 'italic';
}

export interface FontFamily {
  family: string;
  weights: string[];
  faces: FontFace[];
}

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc']);
const MAX_SCAN_DEPTH = 4;

function defaultFontDirs(): string[] {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return ['/System/Library/Fonts', '/Library/Fonts', path.join(home, 'Library', 'Fonts')];
  }
  return [path.join(home, '.fonts'), '/usr/share/fonts', '/usr/local/share/fonts'];
}

export function fontDirs(): string[] {
  const configured = process.env['ESTATION_FONT_DIRS'];
  return configured ? configured.split(':').filter(Boolean) : defaultFontDirs();
}

async function walk(dir: string, depth = 0): Promise<string[]> {
  if (depth > MAX_SCAN_DEPTH) return [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return []; // a configured directory that doesn't exist is not an error
  }

  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(full, depth + 1)));
    else if (FONT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) found.push(full);
  }
  return found;
}

// fontkit types a .ttc as a collection rather than a single font, so both
// shapes have to be handled.
function facesOf(opened: fontkit.Font | fontkit.FontCollection): fontkit.Font[] {
  return 'fonts' in opened ? [...opened.fonts] : [opened];
}

function weightOf(font: fontkit.Font): string {
  const os2 = (font as unknown as { 'OS/2'?: { usWeightClass?: number } })['OS/2'];
  const value = os2?.usWeightClass;
  if (typeof value !== 'number' || value <= 0) return 'normal';
  if (value === 400) return 'normal';
  if (value === 700) return 'bold';
  return String(value);
}

function idFor(file: string, index: number): string {
  return `${path.basename(file, path.extname(file))}-${index}`.replace(/[^A-Za-z0-9_-]/g, '_');
}

let cache: FontFamily[] | null = null;

// Registration is global to node-canvas and cannot be undone, so this runs
// once per process and the result is cached. Call it before rendering
// anything - src/panel.ts does that at startup.
export async function loadFonts(): Promise<FontFamily[]> {
  if (cache) return cache;

  const byFamily = new Map<string, FontFace[]>();
  const seen = new Set<string>();

  for (const dir of fontDirs()) {
    for (const file of await walk(dir)) {
      if (seen.has(file)) continue;
      seen.add(file);

      let opened;
      try {
        opened = await fontkit.open(file);
      } catch {
        continue; // unreadable or unsupported font - skip it, don't fail the scan
      }

      facesOf(opened).forEach((font, index) => {
        const family = font.familyName;
        if (!family) return;

        const subfamily = (font.subfamilyName ?? '').toLowerCase();
        const face: FontFace = {
          id: idFor(file, index),
          file,
          family,
          weight: weightOf(font),
          style: subfamily.includes('italic') || subfamily.includes('oblique') ? 'italic' : 'normal',
        };

        try {
          registerFont(face.file, { family: face.family, weight: face.weight, style: face.style });
        } catch {
          return; // node-canvas refused it; don't offer a font that cannot render
        }

        const list = byFamily.get(family) ?? [];
        list.push(face);
        byFamily.set(family, list);
      });
    }
  }

  cache = [...byFamily.entries()]
    .map(([family, faces]) => ({
      family,
      weights: [...new Set(faces.map((f) => f.weight))].sort(),
      faces,
    }))
    .sort((a, b) => a.family.localeCompare(b.family));

  return cache;
}

export async function findFace(id: string): Promise<FontFace | null> {
  const families = await loadFonts();
  for (const family of families) {
    const face = family.faces.find((f) => f.id === id);
    if (face) return face;
  }
  return null;
}
