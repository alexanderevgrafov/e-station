import { useCallback, useEffect, useMemo, useState } from 'react';

import { api } from './api.ts';
import { useFonts } from './useFonts.ts';
import { JsonPanel } from './components/JsonPanel.tsx';
import { LayoutPicker } from './components/LayoutPicker.tsx';
import { ScreenCanvas } from './components/ScreenCanvas.tsx';
import { LayoutHeader } from './components/LayoutHeader.tsx';
import { AreaForm } from './components/AreaForm.tsx';
import { SyncBar } from './components/SyncBar.tsx';
import { mergeSettings } from '../src/settings.ts';
import type { Rect } from '../src/area.ts';
import type { TArea, TAreaType, TGlobal, TJsonObject, TStore } from '../src/types.ts';

export function App() {
  const [store, setStore] = useState<TStore | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedArea, setSelectedArea] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Bumped on every successful write. Busts the preview PNG's cache, which is
  // the only way the true render knows to re-fetch.
  const [version, setVersion] = useState(0);
  // Saved edits the panel has not been shown yet - saves no longer push.
  const [pendingSync, setPendingSync] = useState(false);

  const { fonts, error: fontError } = useFonts();

  useEffect(() => {
    api.load().then(setStore, (error: unknown) => {
      setLoadError(error instanceof Error ? error.message : String(error));
    });
  }, []);

  // Every mutation returns the whole document, so this is the only place
  // client state is written - there is no partial local patching to drift.
  const apply = useCallback(async (next: Promise<TStore>): Promise<void> => {
    setStore(await next);
    setVersion((n) => n + 1);
    setPendingSync(true);
  }, []);

  const names = useMemo(() => (store ? Object.keys(store.layouts) : []), [store]);

  // A layout or area deleted or renamed out from under the selection.
  useEffect(() => {
    if (selected !== null && store && !store.layouts[selected]) setSelected(null);
  }, [selected, store]);

  useEffect(() => setSelectedArea(null), [selected]);

  if (loadError) return <p className="error page-error">Could not load the layout store: {loadError}</p>;
  if (!store) return <p className="hint page-error">Loading...</p>;

  // ?? null so a selection pointing at a just-deleted layout reads the same
  // as no selection - the cleanup effect above resets it on the next render.
  const layout = selected === null ? null : (store.layouts[selected] ?? null);
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
            await apply(api.createLayout(name));
            setSelected(name);
          }}
        />
        <SyncBar pending={pendingSync} onSynced={() => setPendingSync(false)} />
      </header>

      <main className="main">
        {layout === null || selected === null ? (
          <>
            <h1>Global</h1>
            <JsonPanel
              title="Globals"
              hint="System configuration: panel size, refresh policy, timezone. Not part of the settings chain - a layout cannot override these."
              value={store.global as unknown as TJsonObject}
              rows={9}
              onSave={(value) => apply(api.setGlobal(value as unknown as TGlobal))}
            />
            <JsonPanel
              title="Global settings"
              hint="Defaults for every layout. A layout's own settings deep-merge over this: nested objects merge key by key, arrays and scalars replace."
              value={store.settings}
              onSave={(value) => apply(api.setGlobalSettings(value))}
            />
          </>
        ) : (
          <>
            <LayoutHeader
              name={selected}
              existing={names}
              onRename={async (to) => {
                await apply(api.renameLayout(selected, to));
                setSelected(to);
              }}
              onDelete={async () => {
                await apply(api.deleteLayout(selected));
                setSelected(null);
              }}
            />

            {fontError && <p className="error">Fonts unavailable: {fontError}</p>}

            <div className="workspace">
              <div className="workspace-canvas">
            <ScreenCanvas
              layoutName={selected}
              layout={layout}
              global={store.global}
              version={version}
              selected={selectedArea}
              onSelect={setSelectedArea}
              onMove={(name, rect: Rect) => apply(api.updateArea(selected, name, rect))}
              onCreate={async (name, type: TAreaType) => {
                await apply(api.createArea(selected, name, type));
                setSelectedArea(name);
              }}
            />

              </div>

              <div className="workspace-side">
            {area && selectedArea !== null ? (
              <AreaForm
                name={selectedArea}
                area={area}
                existing={areaNames}
                fonts={fonts}
                onChange={(patch: Partial<TArea>) => apply(api.updateArea(selected, selectedArea, patch))}
                onRename={async (to) => {
                  await apply(api.renameArea(selected, selectedArea, to));
                  setSelectedArea(to);
                }}
                onBringToFront={() => apply(api.bringAreaToFront(selected, selectedArea))}
                onClone={async () => {
                  const before = new Set(Object.keys(layout.areas));
                  const next = await api.cloneArea(selected, selectedArea);
                  setStore(next);
                  setVersion((n) => n + 1);
                  setPendingSync(true);
                  // The server picks the name, so find whichever one is new
                  // and select it - cloning to edit the copy is the point.
                  const created = Object.keys(next.layouts[selected]?.areas ?? {}).find((n) => !before.has(n));
                  if (created) setSelectedArea(created);
                }}
                onDelete={async () => {
                  await apply(api.deleteArea(selected, selectedArea));
                  setSelectedArea(null);
                }}
              />
            ) : (
              <p className="hint workspace-empty">Select an area on the screen to edit it, or add one.</p>
            )}
              </div>
            </div>

            <JsonPanel
              title="Layout settings"
              hint="Merged over the global settings. Only the keys that differ from the defaults need to be here."
              value={layout.settings}
              onSave={(value) => apply(api.setLayoutSettings(selected, value))}
            />

            <section className="panel">
              <header className="panel-head">
                <h2>Effective settings</h2>
                <span className="badge">read-only</span>
              </header>
              <p className="hint">Global settings with this layout's settings merged over them.</p>
              <pre className="code readonly">{JSON.stringify(mergeSettings(store.settings, layout.settings), null, 2)}</pre>
            </section>

            <section className="panel">
              <header className="panel-head">
                <h2>Layout JSON</h2>
                <span className="badge">read-only</span>
              </header>
              <p className="hint">
                Exactly what is stored for &ldquo;{selected}&rdquo; in data/layouts.json, including the derived{' '}
                <code>z</code> and <code>overlaps</code>.
              </p>
              <pre className="code readonly tall">{JSON.stringify(layout, null, 2)}</pre>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
