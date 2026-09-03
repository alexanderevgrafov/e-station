import {
  TIMEZONE_OFFSET_MINUTES,
  TEST_TIME_HOLD_MS,
  FULL_REFRESH_ON_HOUR_CHANGE,
  FULL_REFRESH_EVERY_N_PARTIALS,
  PRE_CLEAR_BEFORE_REDRAW,
} from './constants.js';

// Protocol constants shared with epd_util/main.c
const METHOD_FULL = 0;
const METHOD_PARTIAL2 = 3; // windowed partial refresh (x1,y1,x2,y2)

const EPD_COLOR_WHITE = 0xFF;

const FONT_SIZE = 72;
const FONT = `${FONT_SIZE}px Ubuntu, serif`;
const PADDING = 2; // slack around a glyph's actual ink so antialiased edges aren't clipped

// HH:MM gets one box per digit (H-tens, H-ones, M-tens, M-ones), so a
// refresh only ever touches the digit(s) that actually changed - typically
// just the minutes' ones digit. The colon is static and only ever drawn as
// part of a full refresh, unless a merged window (see boundingBox below)
// happens to span across it.
let layout = null; // { boxes: [h1, h2, m1, m2], colonBox }

function byteAlign(n) {
  return Math.ceil(n / 8) * 8;
}

function getLayout(display) {
  if (layout) return layout;

  display.ctx.font = FONT;
  const digitMetrics = display.ctx.measureText('0');
  const inkWidth = Math.ceil(digitMetrics.actualBoundingBoxLeft + digitMetrics.actualBoundingBoxRight);
  const inkHeight = Math.ceil(digitMetrics.actualBoundingBoxAscent + digitMetrics.actualBoundingBoxDescent);
  const ascent = digitMetrics.actualBoundingBoxAscent;

  const colonMetrics = display.ctx.measureText(':');
  const colonInkWidth = Math.ceil(colonMetrics.actualBoundingBoxLeft + colonMetrics.actualBoundingBoxRight);

  // x-edges must stay multiples of 8: the panel's RAM window is addressed in
  // byte columns, so a non-aligned edge shifts the refreshed window relative
  // to the pixel data sent for it. Byte-aligning the colon's width too keeps
  // every digit box after it aligned without any extra bookkeeping.
  const digitWidth = byteAlign(inkWidth + PADDING * 2);
  const colonWidth = byteAlign(colonInkWidth + PADDING * 2);
  const height = inkHeight + PADDING * 2;

  const totalWidth = digitWidth * 4 + colonWidth;
  const x0 = Math.floor((display.width - totalWidth) / 2 / 8) * 8;
  const y1 = Math.round((display.height - height) / 2);

  const makeBox = (x1) => ({ x1, y1, x2: x1 + digitWidth, y2: y1 + height, ascent });

  const boxes = [
    makeBox(x0),
    makeBox(x0 + digitWidth),
    makeBox(x0 + digitWidth * 2 + colonWidth),
    makeBox(x0 + digitWidth * 3 + colonWidth),
  ];
  const colonBox = { x1: x0 + digitWidth * 2, x2: x0 + digitWidth * 2 + colonWidth, y1, y2: y1 + height };

  layout = { boxes, colonBox };
  return layout;
}

function drawDigit(display, b, ch) {
  display.paint_drawRectangle(b.x1, b.y1, b.x2, b.y2, EPD_COLOR_WHITE, true);
  display.ctx.font = FONT;
  display.ctx.fillStyle = '#000000';
  const { width: charWidth } = display.ctx.measureText(ch);
  const x = b.x1 + (b.x2 - b.x1 - charWidth) / 2;
  const y = b.y1 + PADDING + b.ascent; // baseline = top-of-ink + ascent
  display.ctx.fillText(ch, x, y);
}

function drawColon(display, { boxes, colonBox }) {
  display.ctx.font = FONT;
  display.ctx.fillStyle = '#000000';
  const { width: charWidth } = display.ctx.measureText(':');
  const x = colonBox.x1 + (colonBox.x2 - colonBox.x1 - charWidth) / 2;
  const y = boxes[0].y1 + PADDING + boxes[0].ascent; // shared baseline with digits
  display.ctx.fillText(':', x, y);
}

function frameFor(display, b) {
  return { method: METHOD_PARTIAL2, x1: b.x1, y1: b.y1, x2: b.x2, y2: b.y2, buffer: display.canvasToBuffer(b.x1, b.y1, b.x2, b.y2) };
}

// Smallest single window spanning every box in the list - a refresh with
// more than one changed digit does exactly one partial push (one region)
// instead of several separate ones; pushing two separate windows in the
// same refresh was observed to leave one of them blank (looked like the
// driver can't handle two partial windows back-to-back cleanly).
function boundingBox(boxesArr) {
  return {
    x1: Math.min(...boxesArr.map((b) => b.x1)),
    y1: Math.min(...boxesArr.map((b) => b.y1)),
    x2: Math.max(...boxesArr.map((b) => b.x2)),
    y2: Math.max(...boxesArr.map((b) => b.y2)),
  };
}

// An extra white-only frame, windowed to box, pushed before the redraw.
// Unused unless PRE_CLEAR_BEFORE_REDRAW is on - the panel clears old ink by
// itself now, see that constant. A black frame before the white one was
// tried too, on the theory that a full black<->white swing re-polarizes more
// thoroughly; it made the (since fixed) sticky-window bug worse and was
// dropped. If ink ever starts overlapping again, turning the pre-clear back
// on is step one and re-adding the black frame is step two.
function preClearBox(display, box) {
  display.paint_drawRectangle(box.x1, box.y1, box.x2, box.y2, EPD_COLOR_WHITE, true);
  return frameFor(display, box);
}

function currentClockDigits() {
  if (testOverride) {
    if (Date.now() < testOverride.expiresAt) return testOverride.digits;
    testOverride = null; // expired - fall through to real time
  }
  // Shift the UTC epoch directly and read it back via the UTC getters, so
  // the result doesn't depend on (and isn't double-shifted by) whatever
  // timezone the board's own OS happens to be set to.
  const shifted = new Date(Date.now() + TIMEZONE_OFFSET_MINUTES * 60 * 1000);
  return String(shifted.getUTCHours()).padStart(2, '0') + String(shifted.getUTCMinutes()).padStart(2, '0'); // "HHMM"
}

function formatClock(digits) {
  return `${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
}

let lastDigits = null;
let testOverride = null; // { digits: "HHMM", expiresAt } | null - see /api/test
let partialsSinceFull = 0; // see FULL_REFRESH_EVERY_N_PARTIALS

async function fullRefreshImpl(display) {
  const { boxes, colonBox } = getLayout(display);
  const digits = currentClockDigits();

  display.paint_clear(EPD_COLOR_WHITE);
  boxes.forEach((b, i) => drawDigit(display, b, digits[i]));
  drawColon(display, { boxes, colonBox });

  const result = await display.displayBW(METHOD_FULL);
  display.saveCanvasAsImage('paper_full.png');

  lastDigits = digits;
  partialsSinceFull = 0;

  return { text: formatClock(digits), result };
}

// Meant to be polled every CLOCK_POLL_INTERVAL_MS (faster than a minute, for
// accuracy), but only ever does real work when HH:MM actually changed since
// the last render - a poll that lands mid-minute is a true no-op:
//  - draw the changed digit(s) onto the canvas and push the smallest single
//    window spanning them (see boundingBox) as one frame. No white pre-clear
//    pass: the panel diffs its own RAM buffers and clears the old ink itself
//    (see PRE_CLEAR_BEFORE_REDRAW).
//  - if either hour digit changed, that window is the widest one there is
//    (both hour digits, the colon between them, and both minute digits).
//    That case used to fall back to a whole-panel full refresh to sidestep
//    the "sticky wide partial window" bug; with the RAM buffer-sync fix in
//    epaper.c it goes through the same partial path as everything else.
//    FULL_REFRESH_ON_HOUR_CHANGE restores the old fallback.
//  - every FULL_REFRESH_EVERY_N_PARTIALS pushes, do a full refresh instead,
//    to clear the residue partial refreshes leave behind.
async function refreshImpl(display) {
  const digits = currentClockDigits();
  const prev = lastDigits;

  if (prev !== null && digits === prev) {
    return { text: formatClock(digits), touchedDigits: [], mode: 'idle', result: null };
  }

  const { boxes, colonBox } = getLayout(display);
  const prevDigits = prev ?? '    '; // no prior state: treat every digit as changed

  const touched = boxes.reduce((acc, b, i) => {
    if (digits[i] !== prevDigits[i]) acc.push(i);
    return acc;
  }, []);

  const hourChanged = touched.some((i) => i <= 1); // 0,1 = H-tens, H-ones

  if (hourChanged && FULL_REFRESH_ON_HOUR_CHANGE) {
    const result = await fullRefreshImpl(display);
    return { ...result, mode: 'full-hour' };
  }

  if (touched.length && FULL_REFRESH_EVERY_N_PARTIALS > 0 && partialsSinceFull >= FULL_REFRESH_EVERY_N_PARTIALS) {
    const result = await fullRefreshImpl(display);
    return { ...result, mode: 'full-periodic' };
  }

  let result = null;
  if (touched.length) {
    const region = touched.length === 1 ? boxes[touched[0]] : boundingBox(touched.map((i) => boxes[i]));
    const frames = [];

    if (PRE_CLEAR_BEFORE_REDRAW) frames.push(preClearBox(display, region));

    // drawDigit white-fills its own box first, so the canvas - and therefore
    // the frame read back off it - is already correct without a pre-clear
    // frame. All the pre-clear ever did was force the *panel* to make a
    // black->white pass it can make on its own.
    touched.forEach((i) => drawDigit(display, boxes[i], digits[i]));

    // A window merged across the hour and minute digits also spans the colon
    // sitting between them, which preClearBox wipes. The colon is otherwise
    // only ever painted by a full refresh, so put it back.
    if (PRE_CLEAR_BEFORE_REDRAW && region.x1 <= colonBox.x1 && region.x2 >= colonBox.x2) {
      drawColon(display, { boxes, colonBox });
    }

    frames.push(frameFor(display, region));

    result = await display.pushFrames(frames);
    partialsSinceFull++;
  }

  display.saveCanvasAsImage('paper_partial.png');

  lastDigits = digits;

  return {
    text: formatClock(digits),
    touchedDigits: touched,
    mode: PRE_CLEAR_BEFORE_REDRAW ? 'partial-preclear' : 'partial-quick',
    partialsSinceFull,
    result,
  };
}

// refresh()/clearFull()/testTime() all read and mutate shared state
// (lastDigits, the counter, the canvas) - if calls overlap (e.g. an
// /api/clock poll interval shorter than a refresh's real hardware
// round-trip time), a second call can start diffing against lastDigits
// before the first has updated it, corrupting which digits get touched.
// Serializing them the same way EPaperDisplay serializes hardware pushes
// closes that race.
let opQueue = Promise.resolve();
function serialized(fn) {
  const run = () => fn();
  const result = opQueue.then(run, run);
  opQueue = result.catch(() => {});
  return result;
}

export function refresh({ display }) {
  return serialized(() => refreshImpl(display));
}

// Manual deep-clean endpoint: same whole-panel full refresh, on demand.
export function clearFull({ display }) {
  return serialized(() => fullRefreshImpl(display).then((result) => ({ ...result, mode: 'full-manual' })));
}

// Debug endpoint: force the clock to show an arbitrary HH:MM immediately
// (through the exact same diff/merge/flash logic as a real update), then
// hold that value against real-clock polls for TEST_TIME_HOLD_MS so there's
// time to look at the result before /api/clock's next poll overwrites it.
export function testTime({ display, hhmm }) {
  if (!/^([01]\d|2[0-3])[0-5]\d$/.test(hhmm)) {
    throw new Error('time must be 4 digits HHMM, HH 00-23, MM 00-59');
  }
  testOverride = { digits: hhmm, expiresAt: Date.now() + TEST_TIME_HOLD_MS };
  return serialized(() => refreshImpl(display));
}
