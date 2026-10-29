import { seedOf } from './render.ts';
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

// These types carry no state, so nothing they receive can mean anything.
// Text is driven by the variable pool instead (see Context.setVariables);
// image will get a state of its own later.
const inertProcessor: Processor = () => NO_REDRAW;

// Fractal: a new seed is a new picture; anything else in the patch is noise.
const fractalProcessor: Processor = (next, previous) => {
  const before = seedOf(previous);
  const after = seedOf(next);
  if (before === after) return NO_REDRAW;
  return { redraw: true, reason: `seed ${before} -> ${after}` };
};

const processors: Record<TAreaType, Processor> = {
  text: inertProcessor,
  image: inertProcessor,
  svg: inertProcessor,
  fractal: fractalProcessor,
};

export function processorFor(type: TAreaType): Processor {
  return processors[type];
}

// The seam custom processors will plug into later.
export function registerProcessor(type: TAreaType, processor: Processor): void {
  processors[type] = processor;
}
