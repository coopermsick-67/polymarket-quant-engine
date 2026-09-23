export type Tone = "positive" | "warning" | "negative" | "neutral";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const dollars = (value: number | null | undefined, digits = 2) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? "—"
    : digits === 2
      ? usd.format(value)
      : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);

export const signedDollars = (value: number | null | undefined) =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : `${value >= 0 ? "+" : "−"}${dollars(Math.abs(value))}`;

export const cents = (value: number | null | undefined) =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(1)}¢`;

export const percentage = (value: number | null | undefined, digits = 1) =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(digits)}%`;

export const points = (value: number | null | undefined) =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : `${value >= 0 ? "+" : ""}${(value * 100).toFixed(1)}pt`;

export const timeLeft = (seconds: number | null | undefined) => {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return "—";
  const safe = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safe / 60)
    .toString()
    .padStart(2, "0")}:${(safe % 60).toString().padStart(2, "0")}`;
};

export const formatSpot = (asset: string, value: number | null | undefined) => {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const digits = value >= 10_000 ? 0 : value >= 100 ? 2 : value >= 1 ? 4 : 5;
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
};

export const formatTime = (timestamp: number | null | undefined) => (timestamp ? new Date(timestamp).toLocaleTimeString("en-US", { hour12: false }) : "—");

export const formatAge = (timestamp: number | null | undefined, now: number) => {
  if (!timestamp) return "waiting";
  const age = Math.max(0, now - timestamp);
  return age < 1_000 ? `${age} ms ago` : `${(age / 1000).toFixed(age < 10_000 ? 1 : 0)} s ago`;
};

export const toneFor = (value: number | null | undefined): Tone =>
  value === null || value === undefined || !Number.isFinite(value) ? "neutral" : value >= 0 ? "positive" : "negative";

export const assetTone = (asset: string) => (asset === "BTC" ? "asset-btc" : asset === "ETH" ? "asset-eth" : asset === "SOL" ? "asset-sol" : "asset-xrp");

export const readStoredJson = <T>(key: string): T | null => {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(key);
    return value ? (JSON.parse(value) as T) : null;
  } catch {
    return null;
  }
};

export const writeStoredJson = (key: string, value: unknown) => {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage full or unavailable; state stays in memory */
  }
};

export const downloadText = (filename: string, text: string, type = "text/plain") => {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
};
