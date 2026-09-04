import { EPaperDisplay } from './epd.ts';
import type { EpdFrame, EpdPushResult } from './epd.ts';
import { drawAreas, drawLayout } from './render.ts';
import { boundingBox, snapDown, snapUp, withAreasAbove } from './area.ts';
import type { Rect } from './area.ts';
import type { TGlobal, TLayout, TLayoutState } from './types.ts';
import type { ImageBank } from './images.ts';

// Protocol constants shared with epd_util/main.c
const METHOD_FULL = 0;
const METHOD_PARTIAL2 = 3; // windowed partial refresh (x1,y1,x2,y2)

export type RefreshMode = 'idle' | 'partial' | 'full' | 'full-periodic' | 'full-timer' | 'full-manual';

export interface RefreshResult {
  mode: RefreshMode;
  areas: string[];
  window: Rect | null;
  partialsSinceFull: number;
  result: EpdPushResult | null;
}

// Owns the panel: the single canvas whose pixels mirror what is physically on
// screen, and the policy for full vs partial pushes. Replaces the old
// logic.ts, whose hardcoded HH:MM digit boxes are now just an ordinary text
// layout driven from outside via /intake.
export class Panel {
  private readonly display = new EPaperDisplay();
  private partialsSinceFull = 0;
  private queue: Promise<unknown> = Promise.resolve();
  private fullRefreshTimer: NodeJS.Timeout | null = null;

  // Every push reads and mutates the shared canvas, so they are chained. This
  // is the same race that used to corrupt which digits got touched when two
  // clock polls overlapped.
  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.catch(() => {});
    return result;
  }

  get canvasContext() {
    return this.display.ctx;
  }

  fullRefresh(
    layout: TLayout,
    state: TLayoutState,
    global: TGlobal,
    images: ImageBank,
    mode: RefreshMode = 'full',
  ): Promise<RefreshResult> {
    return this.serialized(async () => {
      drawLayout(this.display.ctx, layout, state, global, images);
      const result = await this.display.displayBW(METHOD_FULL, 0, 0, global.screenWidth, global.screenHeight);
      this.partialsSinceFull = 0;
      this.display.saveCanvasAsImage('paper_full.png');
      return {
        mode,
        areas: Object.keys(layout.areas),
        window: { x: 0, y: 0, w: global.screenWidth, h: global.screenHeight },
        partialsSinceFull: 0,
        result,
      };
    });
  }

  // Repaints the named areas plus everything stacked above whatever they
  // touch, as one windowed partial push. One window rather than several:
  // pushing two independent partial windows back to back reliably left one of
  // them blank on this panel (see README).
  refreshAreas(
    names: string[],
    layout: TLayout,
    state: TLayoutState,
    global: TGlobal,
    images: ImageBank,
  ): Promise<RefreshResult> {
    return this.serialized(async () => {
      const expanded = withAreasAbove(layout.areas, names).filter((name) => layout.areas[name]);
      if (expanded.length === 0) {
        return { mode: 'idle' as const, areas: [], window: null, partialsSinceFull: this.partialsSinceFull, result: null };
      }

      // Partial refreshes leave residue behind, so an occasional full pass
      // cleans it out. Checked before drawing so the full path renders
      // everything from scratch instead of layering onto a partial repaint.
      if (global.fullRefreshEveryNPartials > 0 && this.partialsSinceFull >= global.fullRefreshEveryNPartials) {
        drawLayout(this.display.ctx, layout, state, global, images);
        const result = await this.display.displayBW(METHOD_FULL, 0, 0, global.screenWidth, global.screenHeight);
        this.partialsSinceFull = 0;
        this.display.saveCanvasAsImage('paper_full.png');
        return {
          mode: 'full-periodic' as const,
          areas: Object.keys(layout.areas),
          window: { x: 0, y: 0, w: global.screenWidth, h: global.screenHeight },
          partialsSinceFull: 0,
          result,
        };
      }

      drawAreas(this.display.ctx, layout, state, expanded, images);

      const box = boundingBox(expanded.map((name) => layout.areas[name]!));
      if (!box) {
        return { mode: 'idle' as const, areas: [], window: null, partialsSinceFull: this.partialsSinceFull, result: null };
      }

      // The panel's RAM window is addressed in byte columns, so the x edges
      // of the pushed window must land on multiples of 8 or the refreshed
      // region shifts relative to the pixel data sent for it.
      const window: Rect = {
        x: snapDown(box.x),
        y: box.y,
        w: 0,
        h: box.h,
      };
      window.w = Math.min(snapUp(box.x + box.w) , global.screenWidth) - window.x;

      const x2 = window.x + window.w;
      const y2 = window.y + window.h;

      const frames: EpdFrame[] = [];
      if (global.preClearBeforeRedraw) {
        // Optional extra white pass. Off by default: the panel diffs its own
        // RAM buffers and clears old ink itself. See README.
        const saved = this.display.ctx.getImageData(window.x, window.y, window.w, window.h);
        this.display.ctx.fillStyle = '#FFFFFF';
        this.display.ctx.fillRect(window.x, window.y, window.w, window.h);
        frames.push({
          method: METHOD_PARTIAL2,
          x1: window.x,
          y1: window.y,
          x2,
          y2,
          buffer: this.display.canvasToBuffer(window.x, window.y, x2, y2),
        });
        this.display.ctx.putImageData(saved, window.x, window.y);
      }

      frames.push({
        method: METHOD_PARTIAL2,
        x1: window.x,
        y1: window.y,
        x2,
        y2,
        buffer: this.display.canvasToBuffer(window.x, window.y, x2, y2),
      });

      const result = await this.display.pushFrames(frames);
      this.partialsSinceFull += 1;
      this.display.saveCanvasAsImage('paper_partial.png');

      return {
        mode: 'partial' as const,
        areas: expanded,
        window,
        partialsSinceFull: this.partialsSinceFull,
        result,
      };
    });
  }

  // Whole-panel refresh on a wall-clock timer, independent of traffic. The
  // clock used to provide this incidentally via its hourly rollover; with the
  // clock driven from outside there is nothing else guaranteeing the panel
  // ever gets cleaned.
  startFullRefreshTimer(
    getFrame: () => { layout: TLayout; state: TLayoutState; global: TGlobal; images: ImageBank } | null,
  ): void {
    this.stopFullRefreshTimer();
    const frame = getFrame();
    const mins = frame?.global.fullRefreshEveryMins ?? 0;
    if (!frame || mins <= 0) return;

    this.fullRefreshTimer = setInterval(() => {
      const current = getFrame();
      if (!current) return;
      this.fullRefresh(current.layout, current.state, current.global, current.images, 'full-timer').catch((error: unknown) =>
        console.error('Timed full refresh failed:', error),
      );
    }, mins * 60 * 1000);
  }

  stopFullRefreshTimer(): void {
    if (this.fullRefreshTimer) clearInterval(this.fullRefreshTimer);
    this.fullRefreshTimer = null;
  }
}
