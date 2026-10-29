import * as store from './store.ts';
import { Panel } from './panel.ts';
import type { RefreshResult } from './panel.ts';
import { loadFonts } from './fonts.ts';
import { preload } from './images.ts';
import type { ImageBank } from './images.ts';
import { defaultLayoutState, defaultStateFor, inQuietHours } from './area.ts';
import { processorFor } from './processors.ts';
import { renderedText } from './render.ts';
import { NO_READINGS, sensorVariables } from './variables.ts';
import type { TVariables, TVarValue } from './variables.ts';
import { Sensors } from './sensors.ts';
import { deepMerge } from './settings.ts';
import type { TAreaState, TGlobal, TJsonObject, TLayout, TLayoutState, TStore } from './types.ts';
import { EMPTY_STORE } from './types.ts';

// The system singleton: the loaded document, which layout is current, the
// live per-area state, the variable pool, and the panel. Everything that
// draws goes through here.

// A pool patch. undefined removes the variable, so its placeholders show as
// typed again.
export type TVariablesPatch = Record<string, TVarValue | undefined>;

export class Context {
  readonly panel = new Panel();
  readonly sensors = new Sensors();

  private store: TStore = structuredClone(EMPTY_STORE);
  private currentLayoutName: string | null = null;
  private state: TLayoutState = {};
  private ready = false;

  // Areas whose state has been written from outside, i.e. via
  // /intake/:area. Until an area appears here its state keeps following the
  // layout's defaults; once /intake has spoken for it, the live value wins
  // and editing the layout no longer disturbs what is on the panel.
  private externallySet = new Set<string>();

  // Decoded images for the current layout. Rendering is synchronous, so the
  // bank is warmed on every reload and handed to the renderer as data.
  private images: ImageBank = new Map();

  // One interval per fractal area, re-rolling its seed. Rebuilt on every
  // reload, since the interval is part of the layout being edited.
  private fractalTimers: NodeJS.Timeout[] = [];

  // The variable pool: sensor readings and whatever /intake has set, under
  // one namespace. Not persisted. It holds what the panel was last drawn
  // with - a push that failed rolls its keys back, so the next identical
  // value is seen as a change again and retried instead of lost.
  private variables: TVariables = sensorVariables(NO_READINGS);

  get global(): TGlobal {
    return this.store.global;
  }

  get layouts(): Record<string, TLayout> {
    return this.store.layouts;
  }

  get layoutName(): string | null {
    return this.currentLayoutName;
  }

  get layout(): TLayout | null {
    return this.currentLayoutName === null ? null : (this.store.layouts[this.currentLayoutName] ?? null);
  }

  getState(): TLayoutState {
    return this.state;
  }

  getAreaState(areaName: string): TAreaState {
    return this.state[areaName] ?? {};
  }

  getVariables(): TVariables {
    return this.variables;
  }

  // Global settings with the current layout's settings merged over them.
  get settings(): TJsonObject {
    return deepMerge(this.store.settings, this.layout?.settings ?? {});
  }

  async init(): Promise<void> {
    await loadFonts();
    await this.reload();
    await this.startSensors();
    this.ready = true;
    this.panel.startFullRefreshTimer(() => this.frame());
  }

  private frame(): { layout: TLayout; state: TLayoutState; global: TGlobal; images: ImageBank; variables: TVariables } | null {
    const layout = this.layout;
    return layout ? { layout, state: this.state, global: this.store.global, images: this.images, variables: this.variables } : null;
  }

  // Resolves after the first poll. Both callers follow it with a full
  // refresh, so that first reading is only recorded, not pushed on its own.
  private startSensors(): Promise<void> {
    let first = true;
    return this.sensors.start(this.store.global.i2cBus, this.store.global.sensorPollSecs, (readings) => {
      if (first) {
        first = false;
        this.variables = { ...this.variables, ...sensorVariables(readings) };
        return;
      }
      this.setVariables(sensorVariables(readings)).catch((error: unknown) => console.error('Sensor repaint failed:', error));
    });
  }

  // Merges a patch into the variable pool - a sensor poll or an /intake call,
  // it is the same thing. Variables touch no area state, so no processor sees
  // them. Instead every text area is rendered with the old and the new pool,
  // and only those whose string changed are repainted - together, as one
  // window. Rounding to the placeholder's decimals is what keeps a jittery
  // last digit off the glass.
  async setVariables(patch: TVariablesPatch): Promise<RefreshResult | null> {
    const previous = this.variables;
    const next: TVariables = { ...previous };
    for (const [name, value] of Object.entries(patch)) {
      if (value === undefined) delete next[name];
      else next[name] = value;
    }
    this.variables = next;

    const layout = this.layout;
    if (!layout) return null;
    const changed = Object.entries(layout.areas)
      .filter(([, area]) => area.type === 'text' && area.enabled && renderedText(area, previous) !== renderedText(area, next))
      .map(([name]) => name);
    if (changed.length === 0) return null;

    try {
      return await this.panel.refreshAreas(changed, layout, this.state, this.store.global, this.images, next);
    } catch (error) {
      // Only the keys this patch wrote, and only where nothing has written
      // them since: another patch may have landed while the push was queued.
      const current = { ...this.variables };
      for (const name of Object.keys(patch)) {
        if (current[name] !== next[name]) continue;
        if (Object.hasOwn(previous, name)) current[name] = previous[name]!;
        else delete current[name];
      }
      this.variables = current;
      throw error;
    }
  }

  // Re-reads the document from disk and reconciles the live state with it.
  // Called at startup and after every editor write, so an area renamed or
  // retyped in the editor is reflected without a restart.
  async reload(): Promise<void> {
    this.store = await store.load();

    const names = Object.keys(this.store.layouts);
    // "current = first" for now; a layout picker comes later.
    if (this.currentLayoutName === null || !this.store.layouts[this.currentLayoutName]) {
      this.currentLayoutName = names[0] ?? null;
    }

    const layout = this.layout;
    if (!layout) {
      this.state = {};
      this.images = new Map();
      this.startFractalTimers();
      return;
    }

    this.images = await preload(layout);

    // Editing a layout must not disturb live state: a value pushed in via
    // /intake survives any number of edits and reloads. Areas
    // nothing has spoken for yet re-seed from their (possibly just edited)
    // defaults, and areas that no longer exist drop out.
    const next: TLayoutState = {};
    for (const [name, area] of Object.entries(layout.areas)) {
      const seeded = defaultStateFor(area);
      next[name] = this.externallySet.has(name) ? { ...seeded, ...(this.state[name] ?? {}) } : seeded;
    }
    this.state = next;
    this.startFractalTimers();

    for (const name of [...this.externallySet]) {
      if (!layout.areas[name]) this.externallySet.delete(name);
    }
  }

  setCurrentLayout(name: string): void {
    if (!this.store.layouts[name]) return;
    this.currentLayoutName = name;
    this.state = defaultLayoutState(this.store.layouts[name].areas);
    this.externallySet.clear();
    this.startFractalTimers();
  }

  private startFractalTimers(): void {
    for (const timer of this.fractalTimers) clearInterval(timer);
    this.fractalTimers = [];

    for (const [name, area] of Object.entries(this.layout?.areas ?? {})) {
      if (area.type !== 'fractal' || !area.enabled || area.intervalMins <= 0) continue;
      this.fractalTimers.push(
        setInterval(() => {
          if (inQuietHours(area, new Date())) return;
          this.setState(name, { seed: Date.now() }, false).catch((error: unknown) =>
            console.error(`Fractal "${name}" refresh failed:`, error),
          );
        }, area.intervalMins * 60_000),
      );
    }
  }

  // Merges a patch over an area's state, then hands old and new to that
  // area's processor. The processor - not the caller - decides whether the
  // panel is touched.
  //
  // `external` is false for the fractal timer: its rolls are not "written
  // from outside", so a sync goes back to the area's saved seed - what the
  // editor preview showed - instead of keeping the last rolled picture.
  async setState(areaName: string, patch: TAreaState, external = true): Promise<RefreshResult | null> {
    const layout = this.layout;
    if (!layout) return null;

    const area = layout.areas[areaName];
    if (!area) return null;

    const previous = this.state[areaName] ?? defaultStateFor(area);
    const wasExternallySet = this.externallySet.has(areaName);
    const next: TAreaState = { ...previous, ...patch };
    this.state[areaName] = next;
    if (external) this.externallySet.add(areaName);

    // State is still kept for a disabled area, so enabling it later shows the
    // latest value; it just never touches the panel meanwhile.
    if (!area.enabled) return null;

    const outcome = processorFor(area.type)(next, previous, { areaName, area, context: this });
    if (!outcome.redraw) return null;

    try {
      return await this.panel.refreshAreas([areaName], layout, this.state, this.store.global, this.images, this.variables);
    } catch (error) {
      // The push failed, so the panel does not show `next`. Rolling the state
      // back keeps it honest about what is on screen - otherwise the next
      // call with the same value sees "no change", skips the redraw, and the
      // update is lost until something else happens to repaint that area.
      this.state[areaName] = previous;
      if (external && !wasExternallySet) this.externallySet.delete(areaName);
      throw error;
    }
  }

  // Whole-panel repaint of the current layout.
  async refreshAll(mode: 'full' | 'full-manual' = 'full'): Promise<RefreshResult | null> {
    const frame = this.frame();
    if (!frame) return null;
    return this.panel.fullRefresh(frame.layout, frame.state, frame.global, frame.images, frame.variables, mode);
  }

  // Sync & Save: the document has just been written, so pick it up and bring
  // the panel to it with a whole-panel clear and redraw. The only path by
  // which an editor change reaches the glass.
  async sync(): Promise<RefreshResult | null> {
    await this.reload();
    this.panel.startFullRefreshTimer(() => this.frame());
    // Bus or poll interval may have just been edited.
    await this.startSensors();
    return this.refreshAll('full-manual');
  }
}

export const context = new Context();
