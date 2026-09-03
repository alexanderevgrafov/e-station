# e-station

A digital clock rendered on a WeAct 4.2" 400×300 black/white e-paper module,
driven by a Raspberry Pi Zero 2W over SPI. This document is a working log for
whoever picks this project back up - what the pieces are, how to run/debug
it, and (at length) the story of one still-unresolved hardware quirk.

## Hardware

- **Panel:** WeAct 4.2" e-paper module, 400×300, black/white, SSD1683
  controller, 4-wire SPI, 3.3V IO. Official reference:
  [WeActStudio/WeActStudio.EpaperModule](https://github.com/WeActStudio/WeActStudio.EpaperModule)
  (`Example/EpaperModuleTest_RaspberryPi` is what `epd_util/` was built from).
- **Board:** Raspberry Pi Zero 2W, DietPi, at `192.168.233.109`, user
  `dietpi`, project lives at `/home/dietpi/e-station`.
- **Service:** `e-station-server.service` (systemd) runs `node server.js`.

## Architecture

```
server.js (Express, HTTP API)
  -> src/logic.js   (clock rendering: what changed, what to draw, when to
                      flash vs full-refresh - all the "policy")
  -> src/epd.js      (EPaperDisplay: node-canvas for pixels, packs them into
                      the panel's 1bpp format, spawns epd_update_util and
                      streams frames to it over stdin)
  -> epd_util/        (C binary; owns the actual SPI/GPIO protocol)
       main.c         reads a stream of {method,x1,y1,x2,y2,imagedata}
                       frames from stdin, applies them in order, sleeps once
                       at the end
       epaper/epaper.c SSD1683 register-level driver (adapted from the
                       official WeAct example)
```

`display` (an `EPaperDisplay` instance) is a **singleton** constructed once
in `server.js` - the in-memory canvas and the last-known clock digits persist
across requests as long as the Node process is alive.

## API

- `GET /api/clock?start=1[&intervalMs=...]` - starts the clock: a timer polls
  the current time every `CLOCK_POLL_INTERVAL_MS` (10s by default,
  `constants.js`) and calls `refresh()`, which only actually touches the
  panel when `HH:MM` has changed since the last render.
- `GET /api/clock?stop=1` - stops it.
- `GET /api/clock` (no params) - reports `{running: true|false}`.
- `GET /api/clear-full` - forces an immediate whole-panel full refresh.
- `GET /api/test?time=HHMM` - debug tool: forces the clock to show an
  arbitrary time *right now*, through the exact same diff/merge/redraw logic
  a real update uses (not a separate code path), then holds that value
  against real-clock polls for `TEST_TIME_HOLD_MS` (30s) so there's time to
  look at the result before the next real poll overwrites it. Use this
  instead of waiting on the wall clock to reach an interesting digit
  transition (e.g. `time=2259` then `time=2300` to force an hour rollover on
  demand).

## Deploying

`yarn deploy` (`scripts/deploy.sh`): rsyncs the project to the Pi (excluding
`node_modules`, build artifacts, debug PNGs), then over SSH runs
`yarn install --production` (native modules like `canvas` must be built for
the Pi's own arch, not copied from your machine) followed by
`post-deployment-script.sh`, which:
1. restarts the systemd service,
2. rebuilds `epd_util` (`make`),
3. waits for the server to come up,
4. calls `/api/clear-full` then `/api/clock?start=1` - a clean baseline
   before the clock starts polling.

## Tunable constants (`src/constants.js`)

- `CLOCK_POLL_INTERVAL_MS` - how often `/api/clock` checks the time.
- `TIMEZONE_OFFSET_MINUTES` - the board's OS clock reads UTC; this is applied
  directly to the epoch before formatting, rather than trusting the OS
  timezone.
- `TEST_TIME_HOLD_MS` - how long `/api/test` overrides the real clock.
- `FULL_REFRESH_ON_HOUR_CHANGE` - fall back to a whole-panel full refresh on
  an hour rollover instead of a partial push. Was the mitigation for the
  sticky-window bug below; `false` now that it's fixed.
- `PRE_CLEAR_BEFORE_REDRAW` - push an extra white frame over a digit's window
  before redrawing it. `false`: the panel clears old ink itself, see below.
- `FULL_REFRESH_EVERY_N_PARTIALS` - full-panel pass every N partial pushes,
  to clear accumulated partial-refresh residue (`0` disables).

## Bugs found and fixed this round (roughly chronological)

Early on the display only worked with a **full** refresh; every attempt at a
**partial** (windowed) refresh produced garbage or didn't update at all.
Working through it top to bottom:

1. **`epd.js` `canvasToBuffer` read the wrong pixels for any non-(0,0)
   region.** It called `getImageData(0, 1, width, height)` (a hardcoded,
   wrong origin) and then indexed the result using *absolute* canvas
   coordinates against a *locally-sized* buffer. Fixed to
   `getImageData(x1, y1, width, height)` with local `(x - x1, y - y1)`
   indexing throughout.

2. **`epaper.c` `epd_address_set` was called with exclusive bounds where the
   SSD1683 expects inclusive ones.** The official driver always calls it as
   `epd_address_set(0, 0, EPD_W-1, EPD_H-1)`. Our custom windowed-partial
   path (`epd_displayBW_partial2`, which has no official equivalent - the
   stock examples only ever do full-frame partial refresh) was passing
   `x2`/`y2` straight through, off by one *byte column* in the RAM window
   whenever `x2` landed on a byte boundary - causing a per-row skew.

3. **`epd_displayBW_partial2`'s buffer-length calculation was in pixels, not
   bytes** (`bufLen = Width * Height` instead of
   `(Width/8) * Height`) - 8× too large, so it read far more bytes than were
   ever sent, off the end of the intended image buffer, and shipped that
   garbage to the panel. This was probably the single biggest source of the
   early "garbage in the partial area" symptom.

4. **Repeated deep-sleep/wake cycling.** Each `displayBW()` call spawned a
   *separate* `epd_update_util` process, and every process did a full
   wake → init → single push → sleep → GPIO teardown. Doing a black-clear +
   white-clear + content sequence meant three full power cycles back to
   back, which corrupted the panel's internal RAM-differencing state
   (symptom: black rectangle appears, then nothing further happens, or
   things go inverted). **Fix:** `main.c` now loops reading multiple frames
   from stdin within *one* process, initializing once and sleeping once at
   the end; `epd.js` grew `pushFrames(frames)` to stream a batch through a
   single spawned process. `displayBW()` is a one-frame convenience wrapper
   over it.

5. **Race condition between overlapping `refresh()` calls.** Diffing against
   `lastDigits` and painting the canvas is synchronous, but the whole
   operation `await`s once (the hardware push) - if a poll fired before the
   previous one finished, the second read stale `lastDigits`, corrupting
   which digits got touched (symptom: static digits updating, digits
   randomly blanking). Fixed by serializing `refresh()`/`clearFull()`/
   `testTime()` through one queue (`serialized()` in `logic.js`), the same
   pattern `EPaperDisplay` already used to serialize hardware pushes.

6. **A periodic "flush unchanged digits" feature (`STATIC_DIGIT_FLUSH_EVERY`)
   was removed.** It force-touched all four digits every N minute-changes
   regardless of whether they'd actually changed, which looked exactly like
   a bug ("hour digit updates mid-hour") and was probably also a factor in
   #5-era symptoms. Digits are only ever touched when they actually change,
   full stop.

7. **Board's system clock is UTC**, not local time. `TIMEZONE_OFFSET_MINUTES`
   shifts the epoch before formatting rather than depending on the OS
   timezone.

8. **A plain "quick" redraw (no pre-clear) appeared to be broken**: it drew
   the new glyph's black strokes over whatever was there before, with no
   white pass at all, so old and new ink visibly overlapped. This was written
   off as a hardware limitation and worked around with a white pre-clear
   frame. It was actually the same root cause as #9 - see below; quick
   redraws work fine now and the pre-clear is gone.

9. **Windowed partial refresh only re-armed one of the panel's two RAM
   buffers.** The long-running "sticky wide partial window" bug - it has its
   own section below.

## Fixed: the "sticky wide partial window" bug

**Symptom:** a partial-refresh window, once used at some width, appeared to
"stick" - a *later*, narrower partial push in roughly the same area still
visibly affected the wider area from the earlier push (e.g. a white pre-clear
meant for one digit box also wiped neighboring boxes that were already
correctly redrawn). It did **not** self-correct with time or repetition
(observed persisting 12+ update cycles later); the only thing that reset it
was a full refresh, and it came back the next time a wide (multi-digit)
window was used.

**What causes a "wide window":** more than one digit changing in the same
tick (e.g. `22:59→23:00` touches the hour digits, the colon between them and
both minute digits; `22:19→22:20` touches both minute digits). Pushing
several digits as *separate* narrow windows in one batch was tried first and
is **worse** - it reliably leaves one of the boxes blank (looks like the
panel can't cleanly handle two independent partial windows back-to-back).
Merging changed digits into one bounding-box window (`boundingBox()` in
`logic.js`) fixed *that* problem, but re-exposed the sticky-window one.

### Cause

`epd_displayBW_partial2()` only re-armed **one** of the controller's two RAM
buffers after a windowed partial refresh.

The SSD1683 keeps a "current" (`0x24`) and a "previous" (`0x26`) RAM buffer;
a partial (display mode 2) update drives the pixels where the two disagree,
and flips which physical buffer each command addresses as part of the update.
So after `epd_update_partial()`, only the buffer just written is known-good -
its counterpart still holds whatever the *previous* push left there, **and
only inside that push's window**. The old code wrote back just `0x26`, which
left the other buffer stale over exactly the last window used. The next
update then compared against that stale region and drove all of it,
disregarding the narrower window it had been given.

That accounts for every observed property of the bug:

- the stale region is precisely the *previous* window, so a wide push poisons
  every narrower push that follows;
- it survives a process restart and a full SWRESET, because it lives in panel
  RAM, not in registers - which is why "cross-process state leakage" was
  correctly ruled out and the trail went cold there;
- a full refresh clears it, because `epd_displayBW()` writes `0x26` *and*
  `0x24` across the whole panel;
- the stock WeAct full-frame partial path (`epd_displayBW_partial`) never
  showed it, because its window is always the entire panel - a stale buffer
  can never be scoped differently from the next update. The bug only exists
  in `partial2`, the windowed variant this project added, which has no
  official equivalent.

GxEPD2's driver for this exact panel confirms it:
[`GxEPD2_420_GDEY042T81.cpp`](https://github.com/ZinggJM/GxEPD2/blob/master/src/gdey/GxEPD2_420_GDEY042T81.cpp)
does `writeImage()` (`0x24`) → `refresh(x,y,w,h)` → `writeImageAgain()`,
and `writeImageAgain()` writes **both** `0x26` and `0x24`.

### The fix

In `epaper.c`:

1. `epd_displayBW_partial2()` now writes the image back to `0x26` *and*
   `0x24` after the refresh, each preceded by its own `epd_address_set()`
   (the RAM address counter has run past the window's end by then).
2. `epd_address_set()` now also parks the RAM address counters (`0x4E`/`0x4F`)
   at the window origin, *after* setting the window - the order every
   reference driver uses. The counters were previously set by a separate
   `epd_setpos()` call *before* the window; equivalent in practice, but it
   made the code impossible to check against any reference.

In `logic.js`/`constants.js`: `FULL_REFRESH_ON_HOUR_CHANGE` (default `false`)
replaces the hard-coded full-refresh fallback on hour rollover, so the widest
window is exercised rather than sidestepped.

Confirmed on the real panel: hour rollovers now go through the same windowed
partial path as everything else, with no full refresh and no bleed into
neighboring digit boxes.

### The same bug also explains the broken "quick" redraw (#8)

A partial refresh drives the pixels where the panel's "previous" RAM buffer
disagrees with its "current" one, in both directions. So a redraw shouldn't
need a white pre-clear at all - just push the new content and let the
controller work out the difference. That was tried early and looked broken:
new ink landed on top of old ink and nothing ever went white.

That is the exact signature of a previous buffer running one push behind.
Take a pixel that is white in `old`, black in `new` (what's on screen now),
and white again in `new2` (what we're pushing):

| | prev RAM (stale `old`) | on screen (`new`) | pushing (`new2`) | diff drives? |
|---|---|---|---|---|
| pixel A | white | **black** | white | white→white: **no** |
| pixel B | white | white | black | white→black: yes |

Only the white→black half of the diff survives, so new strokes appear and old
ones never clear - "the new draw just covers the previous draw." With both
buffers re-armed after every refresh, the previous buffer genuinely holds
what's on screen and both directions get driven.

So the pre-clear frame is gone: `refreshImpl` draws the changed digits onto
the canvas and pushes the region as a *single* frame. `drawDigit` already
white-fills its own box on the canvas, so the frame content was never the
problem - the pre-clear only ever existed to force the panel into a
black→white pass it can make by itself. `PRE_CLEAR_BEFORE_REDRAW` brings the
two-frame version back if it's ever needed.

Because partial refreshes leave a little residue behind and the hour-rollover
full refresh is no longer there to mop it up, `FULL_REFRESH_EVERY_N_PARTIALS`
(default 60, `0` disables) does a full-panel pass every N partial pushes -
roughly the old once-an-hour cadence, no longer tied to a particular digit
changing. `/api/clock`'s response reports `mode` (`partial-quick`,
`full-periodic`, ...) and `partialsSinceFull` so you can see where it is in
that cycle.

### Regression check

The bug only ever showed up as *narrow after wide*, so that is the ordering to
walk. `yarn deploy`, `/api/clear-full` for a clean baseline, then:

```
/api/test?time=2219   # baseline
/api/test?time=2220   # wide-ish: both minute digits
/api/test?time=2221   # narrow: ones digit only - the tens digit must survive
/api/test?time=2259
/api/test?time=2300   # widest: hour digits + colon + both minute digits
/api/test?time=2301   # narrow again - only the ones digit may change
```

Two things to watch. Steps 3 and 6 catch the sticky window: if the digit to
the *left* of the one that changed goes blank or flickers, it's back. Every
step catches the quick-redraw failure: if the old glyph's strokes are still
visible under the new one, the black→white half of the diff is being dropped
again, which means the two RAM buffers have drifted apart.

### Still on the table (not needed, but noted)

- `epd_update_partial()` sends `0x22 = 0xFF`, whose trailing bits power the
  analog and clock **down** after every partial update. GxEPD2 and ESPHome
  both send `0xFC` for this panel and leave power up until an explicit
  power-off - so this driver power-cycles once per push where the reference
  drivers don't. It wasn't the cause and the panel is happy at `0xFF`, but if
  anything partial-refresh-related gets flaky again, `0xFC` is the first
  single-value change to try; it's flagged in a comment at that call.
- Never attempted, and riskier: the SSD1683 datasheet documents register
  `0x38` ("Write Register for Display Option") with bit `F[6]` "RAM Ping-Pong
  for black/white mode", disabled by default and never written by this
  driver. It is the register-level knob for the buffer-flip behavior
  described above - the software-side sync turned out to be enough, so it
  stays untouched. If it ever isn't: `0x38` is a 10-byte command whose bytes
  G-J are per-panel OTP calibration ("module ID / waveform version", burnable
  via `0x36`), so writing wrong values risks corrupting calibration rather
  than merely failing. That needs SPI read-back support in `epaper.c` first
  (`wiringPiSPIDataRW` is full-duplex and could support it; nothing currently
  reads a response) to read the factory values before writing anything back.

### Ruled out along the way

Each of these was implemented, deployed and tested on real hardware, and none
of them was the cause:

- JS-side coordinate bugs - `preClearBox`/`frameFor` provably use identical
  `x1,y1,x2,y2` for every frame of a given push.
- Cross-process state leakage via *registers* - each push spawns a new
  `epd_update_util` process which does a full SWRESET and reconfigures the
  RAM window. (Correct as far as it goes; the state that actually leaked was
  panel RAM, which no reset clears.)
- The black step of the black→white→redraw flash, and the flash entirely -
  removed in favor of a white-only pre-clear (`preClearBox`). Silver lining:
  white-only pre-clear alone is sufficient for correctness, no ghosting.
- Alternating flash vs. a plain "quick" push on successive updates - no
  effect, and quick-mode is separately broken (see bug #8 above).
- A redundant `epd_power_on()` before every partial session - removed (see
  the `epd_init_registers()` split in `epaper.c`) after a documented GxEPD2
  bug on the sibling SSD1680 where a `_PowerOn()` right before a partial
  update caused "an unintended buffer switch". Didn't fix it here, but the
  removal is correct on its own terms and has been kept.

## Debugging tips

- `/api/test?time=HHMM` to hit specific digit transitions on demand instead
  of waiting on the wall clock.
- `epd.js` saves `paper_partial.png`/`paper_full.png` after every render -
  useful for confirming what the *software* thinks it drew, independent of
  what the panel actually shows.
- `epd_update_util`'s stdout/stderr is captured and surfaces in the API
  error response (`EPaperDisplay._pushFramesToPanel` rejects on nonzero
  exit code with both streams in the message) - check there first if a push
  silently seems to do nothing.
