import type { TGlobal, TStore } from '../src/types.ts';
import type { TReadings } from '../src/readings.ts';

export interface StoredImage {
  id: string;
  width: number;
  height: number;
  bytes: number;
}

export interface FontFamilyInfo {
  family: string;
  weights: string[];
  faces: { id: string; weight: string; style: 'normal' | 'italic' }[];
}

export interface SensorInfo {
  readings: TReadings;
  // 'ok ...', or why that sensor is not producing readings.
  status: { aht20: string; bmp280: string };
  pollSecs: number;
}

type StoreResponse =
  | { success: true; store: TStore; warning?: string }
  | { success: false; message: string };

export interface SaveResult {
  store: TStore;
  // Set when the document was saved but the panel could not be repainted.
  warning?: string;
}

// The editor edits a local draft (see src/document.ts) and only talks to the
// server for: loading, Sync&Save, rendering a preview of the draft, images,
// and fonts. There is deliberately no per-field write endpoint - that is what
// used to let an edit in progress reach the panel via the next /intake.
async function storeCall(path: string, init?: RequestInit): Promise<TStore> {
  const response = await fetch(`/api/editor${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });

  let payload: StoreResponse;
  try {
    payload = (await response.json()) as StoreResponse;
  } catch {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  if (!payload.success) throw new Error(payload.message);
  return payload.store;
}

const encode = encodeURIComponent;

export const api = {
  load: (): Promise<TStore> => storeCall('/store'),

  // Persists the whole document, then full-clears and redraws the panel. A
  // save that succeeds but cannot reach the panel comes back with a warning
  // rather than an error - the document really is on disk.
  syncAndSave: async (store: TStore): Promise<SaveResult> => {
    const response = await fetch('/api/editor/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store }),
    });
    const payload = (await response.json()) as StoreResponse;
    if (!payload.success) throw new Error(payload.message);
    return { store: payload.store, ...(payload.warning !== undefined && { warning: payload.warning }) };
  },

  // Renders the draft without saving it. Returns the PNG bytes, because an
  // <img src> cannot POST - the caller wraps it in an object URL.
  previewPng: async (store: TStore, layout: string): Promise<Blob> => {
    const response = await fetch('/api/editor/preview.png', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ store, layout }),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => null)) as { message?: string } | null;
      throw new Error(payload?.message ?? `preview failed: ${response.status}`);
    }
    return response.blob();
  },

  fonts: async (): Promise<FontFamilyInfo[]> => {
    const response = await fetch('/api/editor/fonts');
    const payload = (await response.json()) as { success: boolean; fonts?: FontFamilyInfo[]; message?: string };
    if (!payload.success || !payload.fonts) throw new Error(payload.message ?? 'could not list fonts');
    return payload.fonts;
  },

  fontFileUrl: (id: string): string => `/api/editor/fonts/${encode(id)}/file`,

  // Images are content rather than layout, so they upload straight away; the
  // area's `src` pointing at one is what stays in the draft.
  uploadImage: async (file: File): Promise<StoredImage> => {
    const response = await fetch('/api/editor/images', {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: file,
    });
    const payload = (await response.json()) as { success: boolean; image?: StoredImage; message?: string };
    if (!payload.success || !payload.image) throw new Error(payload.message ?? `upload failed: ${response.status}`);
    return payload.image;
  },

  images: async (): Promise<StoredImage[]> => {
    const response = await fetch('/api/editor/images');
    const payload = (await response.json()) as { success: boolean; images?: StoredImage[]; message?: string };
    if (!payload.success || !payload.images) throw new Error(payload.message ?? 'could not list images');
    return payload.images;
  },

  imageUrl: (id: string): string => `/api/editor/images/${encode(id)}`,

  sensors: async (): Promise<SensorInfo> => {
    const response = await fetch('/api/editor/sensors');
    const payload = (await response.json()) as ({ success: true } & SensorInfo) | { success: false; message: string };
    if (!payload.success) throw new Error(payload.message);
    return { readings: payload.readings, status: payload.status, pollSecs: payload.pollSecs };
  },
};

export type { TGlobal };
