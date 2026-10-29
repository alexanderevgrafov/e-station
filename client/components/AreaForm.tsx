import { useEffect, useState } from 'react';

import type { FontFamilyInfo } from '../api.ts';
import { FractalFields } from './FractalFields.tsx';
import { ImageFields } from './ImageFields.tsx';
import { NumberField, TextField } from './fields.tsx';
import { TokenChips } from './VariablesPanel.tsx';
import { expandTokens, hasTokens, tokenNames } from '../../src/variables.ts';
import type { TVariables } from '../../src/variables.ts';
import type { TArea, TAreaType, TFractalArea, TImageArea, TTextArea } from '../../src/types.ts';
import { AREA_TYPES, BACKDROPS, H_ALIGNS } from '../../src/types.ts';

interface Props {
  name: string;
  area: TArea;
  existing: string[];
  fonts: FontFamilyInfo[];
  // What placeholders expand to here - the live pool, with sample sensor
  // values while no sensor has answered.
  variables: TVariables;
  onChange: (patch: Partial<TArea>) => Promise<void>;
  onRename: (to: string) => Promise<void>;
  onBringToFront: () => Promise<void>;
  onClone: () => Promise<void>;
  onDelete: () => Promise<void>;
}

export function AreaForm({ name, area, existing, fonts, variables, onChange, onRename, onBringToFront, onClone, onDelete }: Props) {
  const [nameDraft, setNameDraft] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    setNameDraft(name);
    setError(null);
    setConfirming(false);
  }, [name]);

  const run = (action: () => Promise<void>) => {
    setError(null);
    action().catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)));
  };

  const patch = (fields: Partial<TArea>) => run(() => onChange(fields));

  const trimmed = nameDraft.trim();
  const canRename = trimmed !== '' && trimmed !== name && !existing.includes(trimmed);

  const text = area.type === 'text' ? (area as TTextArea) : null;
  const family = fonts.find((f) => f.family === text?.font);
  const weights = family?.weights ?? ['normal', 'bold'];
  const unset = text ? tokenNames(text.text).filter((n) => !Object.hasOwn(variables, n)) : [];

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Area</h2>
        <span className="badge">{area.type}</span>
        <span className="badge">z {area.z}</span>
      </header>

      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          if (canRename) run(() => onRename(trimmed));
        }}
      >
        <input className="name-input" value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} />
        <button type="submit" disabled={!canRename}>
          Rename
        </button>
        <button type="button" className="ghost" onClick={() => run(onClone)}>
          Clone
        </button>
        <button type="button" className="ghost" onClick={() => run(onBringToFront)}>
          Bring to front
        </button>
        {confirming ? (
          <>
            <span className="hint">Delete &ldquo;{name}&rdquo;?</span>
            <button type="button" className="danger" onClick={() => run(onDelete)}>
              Confirm
            </button>
            <button type="button" className="ghost" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="danger ghost" onClick={() => setConfirming(true)}>
            Delete
          </button>
        )}
      </form>

      <div className="fields">
        <label className="field">
          <span>Type</span>
          <select value={area.type} onChange={(e) => patch({ type: e.target.value as TAreaType })}>
            {AREA_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Enabled</span>
          <input type="checkbox" checked={area.enabled} onChange={(e) => patch({ enabled: e.target.checked })} />
        </label>
      </div>
      <p className="hint">
        Changing the type keeps the geometry (and dither/bias where both types have them); settings the new type does
        not use are dropped. A disabled area is not drawn on the panel.
      </p>

      <div className="fields">
        <NumberField label="x" value={area.x} step={8} onCommit={(x) => patch({ x })} />
        <NumberField label="y" value={area.y} onCommit={(y) => patch({ y })} />
        <NumberField label="width" value={area.w} step={8} onCommit={(w) => patch({ w })} />
        <NumberField label="height" value={area.h} onCommit={(h) => patch({ h })} />
      </div>
      <p className="hint">x and width snap to multiples of 8 - the panel addresses its refresh window in byte columns.</p>

      {text && (
        <>
          <div className="fields">
            <TextField label="Text" value={text.text} onCommit={(value) => patch({ text: value } as Partial<TArea>)} />
          </div>
          <p className="hint">
            Variables:{' '}
            <TokenChips
              names={Object.keys(variables)}
              onInsert={(token) => patch({ text: text.text + token } as Partial<TArea>)}
            />
            {hasTokens(text.text) && (
              <>
                {' '}
                Shows <code>{expandTokens(text.text, variables)}</code> now.
              </>
            )}
            {unset.length > 0 && (
              <>
                {' '}
                Not set yet: {unset.map((n) => <code key={n}>{`{${n}}`}</code>)} - shown as typed until{' '}
                <code>/intake?{unset[0]}=...</code> sets it.
              </>
            )}
          </p>
          <div className="fields">
            <label className="field">
              <span>Font</span>
              <select
                value={text.font}
                onChange={(e) => patch({ font: e.target.value } as Partial<TArea>)}
              >
                {/* The stored family may not exist on this machine's scan -
                    keep it listed rather than silently switching it. */}
                {!fonts.some((f) => f.family === text.font) && <option value={text.font}>{text.font} (missing)</option>}
                {fonts.map((f) => (
                  <option key={f.family} value={f.family}>
                    {f.family}
                  </option>
                ))}
              </select>
            </label>
            <NumberField label="Size" value={text.fontSize} onCommit={(fontSize) => patch({ fontSize } as Partial<TArea>)} />
            <label className="field">
              <span>Weight</span>
              <select value={text.fontWeight} onChange={(e) => patch({ fontWeight: e.target.value } as Partial<TArea>)}>
                {!weights.includes(text.fontWeight) && <option value={text.fontWeight}>{text.fontWeight}</option>}
                {weights.map((weight) => (
                  <option key={weight} value={weight}>
                    {weight}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Align</span>
              <select value={text.align} onChange={(e) => patch({ align: e.target.value } as Partial<TArea>)}>
                {H_ALIGNS.map((align) => (
                  <option key={align} value={align}>
                    {align}
                  </option>
                ))}
              </select>
            </label>
            {text.align !== 'center' && (
              <NumberField
                label={`Padding ${text.align} px`}
                value={text.padding}
                onCommit={(padding) => patch({ padding } as Partial<TArea>)}
              />
            )}
          </div>
          <div className="fields">
            <label className="field">
              <span>Backdrop</span>
              <select value={text.backdrop} onChange={(e) => patch({ backdrop: e.target.value } as Partial<TArea>)}>
                {BACKDROPS.map((backdrop) => (
                  <option key={backdrop} value={backdrop}>
                    {backdrop}
                  </option>
                ))}
              </select>
            </label>
            {text.backdrop === 'halo' && (
              <NumberField label="Halo px" value={text.haloRadius} onCommit={(haloRadius) => patch({ haloRadius } as Partial<TArea>)} />
            )}
          </div>
          {text.backdrop === 'halo' && (
            <p className="hint">
              Halo keeps the layers below and outlines the text in white. It is clipped to this area, and repainting it
              also repaints the areas below it.
            </p>
          )}
        </>
      )}

      {area.type === 'image' && <ImageFields area={area as TImageArea} onChange={onChange} />}

      {area.type === 'fractal' && <FractalFields area={area as TFractalArea} onChange={onChange} />}

      {area.type === 'svg' && <p className="hint">SVG is deliberately unimplemented for now.</p>}

      {area.overlapped.length > 0 && (
        <p className="hint">
          Overlapped by <strong>{area.overlapped.join(', ')}</strong> - repainting this area is followed by repainting
          those, since they sit above it.
        </p>
      )}

      {error && <p className="error">{error}</p>}
    </section>
  );
}
