// How often (ms) /api/clock polls the current time while running. Polling
// faster than once a minute improves accuracy - without it, a change could
// sit unshown for up to 59s after the real minute ticks over - but refresh()
// only ever does actual work when HH:MM has really changed since the last
// render, so a faster poll doesn't mean extra redraws.
export const CLOCK_POLL_INTERVAL_MS = 10 * 1000;

// Local display offset from UTC, in minutes. Applied directly to the clock's
// UTC time rather than relying on the board's own OS timezone setting, which
// is what was showing UTC instead of local time.
export const TIMEZONE_OFFSET_MINUTES = 4 * 60; // UTC+4

// How long (ms) /api/test?time=HHMM holds the forced value against real
// clock polls, so there's time to look at the result before /api/clock's
// next poll overwrites it with the actual current time.
export const TEST_TIME_HOLD_MS = 30 * 1000;

// Whether a partial push white-clears its window in an extra frame before
// drawing the new content. Off: the panel's own partial refresh diffs its
// "previous" RAM buffer against the "current" one and drives whatever
// changed, in *both* directions, so black->white is handled for free and one
// frame per update is enough.
//
// That only holds when both buffers are kept in sync after every refresh,
// which epd_displayBW_partial2 didn't do until the sticky-window fix: the
// previous buffer ran a push behind, the black->white half of the diff got
// silently dropped, and old ink stayed on screen under the new glyph. That
// symptom is what got "quick" redraws written off as broken - it was the
// same root cause, not a separate problem. Set true to go back to the
// two-frame pre-clear if overlapping ink ever reappears.
export const PRE_CLEAR_BEFORE_REDRAW = false;

// Do a whole-panel full refresh after this many partial pushes (0 disables).
// Every partial refresh leaves a little residue behind, so an e-paper panel
// needs an occasional full pass to clean it out. At roughly one push per
// minute, 60 keeps the once-an-hour cadence that the old hour-rollover
// fallback used to provide, without tying it to a particular digit changing.
export const FULL_REFRESH_EVERY_N_PARTIALS = 60;

// Whether an hour rollover falls back to a whole-panel full refresh instead
// of a partial push. This was the mitigation for the "sticky wide partial
// window" bug: an hour change is the widest window there is (both hour
// digits + the colon + both minute digits), so avoiding it avoided the worst
// case. With the RAM buffer-sync fix in epd_displayBW_partial2 the wide
// window should be safe, and leaving this false is what actually exercises
// it - turn it back on to restore the old sidestep if the panel misbehaves.
export const FULL_REFRESH_ON_HOUR_CHANGE = false;
