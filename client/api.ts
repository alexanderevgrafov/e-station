import type { TArea, TAreaType, TGlobal, TJsonObject, TStore } from '../src/types.ts';

type ApiResponse =
  | { success: true; store: TStore; currentLayout: string | null }
  | { success: false; message: string };

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

// Every editor endpoint answers with the whole document, so each call here
// resolves to the new state and the caller just replaces what it had.
async function request(path: string, init?: RequestInit): Promise<TStore> {
  const response = await fetch(`/api/editor${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });

  let payload: ApiResponse;
  try {
    payload = (await response.json()) as ApiResponse;
  } catch {
    throw new Error(`${response.status} ${response.statusText}`);
  }

  if (!payload.success) throw new Error(payload.message);
  return payload.store;
}

function send(path: string, method: string, body: unknown): Promise<TStore> {
  return request(path, { method, body: JSON.stringify(body) });
}

const encode = encodeURIComponent;

const layoutPath = (layout: string) => `/layouts/${encode(layout)}`;
const areaPath = (layout: string, area: string) => `${layoutPath(layout)}/areas/${encode(area)}`;

export const api = {
  load: (): Promise<TStore> => request('/store'),

  setGlobal: (global: TGlobal): Promise<TStore> => send('/global', 'PUT', { global }),

  setGlobalSettings: (settings: TJsonObject): Promise<TStore> => send('/settings', 'PUT', { settings }),

  createLayout: (name: string): Promise<TStore> => send('/layouts', 'POST', { name }),

  setLayoutSettings: (name: string, settings: TJsonObject): Promise<TStore> =>
    send(`${layoutPath(name)}/settings`, 'PUT', { settings }),

  renameLayout: (from: string, to: string): Promise<TStore> => send(`${layoutPath(from)}/rename`, 'POST', { name: to }),

  deleteLayout: (name: string): Promise<TStore> => request(layoutPath(name), { method: 'DELETE' }),

  createArea: (layout: string, name: string, type: TAreaType): Promise<TStore> =>
    send(`${layoutPath(layout)}/areas`, 'POST', { name, type }),

  // Partial patch: only the fields given are changed. z and overlaps are
  // ignored server-side - the first moves only via bringAreaToFront, the
  // second is derived from geometry.
  updateArea: (layout: string, name: string, area: Partial<TArea>): Promise<TStore> =>
    send(areaPath(layout, name), 'PUT', { area }),

  renameArea: (layout: string, from: string, to: string): Promise<TStore> =>
    send(`${areaPath(layout, from)}/rename`, 'POST', { name: to }),

  bringAreaToFront: (layout: string, name: string): Promise<TStore> =>
    send(`${areaPath(layout, name)}/front`, 'POST', {}),

  // Omit `to` to let the server auto-name it ("hours" -> "hours 2").
  cloneArea: (layout: string, name: string, to?: string): Promise<TStore> =>
    send(`${areaPath(layout, name)}/clone`, 'POST', to === undefined ? {} : { name: to }),

  deleteArea: (layout: string, name: string): Promise<TStore> => request(areaPath(layout, name), { method: 'DELETE' }),

  // The only call that touches the panel. Editor saves are deliberately
  // screen-independent; this is the whole-panel clear and redraw.
  sync: async (): Promise<void> => {
    const response = await fetch('/api/editor/sync', { method: 'POST' });
    const payload = (await response.json()) as { success: boolean; message?: string };
    if (!payload.success) throw new Error(payload.message ?? `sync failed: ${response.status}`);
  },

  fonts: async (): Promise<FontFamilyInfo[]> => {
    const response = await fetch('/api/editor/fonts');
    const payload = (await response.json()) as { success: boolean; fonts?: FontFamilyInfo[]; message?: string };
    if (!payload.success || !payload.fonts) throw new Error(payload.message ?? 'could not list fonts');
    return payload.fonts;
  },

  // Cache-busted by the caller's version counter: the PNG is regenerated on
  // every edit and must never be served from cache.
  previewUrl: (layout: string, version: number): string =>
    `/api/editor${layoutPath(layout)}/preview.png?v=${version}`,

  fontFileUrl: (id: string): string => `/api/editor/fonts/${encode(id)}/file`,

  // Sent as a raw body with the file's own Content-Type - no multipart, so
  // the server needs no form parser.
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
};
