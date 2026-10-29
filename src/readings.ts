// Sensor readings and the {token} placeholders that put them into text
// areas. Shared with the browser, which lists the tokens and shows what a
// text expands to - so nothing here may import node builtins.

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

interface TokenSpec {
  label: string;
  decimals: number;
  value: (r: TReadings) => number | null;
}

// Units are not part of the token: the text around it carries them, so
// "{temp}°" and "{temp} C" are both just text.
export const TOKENS = {
  temp: { label: 'temperature, °C', decimals: 1, value: (r) => r.temperature },
  tempF: { label: 'temperature, °F', decimals: 0, value: (r) => (r.temperature === null ? null : (r.temperature * 9) / 5 + 32) },
  humidity: { label: 'relative humidity, %', decimals: 0, value: (r) => r.humidity },
  pressure: { label: 'pressure, hPa', decimals: 0, value: (r) => r.pressure },
  mmHg: { label: 'pressure, mmHg', decimals: 0, value: (r) => (r.pressure === null ? null : r.pressure * 0.750062) },
} satisfies Record<string, TokenSpec>;

export type TTokenName = keyof typeof TOKENS;
export const TOKEN_NAMES = Object.keys(TOKENS) as TTokenName[];

// Shown in place of a value the sensor has not produced (yet).
export const MISSING = '--';

// {name} or {name:decimals}, e.g. {temp} -> "21.4", {temp:0} -> "21".
const TOKEN_PATTERN = /\{([A-Za-z]+)(?::(\d))?\}/g;

function formatValue(value: number, decimals: number): string {
  const text = value.toFixed(decimals);
  // toFixed keeps the sign of a value that rounds to zero: -0.04 -> "-0.0".
  return Number(text) === 0 ? (0).toFixed(decimals) : text;
}

// Unknown names are left exactly as typed, so a typo shows up on the preview
// instead of silently vanishing.
export function expandTokens(text: string, readings: TReadings): string {
  return text.replace(TOKEN_PATTERN, (whole, name: string, decimals: string | undefined) => {
    const spec: TokenSpec | undefined = (TOKENS as Record<string, TokenSpec>)[name];
    if (!spec) return whole;
    const value = spec.value(readings);
    if (value === null || !Number.isFinite(value)) return MISSING;
    return formatValue(value, decimals === undefined ? spec.decimals : Number(decimals));
  });
}

export function hasTokens(text: string): boolean {
  TOKEN_PATTERN.lastIndex = 0;
  return TOKEN_PATTERN.test(text);
}
