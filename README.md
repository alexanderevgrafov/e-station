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

8. **A plain "quick" redraw (no pre-clear) is confirmed broken**: it draws
   the new glyph's black strokes directly over whatever was there before,
   with no white pass at all, so old and new ink visibly overlap. Every
   digit redraw needs *some* pre-clear; see the unresolved bug below for
   which kind.

## Unresolved: the "sticky wide partial window" bug

**Symptom:** a partial-refresh window, once used at some width, appears to
"stick" - a *later*, narrower partial push in roughly the same area still
visibly affects the wider area from the earlier push (e.g. a white pre-clear
meant for one digit box also wipes neighboring boxes that were already
correctly redrawn). It does **not** self-correct with time or repetition
(observed persisting 12+ update cycles later); the only thing that resets it
is a full refresh. It reappears the next time a wide (multi-digit) window is
used.

**What causes a "wide window":** more than one digit changing in the same
tick (e.g. `22:59→23:00` touches the hour digits, the colon between them and
both minute digits; `22:19→22:20` touches both minute digits). Pushing
several digits as *separate* narrow windows in one batch was tried first and
is **worse** - it reliably leaves one of the boxes blank (looks like the
panel can't cleanly handle two independent partial windows back-to-back).
Merging changed digits into one bounding-box window (`boundingBox()` in
`logic.js`) fixed *that* problem, but re-exposed the sticky-window one.

**Ruled out** (each was implemented, deployed, and tested on real hardware):

- JS-side coordinate bugs - `preClearBox`/`frameFor` provably use identical
  `x1,y1,x2,y2` for every frame of a given push; there's no code path where
  they could differ.
- Cross-process state leakage - each `refresh()` spawns a *new*
  `epd_update_util` process, which does its own fresh `epd_init_partial()`
  (full SWRESET + register reconfiguration, including resetting the RAM
  address window to the whole panel) before touching anything. The
  stickiness persists even across this boundary.
- The black step of the black→white→redraw flash, and the flash entirely -
  removed in favor of a white-only pre-clear (`preClearBox`); the sticky
  behavior is unchanged. (Silver lining: white-only pre-clear alone is
  sufficient for correctness - no ghosting from dropping black.)
- Alternating flash vs. a plain "quick" push on successive updates, hoping
  the non-flashing pushes would let it settle - no effect, *and* separately
  confirmed quick-mode is just broken (see bug #8 above), so this whole
  approach was abandoned.
- A redundant `epd_power_on()` call before every partial session - removed
  (see `epd_init_registers()` split in `epaper.c`) based on a documented,
  very similar bug in GxEPD2 (a mature Arduino e-paper library) for the
  sibling SSD1680 controller, where the library maintainer found that
  calling `_PowerOn()` (a `0x22` register write) right before a partial
  update caused "an unintended buffer switch, even if the refresh bit is not
  set," and removing it fixed a nearly identical symptom. Applying the same
  fix here (our `epd_power_on()`'s `0x22=0xE0` write is redundant since every
  partial push's own `0x22=0xFF` trigger already includes powering up
  clock+analog) did **not** fix it on this panel.

**A lead that was *not* attempted, and why:** the SSD1683 datasheet (text
extracted from a scanned PDF - see notes if you need to re-derive this)
documents register `0x38` ("Write Register for Display Option") with bit
`F[6]`: "RAM Ping-Pong for black/white mode," disabled by default. Our
driver never writes this register at all, so it sits at that default. This
is a plausible mechanism for exactly this symptom - but `0x38` is a 10-byte
command, and bytes G-J are documented as "module ID / waveform version,"
tied to per-panel OTP calibration (which can be permanently burned in via
command `0x36`). We don't know the correct values for those bytes for this
specific physical panel, and the driver has no SPI read-back capability to
find out safely (`wiringPiSPIDataRW` is full-duplex and *could* support
reads, but nothing in `epaper.c` currently reads a response). Writing wrong
values there risks corrupting calibration data, not just "doesn't help" -
so this needs read-back support added first, or the real factory values
sourced some other way, before it's safe to try.

**Current mitigation (not a fix):** the wide window is *avoided* rather than
fixed, and only avoided for the case that seemed to bother it worst:

- Only minute digit(s) changed → merged white-only partial push, even when
  both minute digits change together (tens rollover). This still exercises
  the sticky-window mechanism at a 2-digit scope, but it's tolerated for
  now (see `refreshImpl` in `logic.js`).
- Either hour digit changed → whole-panel full refresh instead of a partial
  push, which also naturally happens ~once an hour. This sidesteps the
  widest case (hour digits + the colon between them + both minute digits)
  entirely.

**If picking this back up:** the `0x38` RAM Ping-Pong lead is the most
promising untried thing. Next steps would be: add a read-back path to
`epaper.c` (read the response byte(s) from `wiringPiSPIDataRW` after a
command instead of discarding them) to safely read current `0x38`/module-ID
bytes before writing anything back, or find another SSD1683 driver
implementation (GxEPD2 doesn't currently list this exact panel, but the
`GDEY042T81` variant - same panel, different silkscreen - might have a
community driver worth diffing against) that writes `0x38` correctly for
reference.

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
