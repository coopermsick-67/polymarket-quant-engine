const MARKET_ORDER_ROUNDING: Record<string, { price: number; size: number; amount: number }> = {
  "0.1": { price: 1, size: 2, amount: 3 },
  "0.01": { price: 2, size: 2, amount: 4 },
  "0.005": { price: 3, size: 2, amount: 5 },
  "0.0025": { price: 4, size: 2, amount: 6 },
  "0.001": { price: 3, size: 2, amount: 5 },
  "0.0001": { price: 4, size: 2, amount: 6 },
};

const decimalPlaces = (value: number) => {
  if (Number.isInteger(value)) return 0;
  const pieces = value.toString().split(".");
  return pieces.length > 1 ? pieces[1].length : 0;
};

const roundDown = (value: number, places: number) => decimalPlaces(value) <= places
  ? value : Math.floor(value * 10 ** places) / 10 ** places;

const roundUp = (value: number, places: number) => decimalPlaces(value) <= places
  ? value : Math.ceil(value * 10 ** places) / 10 ** places;

/**
 * Match clob-client-v2's BUY market-order share conversion and rounding.
 * The SDK takes dollars as `amount`, rounds the share quantity to its
 * tick-specific precision, and may round down after its intermediate ceil.
 */
export const sdkMarketBuyShares = (amountUsd: number, price: number, tickSize: string): number => {
  const rounding = MARKET_ORDER_ROUNDING[tickSize];
  if (!rounding || !Number.isFinite(amountUsd) || amountUsd <= 0 || !Number.isFinite(price) || price <= 0) return 0;
  const rawPrice = roundDown(price, rounding.price);
  const rawMakerAmount = roundDown(amountUsd, rounding.size);
  if (rawPrice <= 0 || rawMakerAmount <= 0) return 0;
  let rawTakerAmount = rawMakerAmount / rawPrice;
  if (decimalPlaces(rawTakerAmount) > rounding.amount) {
    rawTakerAmount = roundUp(rawTakerAmount, rounding.amount + 4);
    if (decimalPlaces(rawTakerAmount) > rounding.amount) rawTakerAmount = roundDown(rawTakerAmount, rounding.amount);
  }
  return rawTakerAmount;
};
