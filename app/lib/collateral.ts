/** Collateral (USDC / pUSD) has six decimals on-chain. */
export const COLLATERAL_DECIMALS = 6;

/**
 * Convert the CLOB balance-allowance `balance` field, which is always in raw
 * six-decimal units, to dollars. Guessing the unit from the magnitude read a
 * raw 500,000 ($0.50) as $500,000, so the conversion is unconditional.
 */
export const collateralUsdFromRaw = (value: unknown): number | null => {
  const raw = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(raw) || raw < 0) return null;
  return raw / 10 ** COLLATERAL_DECIMALS;
};
