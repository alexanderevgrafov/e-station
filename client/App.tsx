import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from './api.ts';
import { useFonts } from './useFonts.ts';
import { useSensors } from './useSensors.ts';
import { usePreview } from './usePreview.ts';
import { JsonPanel } from './components/JsonPanel.tsx';
import { LayoutPicker } from './components/LayoutPicker.tsx';
import { ScreenCanvas } from './components/ScreenCanvas.tsx';
import { LayoutHeader } from './components/LayoutHeader.tsx';
import { AreaList } from './components/AreaList.tsx';
import type { TAreaFilter } from './components/AreaList.tsx';
import { AreaForm } from './components/AreaForm.tsx';
import { SyncBar } from './components/SyncBar.tsx';
import { VariablesPanel, previewVariables } from './components/VariablesPanel.tsx';
import { mergeSettings } from '../src/settings.ts';
import * as doc from '../src/document.ts';
import type { Rect } from '../src/area.ts';
import type { TArea, TAreaType, TGlobal, TJsonObject, TStore } from '../src/types.ts';

export function App() {
  // `draft` is what the editor shows and mutates; `saved` is the last thing
  // the server confirmed. Every edit is a pure document operation applied
  // locally - nothing reaches the server, the file, or the panel until
  // Sync&Save. Before this, per-field writes meant a half-finished edit was
  // what the next /intake rendered against.
  const [draft, setDraft] = useState<TStore | null>(null);
  const [saved, setSaved] = useState<TStore | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedArea, setSelectedArea] = useState<string | null>(null);
  const [filter, setFilter] = useState<TAreaFilter>('all');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);

  const { fonts, error: fontError } = useFonts();
  const { sensors, error: sensorError } = useSensors();
  const { url: previewUrl, error: previewError } = usePreview(draft, selected);

  useEffect(() => {
    api.load().then(
      (store) => {
        setDraft(store);
        setSaved(store);
      },
      (error: unknown) => setLoadError(error instanceof Error ? error.message : String(error)),
    );
  }, []);

  // Document operations throw on invalid input (duplicate names, bad
  // geometry), so every edit funnels through here and surfaces the message
  // instead of leaving the draft half-applied.
  const edit = useCallback((fn: (store: TStore) => TStore): boolean => {
    let ok = true;
    setDraft((current) => {
      if (!current) return current;
      try {
        const next = fn(current);
        setEditError(null);
        return next;
      } catch (error) {
        setEditError(error instanceof Error ? error.message : String(error));
        ok = false;
        return current;
      }
    });
    return ok;
  }, []);

  const names = useMemo(() => (draft ? Object.keys(draft.layouts) : []), [draft]);
  const dirty = useMemo(
    () => draft !== null && saved !== null && JSON.stringify(draft) !== JSON.stringify(saved),
    [draft, saved],
  );

  // Unsaved work now lives only in this tab, so leaving with edits pending
  // would silently lose them.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  useEffect(() => {
    if (selected !== null && draft && !draft.layouts[selected]) setSelected(null);
  }, [selected, draft]);

  useEffect(() => setSelectedArea(null), [selected]);

  if (loadError) return <p className="error page-error">Could not load the layout store: {loadError}</p>;
  if (!draft) return <p className="hint page-error">Loading...</p>;

  const layout = selected === null ? null : (draft.layouts[selected] ?? null);
  const areaNames = layout ? Object.keys(layout.areas) : [];
  const area = layout && selectedArea !== null ? (layout.areas[selectedArea] ?? null) : null;

  return (
    <div className="app">
      <header className="topbar">
        <strong className="topbar-title">e-station</strong>
        <LayoutPicker
          names={names}
          selected={selected}
          onSelect={setSelected}
          onCreate={async (name: string) => {
            if (edit((store) => doc.createLayout(store, name))) setSelected(name);
          }}
        />
        <SyncBar
          dirty={dirty}
          store={draft}
          onSaved={(store) => {
            setDraft(store);
            setSaved(store);
          }}
        />
      </header>

      <main className="main">
        {editError && <p className="error">{editError}</p>}

        {layout === null || selected === null ? (
          <>
            <h1>Global</h1>
            <JsonPanel
              title="Globals"
              hint="System configuration: panel size, refresh policy, timezone. Not part of the settings chain - a layout cannot override these."
              value={draft.global as unknown as TJsonObject}
              rows={9}
              onSave={async (value) => {
                edit((store) => doc.setGlobal(store, value as unknown as TGlobal));
              }}
            />
            <JsonPanel
              title="Global settings"
              hint="Defaults for every layout. A layout's own settings deep-merge over this: nested objects merge key by key, arrays and scalars replace."
              value={draft.settings}
              onSave={async (value) => {
                edit((store) => doc.setGlobalSettings(store, value));
              }}
            />
            <VariablesPanel sensors={sensors} error={sensorError} />
          </>
        ) : (
          <>
            <LayoutHeader
              name={selected}
              existing={names}
              onRename={async (to) => {
                if (edit((store) => doc.renameLayout(store, selected, to))) setSelected(to);
              }}
              onClone={async () => {
                const created = doc.clonedLayoutName(draft, selected);
                if (edit((store) => doc.cloneLayout(store, selected))) setSelected(created);
              }}
              onDelete={async () => {
                if (edit((store) => doc.deleteLayout(store, selected))) setSelected(null);
              }}
            />

            {fontError && <p className="error">Fonts unavailable: {fontError}</p>}
            {previewError && <p className="error">Preview: {previewError}</p>}

            <div className="workspace">
              <div className="workspace-canvas">
                <ScreenCanvas
                  layout={layout}
                  global={draft.global}
                  previewUrl={previewUrl}
                  selected={selectedArea}
                  filter={filter}
                  onSelect={setSelectedArea}
                  onMove={async (name, rect: Rect) => {
                    edit((store) => doc.updateArea(store, selected, name, rect));
                  }}
                  onCreate={async (name, type: TAreaType) => {
                    if (edit((store) => doc.createArea(store, selected, name, type))) setSelectedArea(name);
                  }}
                />
              </div>

              <div className="workspace-side">
                <AreaList
                  layout={layout}
                  selected={selectedArea}
                  filter={filter}
                  onFilter={setFilter}
                  onSelect={setSelectedArea}
                  onToggle={(name, enabled) => {
                    edit((store) => doc.updateArea(store, selected, name, { enabled }));
                  }}
                />
                {area && selectedArea !== null ? (
                  <AreaForm
                    name={selectedArea}
                    area={area}
                    existing={areaNames}
                    fonts={fonts}
                    variables={previewVariables(sensors)}
                    onChange={async (patch: Partial<TArea>) => {
                      edit((store) => doc.updateArea(store, selected, selectedArea, patch));
                    }}
                    onRename={async (to) => {
                      if (edit((store) => doc.renameArea(store, selected, selectedArea, to))) setSelectedArea(to);
                    }}
                    onBringToFront={async () => {
                      edit((store) => doc.bringAreaToFront(store, selected, selectedArea));
                    }}
                    onClone={async () => {
                      // Ask the document layer which name it will pick, rather
                      // than diffing the result to find the new key.
                      const created = doc.clonedAreaName(draft, selected, selectedArea);
                      if (edit((store) => doc.cloneArea(store, selected, selectedArea))) setSelectedArea(created);
                    }}
                    onDelete={async () => {
                      if (edit((store) => doc.deleteArea(store, selected, selectedArea))) setSelectedArea(null);
                    }}
                  />
                ) : (
                  <p className="hint workspace-empty">Select an area on the screen to edit it, or add one.</p>
                )}
              </div>
            </div>

            <VariablesPanel sensors={sensors} error={sensorError} />

            <JsonPanel
              title="Layout settings"
              hint="Merged over the global settings. Only the keys that differ from the defaults need to be here."
              value={layout.settings}
              onSave={async (value) => {
                edit((store) => doc.setLayoutSettings(store, selected, value));
              }}
            />

            <section className="panel">
              <header className="panel-head">
                <h2>Effective settings</h2>
                <span className="badge">read-only</span>
              </header>
              <p className="hint">Global settings with this layout's settings merged over them.</p>
              <pre className="code readonly">
                {JSON.stringify(mergeSettings(draft.settings, layout.settings), null, 2)}
              </pre>
            </section>

            <section className="panel">
              <header className="panel-head">
                <h2>Layout JSON</h2>
                <span className="badge">read-only</span>
                {dirty && <span className="badge">draft</span>}
              </header>
              <p className="hint">
                What would be written for &ldquo;{selected}&rdquo; to data/layouts.json on Sync&amp;Save, including the
                derived <code>z</code> and <code>overlapped</code>.
              </p>
              <pre className="code readonly tall">{JSON.stringify(layout, null, 2)}</pre>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
