import { useEffect, useRef, useState } from 'react';
import { useDebounced } from '../useDebounced.ts';

// Form fields that commit while you type (debounced), so the preview tracks
// the keystrokes instead of waiting for a blur.
//
// The shared trick is `editing`: once you have touched a field, incoming prop
// updates stop overwriting the draft. Without it, the round-trip that follows
// each debounced commit would rewrite the input from the server's normalized
// value mid-word and move the caret.

function useLiveDraft<T>(value: T, render: (v: T) => string, commit: (v: T) => void) {
  const [draft, setDraft] = useState(() => render(value));
  const editing = useRef(false);
  const push = useDebounced(commit);

  useEffect(() => {
    if (!editing.current) setDraft(render(value));
    // render is defined inline by callers; depending on it would re-run this
    // on every render and defeat the guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const done = () => {
    editing.current = false;
    setDraft(render(value));
  };

  return { draft, setDraft, editing, push, done };
}

export function NumberField({
  label,
  value,
  step = 1,
  hint,
  onCommit,
}: {
  label: string;
  value: number;
  step?: number;
  hint?: string;
  onCommit: (value: number) => void;
}) {
  const { draft, setDraft, editing, push, done } = useLiveDraft(value, String, onCommit);

  return (
    <label className="field" title={hint}>
      <span>{label}</span>
      <input
        type="number"
        step={step}
        value={draft}
        onChange={(e) => {
          editing.current = true;
          setDraft(e.target.value);
          const parsed = Number(e.target.value);
          // An empty or half-typed value ("-", "1e") is just skipped; the
          // next keystroke that parses will commit.
          if (e.target.value.trim() !== '' && Number.isFinite(parsed)) push(parsed);
        }}
        onBlur={done}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
    </label>
  );
}

export function TextField({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: string;
  onCommit: (value: string) => void;
}) {
  const { draft, setDraft, editing, push, done } = useLiveDraft(value, (v) => v, onCommit);

  return (
    <label className="field wide">
      <span>{label}</span>
      <input
        value={draft}
        onChange={(e) => {
          editing.current = true;
          setDraft(e.target.value);
          push(e.target.value);
        }}
        onBlur={done}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
    </label>
  );
}

export function RangeField({
  label,
  value,
  min,
  max,
  step = 1,
  hint,
  onCommit,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  hint?: string;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(value);
  const editing = useRef(false);
  const push = useDebounced(onCommit);

  useEffect(() => {
    if (!editing.current) setDraft(value);
  }, [value]);

  return (
    <label className="field wide" title={hint}>
      <span>
        {label} <em className="field-value">{draft > 0 ? `+${draft}` : draft}</em>
      </span>
      <span className="range-row">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={draft}
          onChange={(e) => {
            editing.current = true;
            const next = Number(e.target.value);
            setDraft(next);
            push(next);
          }}
          onPointerUp={() => {
            editing.current = false;
          }}
        />
        <button
          type="button"
          className="ghost tiny"
          onClick={() => {
            editing.current = false;
            setDraft(0);
            onCommit(0);
          }}
          disabled={draft === 0}
        >
          reset
        </button>
      </span>
    </label>
  );
}
