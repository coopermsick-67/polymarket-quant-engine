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

/**
 * The next page's cursor, or null when the list is complete. Anything that does
 * not prove completeness throws: a declared further page without a usable
 * cursor, a missing or malformed pagination envelope on a full page, or a
 * non-boolean has_more. A partial wallet must never look like a whole one.
 */
export const nextPositionCursor = (payload: unknown, rowsOnPage: number): string | null => {
  const pagination = payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>).pagination : undefined;
  if (pagination === undefined || pagination === null) {
    if (rowsOnPage >= POSITION_PAGE_LIMIT) throw new Error("A full page of positions arrived without pagination data; live orders are blocked.");
    return null;
  }
  if (typeof pagination !== "object" || Array.isArray(pagination)) throw new Error("Position pagination data was unreadable; live orders are blocked.");
  const record = pagination as Record<string, unknown>;
  if (record.has_more === false) return null;
  if (record.has_more !== true) throw new Error("Position pagination did not say whether more pages exist; live orders are blocked.");
  const cursor = record.next_cursor;
  if (typeof cursor !== "string" || !/^[A-Za-z0-9_\-=.+/]{1,4096}$/.test(cursor)) {
    throw new Error("Polymarket reported more positions without a usable cursor; live orders are blocked.");
  }
  return cursor;
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
  if (!settled && costBasisUsd === null && markValue === null) {
    throw new Error(`Position ${tokenID} has shares but neither a cost nor a price; live orders are blocked until it can be valued.`);
  }
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
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  for (let page = 0; page < MAX_POSITION_PAGES; page += 1) {
    const payload = await fetchPage(cursor);
    const rows = positionRowsFrom(payload);
    if (!rows) throw new Error("Polymarket returned an unreadable position list; live orders are blocked.");
    positions.push(...parseWalletPositionRows(rows));
    const next = nextPositionCursor(payload, rows.length);
    if (!next) return positions;
    if (seenCursors.has(next)) throw new Error("Polymarket position pagination did not advance; live orders are blocked.");
    seenCursors.add(next);
    cursor = next;
  }
  throw new Error("The complete position list could not be established within the page limit; live orders are blocked.");
};

/**
 * The Data API hides positions under 0.1 shares and archived markets by
 * default; both still hold funds and risk, so ask for everything.
 */
export const positionsUrl = (dataApi: string, wallet: string, cursor: string | null) => {
  const url = new URL(`${dataApi}/v2/positions`);
  url.searchParams.set("user", wallet);
  url.searchParams.set("limit", String(POSITION_PAGE_LIMIT));
  url.searchParams.set("filter_amount", "0");
  url.searchParams.set("include_archived", "true");
  if (cursor) url.searchParams.set("cursor", cursor);
  return url.toString();
};

export const comboPositionsUrl = (dataApi: string, wallet: string) => {
  const url = new URL(`${dataApi}/v2/positions/combos`);
  url.searchParams.set("user", wallet);
  url.searchParams.set("limit", "1");
  return url.toString();
};

/**
 * Combo (multi-leg) positions are served separately and this engine cannot
 * value them, so a wallet holding any is refused rather than under-counted.
 */
export const assertNoComboPositions = (payload: unknown) => {
  const rows = positionRowsFrom(payload);
  if (!rows) throw new Error("Combo positions could not be read; live orders are blocked.");
  if (rows.length) throw new Error("This wallet holds combo positions, which the engine cannot value; use a dedicated trading wallet without combos.");
};

export const openPositions = (positions: readonly WalletPosition[]) => positions.filter((position) => !position.settled);
export const settledPositions = (positions: readonly WalletPosition[]) => positions.filter((position) => position.settled);
