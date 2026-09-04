import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '../api.ts';
import { byZ, normalizeGeometry, X_ALIGN } from '../../src/area.ts';
import type { Rect } from '../../src/area.ts';
import type { TArea, TAreaType, TGlobal, TLayout } from '../../src/types.ts';
import { AREA_TYPES } from '../../src/types.ts';

interface Props {
  layoutName: string;
  layout: TLayout;
  global: TGlobal;
  version: number; // bumped on every save, to bust the preview PNG cache
  selected: string | null;
  onSelect: (name: string | null) => void;
  onMove: (name: string, rect: Rect) => Promise<void>;
  onCreate: (name: string, type: TAreaType) => Promise<void>;
}

type DragKind = 'move' | 'resize';

interface Drag {
  kind: DragKind;
  name: string;
  startX: number;
  startY: number;
  origin: Rect;
}

export function ScreenCanvas({
  layoutName,
  layout,
  global,
  version,
  selected,
  onSelect,
  onMove,
  onCreate,
}: Props) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  // Geometry being dragged, shown instead of the stored value so the box
  // tracks the pointer without a round-trip per frame.
  const [ghost, setGhost] = useState<Record<string, Rect>>({});
  const [draft, setDraft] = useState('');
  const [draftType, setDraftType] = useState<TAreaType>('text');
  const [error, setError] = useState<string | null>(null);

  const rectOf = (name: string, area: TArea): Rect => ghost[name] ?? { x: area.x, y: area.y, w: area.w, h: area.h };

  const beginDrag = (event: React.PointerEvent, kind: DragKind, name: string, area: TArea) => {
    event.preventDefault();
    event.stopPropagation();
    onSelect(name);
    setDrag({ kind, name, startX: event.clientX, startY: event.clientY, origin: { x: area.x, y: area.y, w: area.w, h: area.h } });
  };

  // Pointer move/up live on window, not the box: a fast drag outruns the
  // element and would otherwise drop the gesture the moment the cursor left.
  useEffect(() => {
    if (!drag) return;

    const onPointerMove = (event: PointerEvent) => {
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      const proposed: Rect =
        drag.kind === 'move'
          ? { ...drag.origin, x: drag.origin.x + dx, y: drag.origin.y + dy }
          : { ...drag.origin, w: drag.origin.w + dx, h: drag.origin.h + dy };
      // Same clamping and byte-column snapping the server applies, so the box
      // never shows a position the store would refuse.
      setGhost((current) => ({ ...current, [drag.name]: normalizeGeometry(proposed, global) }));
    };

    const onPointerUp = () => {
      const finalRect = ghost[drag.name];
      setDrag(null);
      if (!finalRect) return;
      onMove(drag.name, finalRect)
        .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : String(caught)))
        .finally(() =>
          setGhost((current) => {
            const next = { ...current };
            delete next[drag.name];
            return next;
          }),
        );
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
    };
  }, [drag, ghost, global, onMove]);

  const handleCreate = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const name = draft.trim();
      if (name === '') return;
      setError(null);
      try {
        await onCreate(name, draftType);
        setDraft('');
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [draft, draftType, onCreate],
  );

  return (
    <section className="panel">
      <div
        ref={surfaceRef}
        className="screen-frame"
        style={{ width: global.screenWidth, height: global.screenHeight }}
        onPointerDown={() => onSelect(null)}
      >
        <img
          className="screen-render"
          src={api.previewUrl(layoutName, version)}
          alt="panel render"
          draggable={false}
        />

        {byZ(layout.areas).map(([name, area]) => {
          const rect = rectOf(name, area);
          const isSelected = name === selected;
          return (
            <div
              key={name}
              className={isSelected ? 'area-box selected' : 'area-box'}
              style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: area.z }}
              onPointerDown={(event) => beginDrag(event, 'move', name, area)}
            >
              <span className="area-tag">
                {name} <em>z{area.z}</em>
              </span>
              {isSelected && (
                <span
                  className="area-handle"
                  onPointerDown={(event) => beginDrag(event, 'resize', name, area)}
                  title="Resize"
                />
              )}
            </div>
          );
        })}
      </div>

      <form className="row" onSubmit={handleCreate}>
        <input value={draft} placeholder="New area name" onChange={(e) => setDraft(e.target.value)} />
        <select value={draftType} onChange={(e) => setDraftType(e.target.value as TAreaType)}>
          {AREA_TYPES.map((type) => (
            <option key={type} value={type}>
              {type}
            </option>
          ))}
        </select>
        <button type="submit" disabled={draft.trim() === ''}>
          Add area
        </button>
        <span className="hint">x and width snap to {X_ALIGN}px byte columns</span>
      </form>
      {error && <p className="error">{error}</p>}
    </section>
  );
}
