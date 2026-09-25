/**
 * Polymarket Data API wallet positions (`/v2/positions`), shared by the
 * terminal trader and the web live route.
 *
 * The endpoint returns resolved-but-unredeemed positions (`status:
 * "REDEEMABLE"`) alongside open ones, with snake_case fields and cursor
 * pagination. Resolved positions are not open risk: their value is fixed and
 * only waits for redemption, so they must not count toward exposure or
 * open-position limits.
 */
export type WalletPosition = {
  id: string;
  tokenID: string | null;
  conditionId: string | null;
  slug: string | null;
  title: string;
  /** Outcome label as returned by the API ("Up", "Down", "Yes", ...). */
  outcome: string;
  side: "UP" | "DOWN" | null;
  size: number;
  averagePrice: number | null;
  /** What the position cost, from the API's cost fields; null when the API has no usable cost. */
  costBasisUsd: number | null;
  /** Capital at risk for exposure limits: cost basis for open positions, zero once resolved. */
  exposureUsd: number;
  currentValueUsd: number;
  /** Resolved and waiting for on-chain redemption. */
  settled: boolean;
  status: string;
};

export const POSITION_PAGE_LIMIT = 100;
export const MAX_POSITION_PAGES = 20;

const finiteNumber = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
};

const firstText = (source: Record<string, unknown>, ...keys: string[]): string | null => {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
};

export const positionRowsFrom = (payload: unknown): unknown[] | null => {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && Array.isArray((payload as Record<string, unknown>).data)) {
    return (payload as { data: unknown[] }).data;
  }
  return null;
};

export const nextPositionCursor = (payload: unknown): string | null => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const pagination = (payload as Record<string, unknown>).pagination;
  if (!pagination || typeof pagination !== "object") return null;
  const record = pagination as Record<string, unknown>;
  if (record.has_more !== true) return null;
  return typeof record.next_cursor === "string" && record.next_cursor ? record.next_cursor : null;
};

/** Parse API rows; throws when a row cannot be understood, so live risk never runs on a partial picture. */
export const parseWalletPositionRows = (rows: readonly unknown[]): WalletPosition[] => rows.flatMap((row): WalletPosition[] => {
  if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error("A position row was unreadable; live orders are blocked.");
  const source = row as Record<string, unknown>;
  const size = finiteNumber(source.current_size ?? source.size ?? source.total_size);
  if (size === null || size < 0) throw new Error("Position size was unreadable; live orders are blocked.");
  if (size === 0) return [];
  const tokenID = firstText(source, "token_id", "asset", "asset_id");
  const conditionId = firstText(source, "condition_id", "conditionId", "market");
  const slug = firstText(source, "slug", "event_slug", "eventSlug");
  if (!tokenID) throw new Error("A position has no exact token ID; live orders are blocked until wallet positions are fully readable.");
  const status = (firstText(source, "status") ?? "OPEN").toUpperCase();
  const settled = status === "REDEEMABLE" || status === "RESOLVED" || source.redeemable === true;
  const averagePriceRaw = finiteNumber(source.avg_price ?? source.avgPrice ?? source.average_price);
  const averagePrice = averagePriceRaw !== null && averagePriceRaw > 0 && averagePriceRaw <= 1 ? averagePriceRaw : null;
  const totalCost = finiteNumber(source.total_cost_usdc ?? source.entry_cost_usdc ?? source.initialValue ?? source.initial_value ?? source.costBasis ?? source.cost_basis);
  const costBasisUsd = totalCost !== null && totalCost > 0 ? totalCost : averagePrice !== null ? size * averagePrice : null;
  const currentValue = finiteNumber(source.current_value ?? source.currentValue ?? source.value);
  const currentPrice = finiteNumber(source.current_price ?? source.curPrice);
  const markValue = currentValue !== null && currentValue >= 0 ? currentValue
    : currentPrice !== null && currentPrice >= 0 ? size * currentPrice : null;
  // An open position with no recorded cost (for example a transfer in) is
  // still at risk; count its current value instead.
  const exposureUsd = settled ? 0 : costBasisUsd ?? markValue ?? 0;
  const outcome = firstText(source, "outcome") ?? "—";
  const upper = outcome.toUpperCase();
  return [{
    id: tokenID,
    tokenID,
    conditionId,
    slug,
    title: firstText(source, "title", "question", "name") ?? "Untitled market",
    outcome,
    side: upper === "UP" ? "UP" : upper === "DOWN" ? "DOWN" : null,
    size,
    averagePrice,
    costBasisUsd,
    exposureUsd,
    currentValueUsd: Math.max(0, markValue ?? (settled ? 0 : exposureUsd)),
    settled,
    status,
  }];
});

/**
 * Read every position page. `fetchPage` receives the cursor (null for the first
 * page) and returns the parsed JSON body. Fails closed when the list cannot be
 * completed within the page budget.
 */
export const fetchAllWalletPositions = async (
  fetchPage: (cursor: string | null) => Promise<unknown>,
): Promise<WalletPosition[]> => {
  const positions: WalletPosition[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_POSITION_PAGES; page += 1) {
    const payload = await fetchPage(cursor);
    const rows = positionRowsFrom(payload);
    if (!rows) throw new Error("Polymarket returned an unreadable position list; live orders are blocked.");
    positions.push(...parseWalletPositionRows(rows));
    const next = nextPositionCursor(payload);
    if (!next) return positions;
    if (next === cursor) throw new Error("Polymarket position pagination did not advance; live orders are blocked.");
    cursor = next;
  }
  throw new Error("The complete position list could not be established within the page limit; live orders are blocked.");
};

export const positionsUrl = (dataApi: string, wallet: string, cursor: string | null) => {
  const url = new URL(`${dataApi}/v2/positions`);
  url.searchParams.set("user", wallet);
  url.searchParams.set("limit", String(POSITION_PAGE_LIMIT));
  if (cursor) url.searchParams.set("cursor", cursor);
  return url.toString();
};

export const openPositions = (positions: readonly WalletPosition[]) => positions.filter((position) => !position.settled);
export const settledPositions = (positions: readonly WalletPosition[]) => positions.filter((position) => position.settled);
