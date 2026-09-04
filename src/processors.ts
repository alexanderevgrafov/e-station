import type { TArea, TAreaState, TAreaType } from './types.ts';

// A processor decides what a state change means for the panel. One per area
// type, with custom/plugged-in ones to come - which is why the signature
// already carries the whole context rather than just the diff.

export interface ProcessorContext {
  areaName: string;
  area: TArea;
  // The live context, passed opaquely so a processor can look at sibling
  // areas or globals without this module importing context.ts (which imports
  // this one).
  context: unknown;
}

export interface ProcessorResult {
  // Whether the panel needs repainting for this area. The panel expands the
  // list with everything stacked above before pushing.
  redraw: boolean;
  reason?: string;
}

export type Processor = (next: TAreaState, previous: TAreaState, ctx: ProcessorContext) => ProcessorResult;

const NO_REDRAW: ProcessorResult = { redraw: false };

// Text: repaint only when the rendered string actually changed. This is what
// keeps a caller polling /intake every few seconds from flashing the panel on
// every request.
const textProcessor: Processor = (next, previous, { area }) => {
  // Compared as the rendered string, matching textOf in render.ts: sending
  // 14 after "14" changes the stored type but not a single pixel, and must
  // not cost a refresh.
  const fallback = area.type === 'text' ? area.text : '';
  const render = (value: unknown): string =>
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : fallback;

  const before = render(previous['text']);
  const after = render(next['text']);

  if (before === after) return NO_REDRAW;
  return { redraw: true, reason: `text ${JSON.stringify(before)} -> ${JSON.stringify(after)}` };
};

// Placeholders: these types carry no state yet, so nothing they receive can
// mean anything. Pass 2 gives image a real one.
const inertProcessor: Processor = () => NO_REDRAW;

const processors: Record<TAreaType, Processor> = {
  text: textProcessor,
  image: inertProcessor,
  svg: inertProcessor,
};

export function processorFor(type: TAreaType): Processor {
  return processors[type];
}

// The seam custom processors will plug into later.
export function registerProcessor(type: TAreaType, processor: Processor): void {
  processors[type] = processor;
}
