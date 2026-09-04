import { useState } from 'react';
import { api } from '../api.ts';

interface Props {
  pending: boolean; // saved edits the panel has not been shown yet
  onSynced: () => void;
}

// Editor saves are screen-independent: the document is written and the
// preview updates, but the panel is left alone. This is the one control that
// pushes a design to the glass, as a whole-panel clear and redraw.
export function SyncBar({ pending, onSynced }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncedAt, setSyncedAt] = useState<string | null>(null);

  async function sync() {
    setBusy(true);
    setError(null);
    try {
      await api.sync();
      setSyncedAt(new Date().toLocaleTimeString());
      onSynced();
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
        ) : pending ? (
          'Edits saved - panel not updated yet'
        ) : syncedAt ? (
          `Panel synced at ${syncedAt}`
        ) : (
          'Panel is independent of the editor until you sync'
        )}
      </span>

      <button type="button" className={pending ? '' : 'ghost'} onClick={() => void sync()} disabled={busy}>
        {busy ? 'Syncing...' : 'Sync panel'}
      </button>
    </>
  );
}
