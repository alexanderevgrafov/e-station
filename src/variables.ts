// The variable pool and the {name} placeholders that put it into text areas.
// One pool for everything: the sensor poller writes its readings into it, and
// /intake writes whatever the outside world sends. A text area's text is a
// template over the pool, so any area can show any mix of variables.
// Shared with the browser, which lists the variables and shows what a text
// expands to - so nothing here may import node builtins.

// null = a known variable without a value yet (a sensor that has not
// answered); it shows as MISSING. A name absent from the pool is unknown.
export type TVarValue = string | number | null;
export type TVariables = Record<string, TVarValue>;

export interface TReadings {
  // Degrees Celsius. From the AHT20 when it answers, else the BMP280.
  temperature: number | null;
  // Relative humidity, %. AHT20 only.
  humidity: number | null;
  // Station pressure in hPa (not reduced to sea level). BMP280 only.
  pressure: number | null;
  // Date.now() of the last poll that produced anything, null = never.
  at: number | null;
}

export const NO_READINGS: TReadings = { temperature: null, humidity: null, pressure: null, at: null };

// What the editor preview shows when no sensor is attached (the dev machine),
// so a layout can be sized against realistic strings.
export const SAMPLE_READINGS: TReadings = { temperature: 21.4, humidity: 46, pressure: 1013.2, at: null };

interface SensorVarSpec {
  label: string;
  decimals: number;
  value: (r: TReadings) => number | null;
}

// The variables the sensors put into the pool. Units are not part of a
// variable: the text around it carries them, so "{temp}°" and "{temp} C" are
// both just text.
export const SENSOR_VARS = {
  temp: { label: 'temperature, °C', decimals: 1, value: (r) => r.temperature },
  tempF: { label: 'temperature, °F', decimals: 0, value: (r) => (r.temperature === null ? null : (r.temperature * 9) / 5 + 32) },
  humidity: { label: 'relative humidity, %', decimals: 0, value: (r) => r.humidity },
  pressure: { label: 'pressure, hPa', decimals: 0, value: (r) => r.pressure },
  mmHg: { label: 'pressure, mmHg', decimals: 0, value: (r) => (r.pressure === null ? null : r.pressure * 0.750062) },
} satisfies Record<string, SensorVarSpec>;

export type TSensorVarName = keyof typeof SENSOR_VARS;
export const SENSOR_VAR_NAMES = Object.keys(SENSOR_VARS) as TSensorVarName[];

export function isSensorVar(name: string): name is TSensorVarName {
  return Object.hasOwn(SENSOR_VARS, name);
}

// A poll's worth of pool entries. Raw numbers: rounding happens at expansion,
// so {temp:.0} and {temp} can both be served from the same value.
export function sensorVariables(readings: TReadings): TVariables {
  return Object.fromEntries(SENSOR_VAR_NAMES.map((name) => [name, SENSOR_VARS[name].value(readings)]));
}

// Shown in place of a value the sensor has not produced (yet).
export const MISSING = '--';

export const VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isValidVarName(name: string): boolean {
  return VAR_NAME_PATTERN.test(name);
}

// {name} or {name:.decimals}, e.g. {temp} -> "21.4", {temp:.0} -> "21",
// {temp:.2} -> "21.43". The older {name:N}, without the dot, still works.
const TOKEN_PATTERN = /\{([A-Za-z_][A-Za-z0-9_]*)(?::\.?(\d{1,2}))?\}/g;

function formatValue(value: number, decimals: number): string {
  const text = value.toFixed(decimals);
  // toFixed keeps the sign of a value that rounds to zero: -0.04 -> "-0.0".
  return Number(text) === 0 ? (0).toFixed(decimals) : text;
}

// "21.437", " -3 ", "1e3" and "21,4" (decimal comma) read as numbers; "",
// "12:30" and "21.4°" do not.
function parseNumber(text: string): number | null {
  const trimmed = text.trim().replace(/^([+-]?\d+),(\d+)$/, '$1.$2');
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function expandOne(value: TVarValue, name: string, decimals: string | undefined): string {
  if (value === null) return MISSING;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return MISSING;
    const places = decimals !== undefined ? Number(decimals) : isSensorVar(name) ? SENSOR_VARS[name].decimals : null;
    return places === null ? String(value) : formatValue(value, places);
  }
  // Strings are shown as sent - "09" must keep its zero - unless decimals
  // were asked for: then a string holding a number (/intake query values
  // always arrive as strings) is read as a float and rounded. One that is
  // not a number is still shown as sent.
  if (decimals !== undefined) {
    const parsed = parseNumber(value);
    if (parsed !== null) return formatValue(parsed, Number(decimals));
  }
  return value;
}

// Names nobody has set are left exactly as typed, so a typo - or a variable
// the feeder has not sent yet - shows up on the screen instead of silently
// vanishing.
export function expandTokens(text: string, variables: TVariables): string {
  return text.replace(TOKEN_PATTERN, (whole, name: string, decimals: string | undefined) => {
    if (!Object.hasOwn(variables, name)) return whole;
    return expandOne(variables[name] ?? null, name, decimals);
  });
}

export function hasTokens(text: string): boolean {
  TOKEN_PATTERN.lastIndex = 0;
  return TOKEN_PATTERN.test(text);
}

// The variable names a text refers to, each once, in order of appearance.
export function tokenNames(text: string): string[] {
  return [...new Set([...text.matchAll(TOKEN_PATTERN)].map((m) => m[1]!))];
}
