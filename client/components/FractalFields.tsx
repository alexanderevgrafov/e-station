import { NumberField, RangeField } from './fields.tsx';
import type { TArea, TDither, TFractalArea, TFractalKind } from '../../src/types.ts';
import { DITHERS, FRACTAL_KINDS } from '../../src/types.ts';

interface Props {
  area: TFractalArea;
  onChange: (patch: Partial<TArea>) => Promise<void>;
}

export function FractalFields({ area, onChange }: Props) {
  return (
    <>
      <div className="fields">
        <label className="field">
          <span>Kind</span>
          <select
            value={area.kind}
            onChange={(e) => void onChange({ kind: e.target.value as TFractalKind } as Partial<TArea>)}
          >
            {FRACTAL_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
        <NumberField
          label="New art every (min)"
          value={area.intervalMins}
          onCommit={(intervalMins) => void onChange({ intervalMins } as Partial<TArea>)}
        />
        <label className="field">
          <span>Quiet from</span>
          <input
            type="time"
            value={area.quietFrom}
            onChange={(e) => void onChange({ quietFrom: e.target.value } as Partial<TArea>)}
          />
        </label>
        <label className="field">
          <span>Quiet to</span>
          <input
            type="time"
            value={area.quietTo}
            onChange={(e) => void onChange({ quietTo: e.target.value } as Partial<TArea>)}
          />
        </label>
        <NumberField
          label="Max zoom (10^n)"
          step={0.5}
          hint="How deep Mandelbrot views may zoom, as a power of ten. 3.5 is the default. If a view turns out to be featureless (almost no edges to draw) it zooms back out until it is not."
          value={area.maxZoom}
          onCommit={(maxZoom) => void onChange({ maxZoom } as Partial<TArea>)}
        />
        <RangeField
          label="Offset X (%)"
          min={-100}
          max={100}
          hint="Shifts the view sideways from the position the clock-seeded picture lands on, in % of the view width. 100 = one full screen to the right."
          value={area.offsetX}
          onCommit={(offsetX) => void onChange({ offsetX } as Partial<TArea>)}
        />
        <RangeField
          label="Offset Y (%)"
          min={-100}
          max={100}
          hint="Shifts the view vertically from the position the clock-seeded picture lands on, in % of the view height. 100 = one full screen down."
          value={area.offsetY}
          onCommit={(offsetY) => void onChange({ offsetY } as Partial<TArea>)}
        />
      </div>

      <div className="fields">
        <RangeField
          label="Outer white"
          min={0}
          max={100}
          hint="How gradually the pattern fades to white with distance from the set. 0 keeps the banding everywhere; 100 leaves ink only near the set's edge."
          value={area.outerWhite}
          onCommit={(outerWhite) => void onChange({ outerWhite } as Partial<TArea>)}
        />
        <RangeField
          label="White cutoff"
          min={0}
          max={100}
          hint="Escape speed past which everything is plain white. The body of the set is black, the ribbons sit just outside it, and anything escaping faster than the cutoff is white. 0 = no cutoff; higher = ribbons only hug the body."
          value={area.whiteCutoff}
          onCommit={(whiteCutoff) => void onChange({ whiteCutoff } as Partial<TArea>)}
        />
        <label className="field">
          <span>Negative</span>
          <input
            type="checkbox"
            checked={area.negative}
            onChange={(e) => void onChange({ negative: e.target.checked } as Partial<TArea>)}
          />
        </label>
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
          hint="Shifts the tones before dithering: positive lightens, negative darkens."
          value={area.bias}
          onCommit={(bias) => void onChange({ bias } as Partial<TArea>)}
        />
      </div>

      <p className="hint">
        The area repaints with a new fractal every {area.intervalMins > 0 ? `${area.intervalMins} min` : '- (timer off)'}
        ; 0 turns the timer off. No new picture is rolled between the quiet times
        (server clock; e.g. 23:00 to 05:00 spans midnight). The picture is seeded from the clock: the preview and Sync &amp; Save show the one made when the server started, and the timer then rolls a new one.
        Set one on the live panel with <code>/intake/&lt;area&gt;?seed=42</code>.
      </p>
    </>
  );
}
