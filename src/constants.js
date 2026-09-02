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
