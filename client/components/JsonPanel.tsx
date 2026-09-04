import { useEffect, useMemo, useState } from 'react';
import type { TJsonObject } from '../../src/types.ts';

interface Props {
  title: string;
  hint?: string;
  value: TJsonObject;
  rows?: number;
  onSave: (value: TJsonObject) => Promise<void>;
}

function parseObject(text: string): { value: TJsonObject } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'Must be a JSON object, not an array or a bare value' };
  }
  return { value: parsed as TJsonObject };
}

// Settings are a free-form options bag for now, so they are edited as raw
// JSON text rather than through generated fields. The textarea holds a
// string; it is only parsed back into the document on save.
export function JsonPanel({ title, hint, value, rows = 12, onSave }: Props) {
  const serialized = useMemo(() => JSON.stringify(value, null, 2), [value]);
  const [text, setText] = useState(serialized);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Re-seed the textarea when the document changes underneath it - switching
  // layouts, or a save returning normalized content. Keyed on the serialized
  // form so an unrelated re-render doesn't wipe what's being typed.
  useEffect(() => {
    setText(serialized);
    setSaveError(null);
  }, [serialized]);

  const parsed = useMemo(() => parseObject(text), [text]);
  const parseError = 'error' in parsed ? parsed.error : null;
  const dirty = text !== serialized;

  async function handleSave() {
    if ('error' in parsed) return;
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(parsed.value);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>{title}</h2>
        {dirty && <span className="badge">unsaved</span>}
      </header>
      {hint && <p className="hint">{hint}</p>}
      <textarea
        className={parseError ? 'code invalid' : 'code'}
        spellCheck={false}
        rows={rows}
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="row">
        <button type="button" onClick={handleSave} disabled={!dirty || parseError !== null || saving}>
          {saving ? 'Saving...' : 'Save'}
        </button>
        <button type="button" className="ghost" onClick={() => setText(serialized)} disabled={!dirty || saving}>
          Revert
        </button>
        {parseError && <span className="error">{parseError}</span>}
        {saveError && <span className="error">{saveError}</span>}
      </div>
    </section>
  );
}
