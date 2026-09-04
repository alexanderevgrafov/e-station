import { useEffect, useState } from 'react';
import { isValidLayoutName } from '../../src/types.ts';

interface Props {
  name: string;
  existing: string[];
  onRename: (to: string) => Promise<void>;
  onDelete: () => Promise<void>;
}

export function LayoutHeader({ name, existing, onRename, onDelete }: Props) {
  const [draft, setDraft] = useState(name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    setDraft(name);
    setError(null);
    setConfirming(false);
  }, [name]);

  const trimmed = draft.trim();
  const taken = trimmed !== name && existing.includes(trimmed);
  const canRename = trimmed !== name && trimmed !== '' && isValidLayoutName(trimmed) && !taken && !busy;

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setBusy(false);
    }
  }

  return (
    <header className="layout-head">
      <form
        className="row"
        onSubmit={(event) => {
          event.preventDefault();
          if (canRename) void run(() => onRename(trimmed));
        }}
      >
        <input
          className="name-input"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(null);
          }}
        />
        <button type="submit" disabled={!canRename}>
          Rename
        </button>

        {confirming ? (
          <>
            <span className="hint">Delete &ldquo;{name}&rdquo;?</span>
            <button type="button" className="danger" disabled={busy} onClick={() => void run(onDelete)}>
              Confirm
            </button>
            <button type="button" className="ghost" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className="danger ghost" disabled={busy} onClick={() => setConfirming(true)}>
            Delete
          </button>
        )}
      </form>
      {taken && <p className="error">A layout named &ldquo;{trimmed}&rdquo; already exists.</p>}
      {error && <p className="error">{error}</p>}
    </header>
  );
}
