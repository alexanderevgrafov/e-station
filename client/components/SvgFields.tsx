import { useEffect, useRef, useState } from 'react';

import { api } from '../api.ts';
import { MeasureField } from './ImageFields.tsx';
import type { StoredSvg } from '../api.ts';
import type { TArea, TSvgArea, TSvgFit } from '../../src/types.ts';
import { SVG_FITS } from '../../src/types.ts';

interface Props {
  area: TSvgArea;
  onChange: (patch: Partial<TArea>) => Promise<void>;
}

const FIT_HINTS: Record<TSvgFit, string> = {
  contain: 'Whole drawing visible, aspect kept (CSS contain).',
  cover: 'Box fully covered, aspect kept, the overflow is clipped (CSS cover).',
  stretch: 'Box filled exactly, aspect NOT kept (CSS 100% 100%).',
  natural: "The SVG's own size (CSS auto).",
  width: 'Size sets the width; the height follows the aspect.',
  height: 'Size sets the height; the width follows the aspect.',
};

export function SvgFields({ area, onChange }: Props) {
  const [stored, setStored] = useState<StoredSvg[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refreshList = () => {
    api.svgs().then(setStored, (caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
  };

  useEffect(refreshList, []);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const svg = await api.uploadSvg(file);
      refreshList();
      await onChange({ src: svg.id } as Partial<TArea>);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  const current = stored.find((svg) => svg.id === area.src);
  const usesSize = area.fit === 'width' || area.fit === 'height';

  return (
    <>
      <div className="fields">
        <label className="field wide">
          <span>Source</span>
          <select
            value={area.src ?? ''}
            onChange={(e) => void onChange({ src: e.target.value === '' ? null : e.target.value } as Partial<TArea>)}
          >
            <option value="">(none)</option>
            {area.src !== null && !current && <option value={area.src}>{area.src} (missing)</option>}
            {stored.map((svg) => (
              <option key={svg.id} value={svg.id}>
                {svg.id} - {svg.width}x{svg.height}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Upload</span>
          <input
            ref={fileInput}
            type="file"
            accept="image/svg+xml,.svg"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
          />
        </label>
      </div>

      {current && (
        <div className="image-preview">
          <img src={api.svgUrl(current.id)} alt="source" />
          <span className="hint">
            {current.width}x{current.height}, {Math.round(current.bytes / 1024) || '<1'} KB.
          </span>
        </div>
      )}

      <div className="fields">
        <label className="field">
          <span>Fit</span>
          <select value={area.fit} onChange={(e) => void onChange({ fit: e.target.value as TSvgFit } as Partial<TArea>)}>
            {SVG_FITS.map((fit) => (
              <option key={fit} value={fit} title={FIT_HINTS[fit]}>
                {fit}
              </option>
            ))}
          </select>
        </label>
        {usesSize && (
          <MeasureField
            label={area.fit === 'width' ? 'Width' : 'Height'}
            hint="% is relative to the area."
            value={area.size}
            onCommit={(size) => void onChange({ size } as Partial<TArea>)}
          />
        )}
        <MeasureField
          label="Position X"
          hint="Like CSS background-position: px offsets from the area's left edge; % positions within the leftover space, so 50% centres."
          value={area.posX}
          onCommit={(posX) => void onChange({ posX } as Partial<TArea>)}
        />
        <MeasureField
          label="Position Y"
          hint="Like CSS background-position: px offsets from the area's top edge; % positions within the leftover space, so 50% centres."
          value={area.posY}
          onCommit={(posY) => void onChange({ posY } as Partial<TArea>)}
        />
        <label className="field">
          <span>Flip horizontally</span>
          <input
            type="checkbox"
            checked={area.flipH}
            onChange={(e) => void onChange({ flipH: e.target.checked } as Partial<TArea>)}
          />
        </label>
        <label className="field">
          <span>Flip vertically</span>
          <input
            type="checkbox"
            checked={area.flipV}
            onChange={(e) => void onChange({ flipV: e.target.checked } as Partial<TArea>)}
          />
        </label>
      </div>
      <p className="hint">
        {FIT_HINTS[area.fit]} The background is transparent: only the drawing is painted, light colours as white and
        dark ones as black, with no dithering. Flips mirror the whole box, so a drawing at the left edge moves to the
        right when flipped horizontally.
      </p>

      {error && <p className="error">{error}</p>}
    </>
  );
}
