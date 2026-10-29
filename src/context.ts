import * as store from './store.ts';
import { Panel } from './panel.ts';
import type { RefreshResult } from './panel.ts';
import { loadFonts } from './fonts.ts';
import { preload } from './images.ts';
import type { ImageBank } from './images.ts';
import { defaultLayoutState, defaultStateFor, inQuietHours } from './area.ts';
import { processorFor } from './processors.ts';
import { renderedText } from './render.ts';
import { NO_READINGS } from './readings.ts';
import type { TReadings } from './readings.ts';
import { Sensors } from './sensors.ts';
import { deepMerge } from './settings.ts';
import type { TAreaState, TGlobal, TJsonObject, TLayout, TLayoutState, TStore } from './types.ts';
import { EMPTY_STORE } from './types.ts';

// The system singleton: the loaded document, which layout is current, the
// live per-area state, and the panel. Everything that draws goes through
// here.

function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

export class Context {
  readonly panel = new Panel();
  readonly sensors = new Sensors();

  private store: TStore = structuredClone(EMPTY_STORE);
  private currentLayoutName: string | null = null;
  private state: TLayoutState = {};
  private ready = false;

  // Areas that have been written from outside, i.e. via /intake. An area's
  // defaults apply on preview and from startup "before state is updated from
  // outside" - so until it appears here, its state keeps following the
  // layout's defaults and an edit to default text shows up after a sync.
  // Once /intake has spoken for an area, the live value wins and editing the
  // default no longer disturbs what is on the panel.
  private externallySet = new Set<string>();

  // Decoded images for the current layout. Rendering is synchronous, so the
  // bank is warmed on every reload and handed to the renderer as data.
  private images: ImageBank = new Map();

  // One interval per fractal area, re-rolling its seed. Rebuilt on every
  // reload, since the interval is part of the layout being edited.
  private fractalTimers: NodeJS.Timeout[] = [];

  // The readings the panel was last drawn with - not necessarily the
  // sensors' latest: a push that failed rolls this back, so the next poll
  // sees the difference again and retries instead of leaving stale numbers.
  private readings: TReadings = NO_READINGS;

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

  private frame(): { layout: TLayout; state: TLayoutState; global: TGlobal; images: ImageBank; readings: TReadings } | null {
    const layout = this.layout;
    return layout ? { layout, state: this.state, global: this.store.global, images: this.images, readings: this.readings } : null;
  }

  // Resolves after the first poll. Both callers follow it with a full
  // refresh, so that first reading is only recorded, not pushed on its own.
  private startSensors(): Promise<void> {
    let first = true;
    return this.sensors.start(this.store.global.i2cBus, this.store.global.sensorPollSecs, (readings) => {
      if (first) {
        first = false;
        this.readings = readings;
        return;
      }
      this.applyReadings(readings).catch((error: unknown) => console.error('Sensor repaint failed:', error));
    });
  }

  // A new reading touches no state, so no processor sees it. Instead every
  // text area is rendered with the old and the new readings, and only those
  // whose string changed are repainted - together, as one window. Rounding
  // to the token's decimals is what keeps a jittery last digit off the glass.
  private async applyReadings(next: TReadings): Promise<RefreshResult | null> {
    const previous = this.readings;
    this.readings = next;

    const layout = this.layout;
    if (!layout) return null;
    const changed = Object.entries(layout.areas)
      .filter(([name, area]) => {
        if (area.type !== 'text' || !area.enabled) return false;
        const state = this.getAreaState(name);
        return renderedText(area, state, previous) !== renderedText(area, state, next);
      })
      .map(([name]) => name);
    if (changed.length === 0) return null;

    try {
      return await this.panel.refreshAreas(changed, layout, this.state, this.store.global, this.images, next);
    } catch (error) {
      this.readings = previous;
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
    // /intake survives any number of edits, redeploys and reloads. Areas
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
          this.setState(name, { seed: randomSeed() }, false).catch((error: unknown) =>
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
      return await this.panel.refreshAreas([areaName], layout, this.state, this.store.global, this.images, this.readings);
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
    return this.panel.fullRefresh(frame.layout, frame.state, frame.global, frame.images, frame.readings, mode);
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
