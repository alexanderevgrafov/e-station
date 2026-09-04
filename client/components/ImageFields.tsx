import { useEffect, useRef, useState } from 'react';

import { api } from '../api.ts';
import { RangeField } from './fields.tsx';
import { useDebounced } from '../useDebounced.ts';
import type { StoredImage } from '../api.ts';
import type { TArea, TDither, TImageArea, TMeasure, TSizeAxis, TUnit } from '../../src/types.ts';
import { DITHERS, SIZE_AXES, UNITS } from '../../src/types.ts';

interface Props {
  area: TImageArea;
  onChange: (patch: Partial<TArea>) => Promise<void>;
}

// A number plus its unit, the pair committed together - changing px to % and
// leaving the number alone is almost never what is meant, but committing on
// each half separately would fire two saves and two repaints.
function MeasureField({
  label,
  hint,
  value,
  onCommit,
}: {
  label: string;
  hint?: string;
  value: TMeasure;
  onCommit: (next: TMeasure) => void;
}) {
  const [draft, setDraft] = useState(String(value.value));
  const editing = useRef(false);
  const push = useDebounced(onCommit);

  useEffect(() => {
    if (!editing.current) setDraft(String(value.value));
  }, [value.value]);

  const commit = (unit: TUnit = value.unit) => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value.value));
      return;
    }
    if (parsed !== value.value || unit !== value.unit) onCommit({ value: parsed, unit });
  };

  return (
    <label className="field" title={hint}>
      <span>{label}</span>
      <span className="measure">
        <input
          type="number"
          value={draft}
          onChange={(e) => {
            editing.current = true;
            setDraft(e.target.value);
            const parsed = Number(e.target.value);
            if (e.target.value.trim() !== '' && Number.isFinite(parsed)) push({ value: parsed, unit: value.unit });
          }}
          onBlur={() => {
            editing.current = false;
            commit();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur();
          }}
        />
        <select value={value.unit} onChange={(e) => commit(e.target.value as TUnit)}>
          {UNITS.map((unit) => (
            <option key={unit} value={unit}>
              {unit}
            </option>
          ))}
        </select>
      </span>
    </label>
  );
}

export function ImageFields({ area, onChange }: Props) {
  const [stored, setStored] = useState<StoredImage[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const refreshList = () => {
    api.images().then(setStored, (caught: unknown) =>
      setError(caught instanceof Error ? caught.message : String(caught)),
    );
  };

  useEffect(refreshList, []);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    try {
      const image = await api.uploadImage(file);
      refreshList();
      await onChange({ src: image.id } as Partial<TArea>);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  const current = stored.find((image) => image.id === area.src);

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
            {/* A src whose file has gone missing still lists, so it can be
                seen and changed rather than silently reading as "(none)". */}
            {area.src !== null && !current && <option value={area.src}>{area.src} (missing)</option>}
            {stored.map((image) => (
              <option key={image.id} value={image.id}>
                {image.id} - {image.width}x{image.height}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span>Upload</span>
          <input
            ref={fileInput}
            type="file"
            accept="image/png,image/jpeg"
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
          <img src={api.imageUrl(current.id)} alt="source" />
          <span className="hint">
            Stored at {current.width}x{current.height}, {Math.round(current.bytes / 1024)} KB - downscaled to fit twice
            the panel, aspect preserved.
          </span>
        </div>
      )}

      <div className="fields">
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
          <span>Size axis</span>
          <select
            value={area.sizeAxis}
            onChange={(e) => void onChange({ sizeAxis: e.target.value as TSizeAxis } as Partial<TArea>)}
          >
            {SIZE_AXES.map((axis) => (
              <option key={axis} value={axis}>
                {axis}
              </option>
            ))}
          </select>
        </label>
        <MeasureField
          label="Size"
          hint="The chosen axis only; the other follows the source's aspect ratio. % is relative to the area."
          value={area.size}
          onCommit={(size) => void onChange({ size } as Partial<TArea>)}
        />
      </div>

      <div className="fields">
        <label className="field wide">
          <span>Dithering</span>
          <select
            value={area.dither}
            onChange={(e) => void onChange({ dither: e.target.value as TDither } as Partial<TArea>)}
          >
            {DITHERS.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <RangeField
          label="Bias"
          min={-128}
          max={128}
          hint="Shifts the image's tones before dithering: positive lightens, negative darkens. Photos usually need a nudge to land well on e-paper."
          value={area.bias}
          onCommit={(bias) => void onChange({ bias } as Partial<TArea>)}
        />
      </div>
      <p className="hint">
        <strong>threshold</strong> is a hard 50% cut - crisp for line art, blocky for photos.{' '}
        <strong>bayer4/8</strong> spread the dots into a fine crosshatch. <strong>halftone</strong> clusters them into
        round dots, like a printed screen. <strong>floyd-steinberg</strong> gives the most detail,{' '}
        <strong>atkinson</strong> trades some shadow detail for contrast, <strong>sierra-lite</strong> sits between the
        two and is the cheapest of the three.
      </p>

      {error && <p className="error">{error}</p>}
    </>
  );
}
