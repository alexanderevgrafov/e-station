import { useState } from 'react';
import { api } from '../api.ts';
import type { TStore } from '../../src/types.ts';

interface Props {
  dirty: boolean; // the draft differs from what the server last confirmed
  store: TStore;
  onSaved: (store: TStore) => void;
}

// Sync & Save is the only thing that writes the document or touches the
// panel. Everything else in the editor is a local draft, so an edit in
// progress can never be what /intake renders against.
export function SyncBar({ dirty, store, onSaved }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setWarning(null);
    try {
      // The server answers with the normalized document, which is what the
      // draft becomes - so any clamping it applied is visible immediately
      // rather than showing up as a surprise on the next load.
      const result = await api.syncAndSave(store);
      onSaved(result.store);
      setSavedAt(new Date().toLocaleTimeString());
      setWarning(result.warning ?? null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <span className="hint topbar-status">
        {error ? (
          <span className="error">{error}</span>
        ) : warning ? (
          <span className="error">{warning}</span>
        ) : dirty ? (
          'Unsaved edits - nothing written, panel untouched'
        ) : savedAt ? (
          `Saved and synced at ${savedAt}`
        ) : (
          'No unsaved edits'
        )}
      </span>

      <button type="button" className={dirty ? '' : 'ghost'} onClick={() => void run()} disabled={busy}>
        {busy ? 'Saving...' : 'Sync & Save'}
      </button>
    </>
  );
}
