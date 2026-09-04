import type { TJsonObject, TSettings } from './types.ts';

// Pure, dependency-free, and shared with the browser: the editor previews
// the merged result, so the preview and what the server stores have to come
// from the same code. Nothing here may import node builtins.

export function isPlainObject(value: unknown): value is TJsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Deep merge, override winning. Nested objects merge key by key so a layout
// can override one field inside a block without restating the block; arrays
// and scalars replace wholesale, because a partially-overridden array is
// never what anyone means by "override this list".
export function deepMerge(base: TJsonObject, override: TJsonObject): TJsonObject {
  const out: TJsonObject = { ...base };

  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    out[key] = isPlainObject(existing) && isPlainObject(value) ? deepMerge(existing, value) : value;
  }

  return out;
}

// A layout's effective settings: its own, merged over the global defaults.
export function mergeSettings(globalSettings: TSettings, layoutSettings: TSettings): TSettings {
  return deepMerge(globalSettings, layoutSettings);
}
