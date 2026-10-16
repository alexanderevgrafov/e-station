# e-station

A digital clock rendered on a WeAct 4.2" 400×300 black/white e-paper module,
driven by a Raspberry Pi Zero 2W over SPI, plus a browser-based editor for the
screen layouts it draws. This document is a working log for whoever picks the
project back up - what the pieces are, how to run/debug it, and (at length)
the story of one hardware quirk that took a while to pin down.

## Hardware

- **Panel:** WeAct 4.2" e-paper module, 400×300, black/white, SSD1683
  controller, 4-wire SPI, 3.3V IO. Official reference:
  [WeActStudio/WeActStudio.EpaperModule](https://github.com/WeActStudio/WeActStudio.EpaperModule)
  (`Example/EpaperModuleTest_RaspberryPi` is what `epd_util/` was built from).
- **Board:** Raspberry Pi Zero 2W, DietPi, at `192.168.233.109`, user
  `dietpi`, project lives at `/home/dietpi/e-station`.
- **Service:** `e-station-server.service` (systemd) runs `node server.ts`. The
  unit is versioned at `deploy/e-station-server.service` and installed from
  there by every deploy - do not hand-edit it on the device, the next deploy
  will overwrite it.

## Architecture

```
server.ts (Express, HTTP API)
  -> src/context.ts       THE SINGLETON: global + layouts + current layout +
                          live state + the panel. Everything that draws goes
                          through it. setState(area, patch) merges, calls the
                          area's processor, and repaints if it says so.
  -> src/processors.ts    per-area-type "did this state change matter?"
  -> src/panel.ts         owns EPaperDisplay; full vs partial policy, window
                          byte-alignment, refresh timers
  -> src/render.ts        layout + state -> canvas pixels (shared by the
                          panel and the editor's preview PNG)
  -> src/dither.ts        greyscale -> pure black/white, 7 algorithms
  -> src/images.ts        uploads: resize, content-addressed store, decode cache
  -> src/area.ts          geometry, z-order, overlap derivation (shared with
                          the browser)
  -> src/fonts.ts         scans font dirs, registers them with node-canvas
  -> src/epd.ts           EPaperDisplay: packs canvas pixels into the panel's
                          1bpp format, spawns epd_update_util, streams frames
  -> epd_util/            (C binary; owns the actual SPI/GPIO protocol)
       main.c             reads {method,x1,y1,x2,y2,imagedata} frames from
                          stdin, applies them in order, sleeps once at the end
       epaper/epaper.c    SSD1683 register-level driver (adapted from the
                          official WeAct example)

  -> src/routes/intake.ts  /intake/:area - the panel's update path
  -> src/routes/editor.ts  layout editor JSON API, /api/editor/*
  -> src/document.ts       every operation on the document, as pure functions -
                           shared with the browser, which edits a local draft
  -> src/store.ts          persistence only: read/write data/layouts.json
  -> src/settings.ts       deep merge - shared with the browser
  -> src/types.ts          the document's shape - shared with the browser

client/  (React + TS, bundled by webpack into public/editor/, served at /editor)
```

`context` is a **singleton**: the loaded document, which layout is current
(the first one, for now), the live per-area state, and the panel. State and
the canvas persist as long as the Node process is alive.

**There is no longer anything inside the server driving content.** The
hardcoded HH:MM digit-box clock that used to live in `src/logic.ts` is gone;
a clock is now just a layout with two text areas, and whatever wants the time
on screen calls `/intake`. The only internal timer left is the whole-panel
refresh (`global.fullRefreshEveryMins`), which exists for panel hygiene, not
for content.

## TypeScript, and what gets built

The **server is never built**. The Pi runs Node 24, which strips TypeScript
types natively, so `node server.ts` is the production entry point - no
transpile step, no build artifacts, no `dist/`.

That has one constraint worth knowing before editing server code: Node
*strips* types, it does not *compile* them, so anything needing generated
code - `enum`, `namespace`, constructor parameter properties, decorators -
will not work. `tsconfig.json` sets `erasableSyntaxOnly` so `tsc` rejects
that syntax rather than letting it reach the device. Relative imports must
also carry a real `.ts` extension (`./logic.ts`), because Node does no path
rewriting.

The dev machine here is on Node 20, which can't do any of that, so `yarn dev`
runs through `tsx` (a devDependency; the device never installs it).

The **client is built**, locally, and only the bundle ships. `client/` is
excluded from the deploy rsync. React, webpack and friends are all
devDependencies for the same reason - `yarn install --production` on the Pi
must not pull a browser toolchain onto an ARM box that never runs it.

| command | does |
|---|---|
| `yarn start` | production server, `node server.ts`, no transpile |
| `yarn dev` | server with reload, via `tsx` |
| `yarn build:client` | production editor bundle into `public/editor/` |
| `yarn watch:client` | same, rebuilding on change |
| `yarn typecheck` | `tsc --noEmit` over server and client - the only thing that checks types, since neither Node nor esbuild do |

## Layout editor

Browser editor for screen layouts at **`/editor`**, backed by a single JSON
document at `data/layouts.json` on the device:

```jsonc
{
  "global":   { "screenWidth": 400, "screenHeight": 300, /* + refresh policy */ },
  "settings": { },                       // defaults for every layout
  "layouts":  {
    "<unique name>": {
      "settings": { },                   // deep-merged over global settings
      "areas": {
        "hours": {
          "type": "text",                // text | image | svg
          "x": 40, "y": 90, "w": 144, "h": 100,
          "z": 1,                        // unique, higher draws later
          "overlapped": ["label"],       // DERIVED - never hand-edit
          "text": "12",                  // default text = initial state
          "font": "Ubuntu", "fontSize": 80,
          "fontWeight": "bold", "align": "right"
        }
      }
    }
  }
}
```

- **`global`** is system configuration - the panel, and the refresh policy.
  Deliberately *not* part of the settings chain: a layout cannot override it.
- **`settings`** at the top level are defaults. A layout's own `settings`
  **deep-merge** over them: nested objects merge key by key, so a layout can
  override `font.size` without restating `font.family`. Arrays and scalars
  replace wholesale. `src/settings.ts` holds that merge and is imported by
  both the server and the browser, so the editor's "Effective settings"
  preview cannot drift from what the server actually resolves. Still edited
  as raw JSON in a textarea.

### Areas

Edited through forms, and by dragging them on the screen preview.

- **Geometry.** `x` and `w` snap to multiples of **8**, because the panel's
  partial-refresh window is addressed in byte columns - an unaligned edge
  shifts the refreshed region relative to the pixel data sent for it. `y`/`h`
  are free. The browser applies the same `normalizeGeometry` the server does,
  so a dragged box never shows a position the store would refuse.
- **`z`** is assigned `max + 1` on create and is unique within a layout.
  Nothing renumbers it; "Bring to front" is the only thing that moves one.
  Duplicate `z` in a hand-edited file is broken up on load.
- **`overlapped`** is **derived** - the areas that intersect this one *and*
  sit above it, recomputed from geometry on every read and every write, with
  whatever the file claimed discarded. Repainting an area is followed by
  repainting everything in this list, transitively: otherwise the area's fresh
  pixels would cover a neighbour that was drawn on top of it. Areas *below*
  are deliberately absent - they were already overdrawn and need nothing. The
  whole set goes out as **one** partial window, not several: two independent
  partial windows back to back reliably left one of them blank on this panel
  (see the sticky-window section).
- **Types.** `text`, `image` and `fractal` are implemented; `svg` renders a dashed
  placeholder and is deliberately unimplemented.
- **Fonts** come from `src/fonts.ts`, which scans the font directories
  (`ESTATION_FONT_DIRS`, colon-separated, or platform defaults), reads each
  file's real family and weight with fontkit, and registers it with
  node-canvas. The editor offers that list, and serves the font files so its
  own preview boxes use the same family the panel will.

### Fractal areas

A `fractal` area draws generated black-and-white art (Julia or Mandelbrot,
`kind`: `random | julia | mandelbrot`) and swaps in a new picture every
`intervalMins` minutes (0 = timer off). The picture is a pure function of the
area's state `seed`, so overlap repaints show the same art; the timer just
writes a random seed through the normal state path, and the processor repaints
only that area. `dither` and `bias` work as for image areas. Pick a picture by
hand with `/intake/<area>?seed=42`. The editor preview always shows seed 1.
Timers are rebuilt on every Sync & Save; a fresh seed is rolled at boot.

### Image areas

Upload a PNG or JPEG and it is **resized once, on the server**, to fit inside
**twice the panel's dimensions** (800x600 by default), aspect preserved. Big
enough to stay sharp when an area scales it up or the panel is replaced with a
denser one, without parking a 12-megapixel phone photo on a Pi Zero's SD card.
An image already smaller than that box is left alone - upscaling on the way in
would only waste space, since the renderer scales just as well at draw time.

Files live in `data/images/<id>.png`. The id is a hash of the *original*
bytes, so re-uploading the same picture reuses the stored copy instead of
accumulating duplicates. The area JSON holds only that id in `src`.

Uploads are sent as a **raw body** with the file's own Content-Type rather
than multipart - the browser can post a `File` straight through, so the device
needs no form-parsing dependency. Magic bytes are checked; a mislabelled file
is rejected.

**Placement follows CSS `background-image`**, because that is the model
everyone already has for "put this picture in this box":

| field | meaning |
|---|---|
| `posX` / `posY` | `background-position`. **px** offsets from the area's top-left. **%** uses the CSS definition - a percentage of the *leftover* space - so `0%` is flush left/top, `50%` centres, `100%` is flush right/bottom, whatever the image size. |
| `sizeAxis` + `size` | `background-size` along **one** axis only (`width` or `height`). The other axis follows the source's aspect ratio, which is **never** distorted. **%** is relative to the area. |
| `bias` | Grey-level shift applied *before* dithering: positive lightens, negative darkens, range ±128. Photos usually need a nudge to land well on e-paper. Biasing the image rather than the threshold makes one control behave identically for the ordered matrices and the error-diffusion kernels, and for diffusion the shifted value feeds the propagated error too, which keeps the result looking exposed rather than clipped. |

Anything overflowing the area is clipped to it.

**Dithering** (`src/dither.ts`) turns the image into the two colours the panel
actually has. Every algorithm writes pure 0 or 255, so the 1bpp packing in
`epd.ts` is lossless afterwards.

| algorithm | character |
|---|---|
| `threshold` | hard 50% cut. Crisp for line art and logos, blocky for photos. |
| `bayer4`, `bayer8` | *dispersed* ordered matrices - a fine crosshatch. 4x4 coarser, 8x8 smoother. Tileable, no error propagation. |
| `halftone` | *clustered-dot* matrix: mid-tones become a grid of round dots of varying size, like a printed halftone screen. The one that still reads as a photograph from across a room. |
| `floyd-steinberg` | classic error diffusion. The most detail; the default. |
| `atkinson` | diffuses only 6/8 of the error - loses some shadow detail, keeps contrast crisp. The early-Mac look, and it suits e-paper for the same reason. |
| `sierra-lite` | between the two, and the cheapest of the three. |

The error-diffusion kernels run over the area's whole rectangle rather than
just where the image landed, so the diffusion stays continuous instead of
restarting at an arbitrary edge.

Decoded images are cached in memory: a layout redraws on every `/intake` that
changes something, and decoding a PNG per repaint on a Pi Zero is exactly what
turns a 2-second refresh into a 5-second one. Rendering is synchronous, so
`images.preload(layout)` warms everything a layout needs and hands it to
`drawLayout` as a plain map.

An area whose `src` is null, or whose file has been deleted, falls back to the
dashed placeholder rather than failing the render.

### State, processors, and /intake

`context.state` is a per-area bag of live values, keyed by area name, seeded
from each area's defaults (a text area starts at its default `text`; image and
svg carry nothing yet). It is **not** persisted - it is what `/intake` writes.

**Editing a layout never writes state.** An area's default applies on the
preview, and from startup *until something speaks for that area from outside*.
The context tracks which areas `/intake` has claimed: an unclaimed area keeps
following its default, so editing default text shows up on the panel at the
next sync; once `/intake` has set it, the live value wins and editing the
default no longer disturbs the screen.

`context.setState(areaName, patch)` merges the patch, then hands `(next,
previous, ctx)` to that area type's **processor**. The processor decides
whether the panel is touched; `src/processors.ts` is where custom ones will
plug in. Text's processor compares the *rendered string*, so a caller polling
every few seconds with an unchanged value costs nothing, and sending `14`
after `"14"` changes the stored type but not a pixel.

If the hardware push fails, the state is rolled back to `previous`. Otherwise
it would claim a value the panel never showed, and the next identical call
would be skipped as "unchanged" - losing the update until something else
happened to repaint that area.

### Editor layout

The layout list is a **collapsible floating menu** in the top bar rather than a
sidebar: it closes as soon as a layout is picked, so the full width goes to the
preview and the area form, which sit **side by side**. Below them are the
layout's settings, the read-only effective settings, and a read-only dump of
the stored layout JSON - useful for seeing the derived `z` and `overlapped`
without opening the file on the device.

Form fields commit **while you type**, debounced ~220ms, so the preview tracks
the keystrokes. Each field stops accepting incoming prop updates once touched;
without that, the round-trip after each commit would rewrite the input from the
server's normalized value mid-word and move the caret.

### The draft model, preview, and Sync & Save

The screen zone layers **the true render** - a PNG from `/api/editor/layouts/
:name/preview.png`, produced by the exact `drawLayout` that paints the panel -
under draggable boxes. So positioning happens against real fonts and real
output, while dragging stays local and instant. The PNG is cache-busted by a
version counter bumped on every save.

The preview always renders the layout's **defaults**, never live state. It is
a design surface: you need to see the default text you just typed, not
whatever value `/intake` last pushed over it. It is always on - there is no
toggle.

**The editor edits a local draft.** The whole document lives in the browser
and nothing - not the file, not the panel - changes until **Sync & Save**
(`POST /api/editor/sync`), which persists the document and then full-clears
and redraws the panel.

That is not just about sparing the display. Per-field writes meant the server
reloaded the document after every keystroke-sized edit, so a half-finished
change was what the *next `/intake`* rendered against: move an area and the
clock would jump there on its next minute, before you had finished
positioning it. A draft cannot leak that way.

Every edit is a pure operation from `src/document.ts`, which the browser and
the server both run - so a draft the editor accepted is a draft the server
will accept, and the incoming document is still re-normalized on save rather
than trusted. There are no granular mutation endpoints any more.

Image uploads are the one exception: they hit the server immediately, because
they are content rather than layout. The area's `src` pointing at one stays in
the draft like everything else.

If the save succeeds but the panel refuses to repaint, that comes back as a
**warning, not an error** - the document really is on disk, and reporting a
failed save would leave the editor offering to write it again.

`data/` is **excluded from the deploy rsync**. The editor writes it on the
device, and `rsync --delete` would otherwise wipe real edits on every deploy.
Set `ESTATION_DATA_DIR` to point somewhere else (useful when running the
server locally).

Running the editor locally: `yarn dev` plus `yarn watch:client`, then
`http://localhost:3333/editor`. The panel font only exists on the Pi, so the
server warns about it and carries on rather than refusing to start - the
editor itself never touches the hardware.

## API

**This is how the panel gets updated:**

```
GET  /intake/:areaName?<field>=<value>[&<field>=<value>...]
POST /intake/:areaName    {"field": value}
```

Writes those fields into the area's state; its processor decides whether
anything is repainted. The response carries the resulting state and
`refreshed` - `null` when nothing needed drawing, otherwise the mode, the
areas actually repainted (including any pulled in by overlap) and the pushed
window.

Query values stay **strings**, deliberately. Coercing `"14"` to a number looks
tidy until `"09"` becomes `9` and the clock loses its leading zero. Send a
POST body if you want real JSON types.

```
$ curl 'http://board:3333/intake/hours?text=14'
{"success":true,"area":"hours","state":{"text":"14"},
 "refreshed":{"mode":"partial","areas":["hours"],"window":{"x":40,...}}}

$ curl 'http://board:3333/intake/hours?text=14'      # unchanged
{"success":true,...,"refreshed":null}                # panel not touched
```

Also:

- `GET /api/status` - current layout, its areas, the live state, the globals.
- `GET /api/clear-full` - immediate whole-panel full refresh.

Layout editor API, all under `/api/editor`:

- `GET /store`
- `PUT /global` - `{global}`
- `PUT /settings` - `{settings}` (the global defaults)
- `POST /sync` - `{store}`. **Sync & Save**: persists the whole document, then
  full-clears and redraws the panel. The only endpoint that writes anything or
  touches the glass. Answers `{success, store, warning?}` - `warning` when the
  save landed but the panel did not repaint.
- `POST /preview.png` - `{store, layout}`. The true render of an **unsaved**
  draft; persists nothing.
- `GET /fonts` · `GET /fonts/:id/file`
- `POST /images` - raw PNG/JPEG body, returns `{id, width, height, bytes}`
- `GET /images` · `GET /images/:id` · `DELETE /images/:id`

There are deliberately **no per-field mutation endpoints**. Every document
operation lives in `src/document.ts` as a pure function and runs in the
browser against the draft.

Failures answer `{success: false, message}` with a real status - 400 for a
malformed body or bad name, 404 for an unknown layout/area, 409 for a name
collision.

## Deploying

`yarn deploy` (`scripts/deploy.sh`): typechecks, builds the editor bundle,
rsyncs the project to the Pi (excluding `node_modules`, build artifacts, debug
PNGs, `client/` sources and the `data/` directory), then over SSH runs
`yarn install --production` (native modules like `canvas` must be built for
the Pi's own arch, not copied from your machine) followed by
`post-deployment-script.sh`, which:
1. installs `deploy/e-station-server.service` if it differs from what's on the
   device, and reloads systemd,
2. rebuilds `epd_util` (`make`),
3. restarts the systemd service,
4. waits for the server to answer `/api/status`, and **fails the deploy** with
   `systemctl status` + the journal tail if it never does,
5. calls `/api/clear-full` for a clean baseline, then prints `/api/status`.
   There is no "start the clock" step any more - nothing inside the server
   drives content.

Steps 1 and 4 exist because of one incident worth remembering: the entry point
was renamed `server.js` -> `server.ts` while the systemd unit kept pointing at
the old name. The service crash-looped, and because the readiness loop simply
fell through when every attempt failed and the following calls used `curl -s`,
the deploy still printed its usual output and exited 0. **A deploy that
reports success must mean the server is actually answering** - hence the hard
failure, and hence the unit living in the repo so `ExecStart` cannot drift
from the code again.

## Device access & hardening

SSH is on **port 1113**, not 22, and key-only (`PasswordAuthentication no`,
`PermitRootLogin prohibit-password`) - `/etc/ssh/sshd_config.d/00-hardening.conf`
on the device, sorted to load before DietPi's own `dietpi.conf` drop-in (which
defaults both back to permissive) so it wins. Both `root` and `dietpi` had
real passwords set with password auth wide open when this was found -
disabled rather than rotated, since key auth already covers access.

None of this lives in the repo or survives a re-flash of the SD card; it's
config applied directly on the device (`ssh -p 1113 root@192.168.233.109`).

This came out of the board being found hard-hung (powered on, associated on
Wi-Fi, but completely unresponsive - not a network issue, confirmed by the
`.233` gateway itself responding fine while the board didn't). No root cause
was found because the pre-existing setup only kept logs in RAM, so whatever
caused the freeze was gone by the time it could be inspected. Fixed for next
time:

- **Persistent journald** (`Storage=persistent` in `/etc/systemd/journald.conf`,
  capped at `SystemMaxUse=200M`).
- **DietPi-RAMlog disabled** (2026-09-28) - DietPi mounts `/var/log` as a 50M
  tmpfs and wipes it hourly by default, which silently defeated the persistent
  journal and the heartbeat log until then. Now: tmpfs line commented out in
  `/etc/fstab`, `dietpi-ramlog.service` disabled, `INDEX_LOGGING=0` in
  `/boot/dietpi/.installed`. Backups: `/etc/fstab.bak-2026-09-28`,
  `/root/dietpi.installed.bak-2026-09-28`.
- **Hardware watchdog** (`RuntimeWatchdogSec=15s` in `/etc/systemd/system.conf`)
  - reboots only if the kernel/systemd itself stops. It did *not* fire in the
  2026-09-28 hang (board dead from ~00:12 to ~09:30), so that hang left
  systemd alive while networking and cron (no hourly `fake-hwclock` save
  after 23:17) had stopped.
- **Heartbeat cron**, every minute (`/usr/local/bin/e-station-heartbeat.sh`),
  appending to `/var/log/e-station-heartbeat.log`:
  `<ts> app=OK|FAIL gw=ok|FAIL wlan=<operstate> load=... avail=..M swapused=..M D=[blocked procs]`.
  `gw` is a TCP check to the router's port 53 (the router ignores ping from the
  board's side). Not rotated (logrotate isn't installed), ~80MB/year.

After the next hang: `journalctl -b -1 -e` and the heartbeat log's last lines
show which failed first (app, Wi-Fi, memory, or I/O).

### Root cause: weekly `fstrim` (found 2026-10-05)

Both hangs (2026-09-28 and 2026-10-05) were Monday just after midnight - the
stock `fstrim.timer` (`OnCalendar=weekly`, up to 100 min random delay). On
2026-10-05 `/var/lib/systemd/timers/stamp-fstrim.timer` read `00:10:06`, the
minute the clock froze, while the journal and heartbeat stopped at `00:09:01`
with nothing logged: a discard on this SD card freezes all block I/O, so log
lines die in RAM, and the kernel and systemd stay up, so the watchdog never
fires. Reproduced by hand: `fstrim -v /` at 10:19:29 hung the board within
~30s, and the journal ends that same second.

Fix: `systemctl disable --now fstrim.timer` and `systemctl mask fstrim.service`.
Don't run `fstrim` on this card. A small, lightly written SD card loses
nothing from never trimming.

## Globals

`src/constants.ts` is gone - these live in the document's `global` object now
and are editable from `/editor` without a redeploy. Defaults in
`DEFAULT_GLOBAL` (`src/types.ts`).

| key | default | does |
|---|---|---|
| `screenWidth` / `screenHeight` | 400 / 300 | panel size. Changing it re-clamps every layout's area geometry. |
| `timezoneOffsetMinutes` | 240 | board configuration. Nothing reads it now that content comes from outside - kept for whatever feeds `/intake`. |
| `fullRefreshEveryMins` | 60 | whole-panel refresh on a wall-clock timer, for panel hygiene. `0` disables. |
| `fullRefreshEveryNPartials` | 60 | whole-panel refresh after N partial pushes, to clear accumulated residue. `0` disables. |
| `preClearBeforeRedraw` | `false` | push an extra white frame over an area's window before redrawing. Off: the panel clears old ink itself, see below. |

Both full-refresh triggers exist because partial refreshes leave residue and
nothing else guarantees a clean pass any more - the old clock used to provide
one incidentally at every hour rollover.

## Bugs found and fixed this round (roughly chronological)

Early on the display only worked with a **full** refresh; every attempt at a
**partial** (windowed) refresh produced garbage or didn't update at all.
Working through it top to bottom:

1. **`epd.ts` `canvasToBuffer` read the wrong pixels for any non-(0,0)
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
   the end; `epd.ts` grew `pushFrames(frames)` to stream a batch through a
   single spawned process. `displayBW()` is a one-frame convenience wrapper
   over it.

5. **Race condition between overlapping `refresh()` calls.** Diffing against
   `lastDigits` and painting the canvas is synchronous, but the whole
   operation `await`s once (the hardware push) - if a poll fired before the
   previous one finished, the second read stale `lastDigits`, corrupting
   which digits got touched (symptom: static digits updating, digits
   randomly blanking). Fixed by serializing `refresh()`/`clearFull()`/
   `testTime()` through one queue (`serialized()` in `logic.ts`), the same
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
`logic.ts`) fixed *that* problem, but re-exposed the sticky-window one.

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

In `logic.ts`/`constants.ts`: `FULL_REFRESH_ON_HOUR_CHANGE` (default `false`)
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
changing. Every `/intake` response reports `refreshed.mode` (`partial`,
`full-periodic`, ...) and `partialsSinceFull`, so you can see where it is in
that cycle.

### Regression check

The bug only ever showed up as *narrow after wide*, so that is the ordering to
walk. It needs two **overlapping** areas, so that changing the lower one
pushes a wide window (both areas, via the overlap rule) and changing the upper
one pushes a narrow one. With `hours` (z1) and `label` (z2) overlapping:

```
curl  .../api/clear-full            # clean baseline
curl '.../intake/hours?text=21'     # WIDE:   repaints hours + label
curl '.../intake/label?text=hi'     # NARROW: label only - hours must survive
curl '.../intake/hours?text=22'     # wide again
curl '.../intake/label?text=yo'     # narrow again
```

Each `/intake` response names the areas it actually repainted and the window
it pushed, so the wide/narrow alternation can be confirmed from the JSON
rather than inferred from the glass.

Two things to watch on the panel. The narrow steps catch the sticky window: if
the area *below* the one that changed goes blank or flickers, it's back. Every
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

- `/intake/<area>?text=...` to drive any area by hand; the response says
  whether it repainted and which areas it pulled in.
- `/api/status` for what the server believes is on the panel right now.
- `POST /api/editor/preview.png` with `{store, layout}` for the true render as
  an image, without a browser.
- `epd.ts` saves `paper_partial.png`/`paper_full.png` after every render -
  useful for confirming what the *software* thinks it drew, independent of
  what the panel actually shows.
- `epd_update_util`'s stdout/stderr is captured and surfaces in the API
  error response (`EPaperDisplay._pushFramesToPanel` rejects on nonzero
  exit code with both streams in the message) - check there first if a push
  silently seems to do nothing.
