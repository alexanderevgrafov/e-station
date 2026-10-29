// The shape of the stored layout document, shared verbatim between the
// server and the browser editor. Both sides import from here so the wire
// format can only ever be described in one place.

// A JSON value, as it comes back out of JSON.parse.
export type TJsonValue = string | number | boolean | null | TJsonValue[] | { [key: string]: TJsonValue };

export type TJsonObject = { [key: string]: TJsonValue };

// `as const` arrays rather than enums: Node strips types, it does not compile
// them, so an enum would emit no runtime object. See tsconfig's
// erasableSyntaxOnly.
export const AREA_TYPES = ['text', 'image', 'svg', 'fractal'] as const;
export type TAreaType = (typeof AREA_TYPES)[number];

export const H_ALIGNS = ['left', 'center', 'right'] as const;
export type THAlign = (typeof H_ALIGNS)[number];

// What a text area does with the pixels under it. 'clear' wipes its rectangle
// to white first; 'halo' keeps whatever the layers below drew and only
// outlines the glyphs in paper colour, so the text stays legible on top of it.
export const BACKDROPS = ['clear', 'halo'] as const;
export type TBackdrop = (typeof BACKDROPS)[number];

export const UNITS = ['px', '%'] as const;
export type TUnit = (typeof UNITS)[number];

// Which axis the image is sized on; the other follows from the source's
// aspect ratio, which is never distorted.
export const SIZE_AXES = ['width', 'height'] as const;
export type TSizeAxis = (typeof SIZE_AXES)[number];

// What a fractal area draws. 'random' lets each new seed pick one of the two.
export const FRACTAL_KINDS = ['random', 'julia', 'mandelbrot'] as const;
export type TFractalKind = (typeof FRACTAL_KINDS)[number];

// Ordered matrices first (cheap, tileable, no error propagation), then the
// error-diffusion family. See src/dither.ts for what each one looks like.
export const DITHERS = [
  'threshold',
  'bayer4',
  'bayer8',
  'halftone',
  'floyd-steinberg',
  'atkinson',
  'sierra-lite',
] as const;
export type TDither = (typeof DITHERS)[number];

export interface TMeasure {
  value: number;
  unit: TUnit;
}

export interface TAreaCommon {
  type: TAreaType;
  // Panel pixels, top-left origin. x/w are byte-aligned to multiples of 8 by
  // the editor, because the panel's partial-refresh window is addressed in
  // byte columns - see src/panel.ts.
  x: number;
  y: number;
  w: number;
  h: number;
  // Unique across a layout, higher draws later. Assigned max+1 on create and
  // otherwise left alone; "Bring to front" is the only thing that changes it.
  z: number;
  // A disabled area stays in the layout (and in the editor) but is not drawn,
  // not repainted, and does not count as sitting on top of anything.
  enabled: boolean;
  // Derived, never edited by hand: the areas that intersect this one *and*
  // sit above it. Recomputed on every write. Repainting this area has to be
  // followed by repainting everything listed here, or its fresh pixels would
  // cover a neighbour that was drawn on top of it. Areas below are not
  // listed - they were already overdrawn and need nothing.
  overlapped: string[];
}

export interface TTextArea extends TAreaCommon {
  type: 'text';
  text: string; // default text, and the initial value of the area's state
  font: string; // family name, from /api/editor/fonts
  fontSize: number;
  fontWeight: string; // 'normal' | 'bold' | ... whatever the family offers
  align: THAlign;
  backdrop: TBackdrop;
  // Halo thickness in px, measured outward from the glyph edge. Only used by
  // the 'halo' backdrop. The halo is clipped to the area, so leave room.
  haloRadius: number;
  // Px between the text and the area edge it is aligned to. Left/right
  // align only; centred text ignores it.
  padding: number;
}

// Placement inside the area follows CSS background-image, because that is
// the model everyone already has for "put this picture in this box":
//   posX/posY  = background-position. In px, an offset from the area's
//                top-left. In %, the CSS meaning - 0% flush left/top, 50%
//                centred, 100% flush right/bottom - which is what makes
//                "centre it" a round number.
//   size       = background-size along one axis only. The other axis follows
//                the source's aspect ratio, which is never distorted.
export interface TImageArea extends TAreaCommon {
  type: 'image';
  src: string | null; // image id from /api/editor/images, null = nothing uploaded yet
  posX: TMeasure;
  posY: TMeasure;
  sizeAxis: TSizeAxis;
  size: TMeasure;
  dither: TDither;
  // Grey-level shift applied before dithering: positive lightens, negative
  // darkens. Photos usually need a nudge to land well on e-paper.
  bias: number;
}

export interface TSvgArea extends TAreaCommon {
  type: 'svg';
}

// Generated art: a black-and-white fractal, re-rolled on a timer. The picture
// is a pure function of the area's state `seed` (a Date.now() timestamp, never
// stored in the layout) plus the fields below, so repaints caused by
// overlapping areas show the same picture, and /intake can pick one by hand
// with ?seed=N.
export interface TFractalArea extends TAreaCommon {
  type: 'fractal';
  kind: TFractalKind;
  // Minutes between new seeds. 0 turns the timer off (the seed then only
  // changes through /intake).
  intervalMins: number;
  // Quiet period, local "HH:MM" (may wrap midnight, e.g. 23:00 - 05:00): the
  // timer does not roll new seeds inside it. Either empty = no quiet period.
  quietFrom: string;
  quietTo: string;
  // Deepest Mandelbrot zoom as a power of ten (3.5 = 10^3.5 times in). Zoom
  // is also backed off when the picture would be mostly empty.
  maxZoom: number;
  // Shift of the view from the position the seed picked, in % of the view's
  // width / height (100 = one full screen further right / down).
  offsetX: number;
  offsetY: number;
  // 0..100: how gradually the pattern outside the set fades to white with
  // distance from it. 0 keeps the full banding everywhere; 100 leaves ink
  // only close to the set's edge.
  outerWhite: number;
  // 0..100: the escape speed past which everything is plain white, hard.
  // Inside the set is black, just outside it the ribbons; pixels that escape
  // faster than the cutoff are white. 0 = no cutoff, 100 = only the very
  // slowest escapes keep their ribbons.
  whiteCutoff: number;
  // Draw in reverted colours.
  negative: boolean;
  dither: TDither;
  bias: number;
}

export type TArea = TTextArea | TImageArea | TSvgArea | TFractalArea;

// Live per-area values, keyed by area name. Not persisted - this is what
// /intake writes and what processors diff.
export type TAreaState = TJsonObject;
export type TLayoutState = Record<string, TAreaState>;

// Free-form options bag. The global one supplies defaults; a layout's own
// settings deep-merge over it (see src/settings.ts).
export type TSettings = TJsonObject;

// System-level configuration. Separate from the settings chain on purpose:
// globals describe the hardware and the render loop, they are not defaults
// that a layout can override.
export interface TGlobal extends TJsonObject {
  screenWidth: number;
  screenHeight: number;
  // Was TIMEZONE_OFFSET_MINUTES. Nothing reads it now that the clock is
  // driven from outside; kept because it is board configuration, and the
  // thing feeding /intake will want it back.
  timezoneOffsetMinutes: number;
  // Whole-panel refresh on a timer, regardless of traffic. 0 disables.
  fullRefreshEveryMins: number;
  // Whole-panel refresh after this many partial pushes, to clear the residue
  // partial refreshes leave behind. 0 disables.
  fullRefreshEveryNPartials: number;
  // Push an extra white frame over an area's window before redrawing it. Off:
  // the panel clears old ink itself. See README's sticky-window section.
  preClearBeforeRedraw: boolean;
  // The AHT20+BMP280 board: which /dev/i2c-N it is on, and how often it is
  // read. 0 turns polling off. Text areas show the readings through
  // {temp}-style placeholders - see src/readings.ts.
  i2cBus: number;
  sensorPollSecs: number;
}

export interface TLayout {
  settings: TSettings;
  areas: Record<string, TArea>;
}

export interface TStore {
  global: TGlobal;
  settings: TSettings;
  layouts: Record<string, TLayout>;
}

export const DEFAULT_GLOBAL: TGlobal = {
  screenWidth: 400,
  screenHeight: 300,
  timezoneOffsetMinutes: 4 * 60,
  fullRefreshEveryMins: 60,
  fullRefreshEveryNPartials: 60,
  preClearBeforeRedraw: false,
  i2cBus: 1,
  sensorPollSecs: 60,
};

export const EMPTY_STORE: TStore = {
  global: DEFAULT_GLOBAL,
  settings: {},
  layouts: {},
};

// Layout and area names are object keys and appear in URLs, so keep them
// boring.
export const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,63}$/;

export function isValidName(name: string): boolean {
  return NAME_PATTERN.test(name);
}

// Kept under the old name so existing call sites read naturally.
export const isValidLayoutName = isValidName;
export const LAYOUT_NAME_PATTERN = NAME_PATTERN;
