import { useEffect, useState } from 'react';
import { api } from './api.ts';
import type { FontFamilyInfo } from './api.ts';

// Pulls the list of fonts the panel can actually render, and injects an
// @font-face for each face so the editor's live boxes draw text in the same
// family the panel will use. Without this the preview would silently
// substitute a browser font and every position would be measured against the
// wrong glyph widths.
let injected = false;

function injectFaces(families: FontFamilyInfo[]): void {
  if (injected) return;
  injected = true;

  const css = families
    .flatMap((family) =>
      family.faces.map(
        (face) =>
          `@font-face{font-family:"${family.family}";font-weight:${face.weight};font-style:${face.style};` +
          `src:url("${api.fontFileUrl(face.id)}");font-display:swap}`,
      ),
    )
    .join('\n');

  const style = document.createElement('style');
  style.dataset['estationFonts'] = 'true';
  style.textContent = css;
  document.head.appendChild(style);
}

export function useFonts(): { fonts: FontFamilyInfo[]; error: string | null } {
  const [fonts, setFonts] = useState<FontFamilyInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.fonts().then(
      (families) => {
        setFonts(families);
        injectFaces(families);
      },
      (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)),
    );
  }, []);

  return { fonts, error };
}
