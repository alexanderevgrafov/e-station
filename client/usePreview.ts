import { useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import type { TStore } from '../src/types.ts';

// The preview is rendered by the server from the *draft*, so it stays exact
// (real fonts, real dithering) without the draft ever being saved. An <img>
// cannot POST, so the PNG comes back as a blob and is wrapped in an object
// URL - which has to be revoked, or every keystroke leaks a few KB.
export function usePreview(store: TStore | null, layout: string | null, delay = 200): {
  url: string | null;
  error: string | null;
} {
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<string | null>(null);

  useEffect(() => {
    if (!store || layout === null) return;

    let cancelled = false;
    // Debounced against the same edits the form debounces, so a burst of
    // typing costs one render rather than one per character.
    const timer = setTimeout(() => {
      api.previewPng(store, layout).then(
        (blob) => {
          if (cancelled) return;
          const next = URL.createObjectURL(blob);
          if (current.current) URL.revokeObjectURL(current.current);
          current.current = next;
          setUrl(next);
          setError(null);
        },
        (caught: unknown) => {
          if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
        },
      );
    }, delay);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [store, layout, delay]);

  useEffect(
    () => () => {
      if (current.current) URL.revokeObjectURL(current.current);
    },
    [],
  );

  return { url, error };
}
