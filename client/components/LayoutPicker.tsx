import { useEffect, useRef, useState } from 'react';
import { isValidName } from '../../src/types.ts';

interface Props {
  names: string[];
  selected: string | null; // null = the Global page
  onSelect: (name: string | null) => void;
  onCreate: (name: string) => Promise<void>;
}

// The layout list lives in the top bar as a floating menu rather than a fixed
// sidebar: once a layout is picked it collapses, and the whole width goes to
// the preview and the area form.
export function LayoutPicker({ names, selected, onSelect, onCreate }: Props) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // Close on an outside click or Escape, the way any menu should.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = (name: string | null) => {
    onSelect(name);
    setOpen(false);
  };

  const trimmed = draft.trim();
  const canCreate = trimmed !== '' && isValidName(trimmed) && !busy;

  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      await onCreate(trimmed);
      setDraft('');
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="picker" ref={root}>
      <button type="button" className="picker-toggle" onClick={() => setOpen((v) => !v)}>
        <span className="picker-label">{selected ?? 'Global'}</span>
        <span className="caret">{open ? '▴' : '▾'}</span>
      </button>

      {open && (
        <div className="picker-menu">
          <button
            type="button"
            className={selected === null ? 'picker-item active' : 'picker-item'}
            onClick={() => choose(null)}
          >
            Global
          </button>

          <div className="picker-heading">Layouts</div>
          {names.length === 0 && <p className="hint picker-empty">None yet.</p>}
          {names.map((name) => (
            <button
              key={name}
              type="button"
              className={name === selected ? 'picker-item active' : 'picker-item'}
              onClick={() => choose(name)}
            >
              {name}
            </button>
          ))}

          <form className="picker-new" onSubmit={create}>
            <input
              value={draft}
              placeholder="New layout"
              autoFocus
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
              }}
            />
            <button type="submit" disabled={!canCreate}>
              Add
            </button>
          </form>
          {trimmed !== '' && !isValidName(trimmed) && (
            <p className="error picker-empty">Letters, digits, spaces, _ or -; must start alphanumeric.</p>
          )}
          {error && <p className="error picker-empty">{error}</p>}
        </div>
      )}
    </div>
  );
}
