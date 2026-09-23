// Shared numeric and parsing helpers. Pure functions only: this module is
// imported by the browser, the Worker routes, the headless runner, and tests.

export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export const round = (value: number, digits = 8) => Number(value.toFixed(digits));

export const finiteNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  return null;
};

export const finiteOr = (value: unknown, fallback: number) => finiteNumber(value) ?? fallback;

/** Seconds or milliseconds epoch, or an ISO/date string, to epoch milliseconds. */
export const epochMs = (value: unknown): number | null => {
  const numeric = finiteNumber(value);
  if (numeric !== null) return numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

export const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

/** Gamma encodes some arrays as JSON strings (`"[\"Up\",\"Down\"]"`). */
export const jsonArray = (value: unknown): string[] => {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
};

export const mean = (values: number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0);

export const standardDeviation = (values: number[]): number | null => {
  if (values.length < 2) return null;
  const center = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - center) ** 2, 0) / (values.length - 1));
};

/** Abramowitz-Stegun 26.2.17, absolute error < 7.5e-8. */
export const normalCdf = (value: number): number => {
  if (value === Infinity) return 1;
  if (value === -Infinity) return 0;
  const absolute = Math.abs(value);
  const t = 1 / (1 + 0.2316419 * absolute);
  const density = 0.3989422804014327 * Math.exp(-0.5 * absolute * absolute);
  const tail = density * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return value >= 0 ? 1 - tail : tail;
};

export const logit = (p: number) => {
  const safe = clamp(p, 1e-6, 1 - 1e-6);
  return Math.log(safe / (1 - safe));
};

export const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));

/** Wilson score interval for a binomial proportion (95% by default). */
export const wilsonInterval = (successes: number, trials: number, z = 1.96): [number, number] | null => {
  if (trials <= 0) return null;
  const p = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const center = (p + (z * z) / (2 * trials)) / denominator;
  const half = (z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) / denominator;
  return [Math.max(0, center - half), Math.min(1, center + half)];
};

export const toBase64Url = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};

export const fromBase64Url = (value: string) => {
  const normalized = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const decoded = atob(normalized);
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
};

/** Round a price down (or up) to the market tick without floating-point drift. */
export const roundToTick = (price: number, tick: number, direction: "down" | "up") => {
  if (!(tick > 0)) return price;
  const steps = price / tick;
  const snapped = direction === "down" ? Math.floor(steps + 1e-9) : Math.ceil(steps - 1e-9);
  const decimals = Math.max(0, Math.ceil(-Math.log10(tick)));
  return Number((snapped * tick).toFixed(decimals));
};
