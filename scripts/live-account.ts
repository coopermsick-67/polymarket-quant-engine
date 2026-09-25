/**
 * Account I/O for the terminal live trader: complete wallet positions, closed
 * trades, collateral, and one settlement pass for a journaled order. Kept apart
 * from the trading loop so each piece stays small and reviewable.
 */
import { AssetType, type ClobClient } from "@polymarket/clob-client-v2";
import { collateralUsdFromRaw } from "../app/lib/collateral";
import type { ClosedPaperTrade } from "../app/lib/engines";
import { decideSettlement, type JournalOrder, type SettlementDecision, type TradeObservation } from "../app/lib/live-order-journal";
import { assertNoComboPositions, comboPositionsUrl, fetchAllWalletPositions, openPositions, positionsUrl, settledPositions, type WalletPosition } from "../app/lib/wallet-positions";

type PositionRow = WalletPosition;
export const DATA_API = "https://data-api.polymarket.com";
export const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));
export const money = (value: number) => `$${value.toFixed(2)}`;
/** A finite number from a JSON number or numeric string, else null. */
export const number = (value: unknown): number | null => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
};

export const fetchWithRetry = async (url: string): Promise<unknown> => {
  let response: Response | null = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      response = await fetch(url, { cache: "no-store", signal: controller.signal });
    } finally { clearTimeout(timer); }
    if (response.ok || ![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) break;
    // This endpoint is read-only, so retry temporary upstream failures before
    // holding a whole scan. Never substitute cached positions for a failed read.
    const retryAfter = Number(response.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(2_000, retryAfter * 1_000)
      : 250 * (2 ** attempt);
    await response.body?.cancel().catch(() => undefined);
    await sleep(delay);
  }
  if (!response?.ok) throw new Error(`Polymarket position lookup returned ${response?.status ?? "no response"} after up to 3 attempts.`);
  return await response.json() as unknown;
};

/** Every wallet position, across all pages; resolved (redeemable) rows are flagged, not dropped. */
export const readPositions = async (wallet: string): Promise<PositionRow[]> => {
  // Combo positions live on a separate endpoint the engine cannot value; refuse rather than under-count.
  assertNoComboPositions(await fetchWithRetry(comboPositionsUrl(DATA_API, wallet)));
  return fetchAllWalletPositions((cursor) => fetchWithRetry(positionsUrl(DATA_API, wallet, cursor)));
};

export const readClosedTrades = async (wallet: string, now: number): Promise<ClosedPaperTrade[]> => {
  const dayStartSeconds = Math.floor(now / 86_400_000) * 86_400;
  const url = new URL(`${DATA_API}/v2/positions`);
  url.searchParams.set("user", wallet);
  url.searchParams.set("status", "CLOSED");
  url.searchParams.set("start", String(dayStartSeconds));
  url.searchParams.set("end", String(Math.floor(now / 1_000)));
  url.searchParams.set("sort_by", "TIMESTAMP");
  url.searchParams.set("sort_direction", "DESC");
  url.searchParams.set("limit", "100");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { cache: "no-store", signal: controller.signal });
    if (!response.ok) throw new Error(`Polymarket closed-position history returned ${response.status}.`);
    const payload = await response.json() as unknown;
    const rows = Array.isArray(payload) ? payload : payload && typeof payload === "object"
      && Array.isArray((payload as Record<string, unknown>).data) ? (payload as { data: unknown[] }).data : null;
    if (!rows) throw new Error("Polymarket closed-position history was unreadable; the live model cannot apply its loss-streak controls.");
    const trades = rows.map((value): ClosedPaperTrade => {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("A closed-position history row was malformed; live loss-streak controls cannot be applied.");
      const row = value as Record<string, unknown>;
      const timestampValue = number(row.last_event_at ?? row.timestamp);
      const pnl = number(row.realized_pnl ?? row.realizedPnl);
      const tokenID = typeof row.token_id === "string" ? row.token_id : null;
      const conditionID = typeof row.condition_id === "string" ? row.condition_id : null;
      const id = tokenID ?? conditionID;
      if (timestampValue === null || pnl === null || !id) throw new Error("A closed-position history row omitted its timestamp, realized P&L, or market ID; live loss-streak controls cannot be applied.");
      const timestamp = timestampValue < 10_000_000_000 ? timestampValue * 1_000 : timestampValue;
      const outcome = typeof row.outcome === "string" && row.outcome.trim().toUpperCase() === "DOWN" ? "DOWN" : "UP";
      const shares = number(row.total_size ?? row.current_size) ?? 0;
      const entryCost = number(row.total_cost_usdc ?? row.entry_cost_usdc) ?? 0;
      const entry = shares > 0 && entryCost > 0 ? entryCost / shares : number(row.avg_price) ?? 0;
      return { id: `wallet-closed:${id}:${timestamp}`, timestamp, marketId: conditionID ?? id,
        marketLabel: String(row.title ?? row.name ?? "Closed Polymarket position"), asset: "CRYPTO", duration: "5m", side: outcome,
        shares, entry, exit: number(row.current_price) ?? 0, pnl, reason: "Polymarket closed-position history" };
    });
    return trades.filter((trade) => trade.timestamp >= dayStartSeconds * 1_000 && trade.timestamp <= now)
      .sort((a, b) => b.timestamp - a.timestamp).slice(0, 100);
  } finally { clearTimeout(timer); }
};

export const readBalance = async (client: ClobClient) => {
  const payload = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  return collateralUsdFromRaw(payload.balance);
};

/** Latest executable book per held token, refreshed on a fixed schedule; the source of position marks. */

/** Capital at risk in open markets; resolved positions are fixed in value and carry no exposure. */
export const openExposureUsd = (positions: PositionRow[]) => openPositions(positions).reduce((sum, position) => sum + position.exposureUsd, 0);

export const redemptionNotice = (positions: PositionRow[]): string | null => {
  const settled = settledPositions(positions);
  if (!settled.length) return null;
  const value = settled.reduce((sum, position) => sum + position.currentValueUsd, 0);
  return `${settled.length} resolved position(s) worth ${money(value)} await redemption. They no longer count as open exposure, but their cash is unavailable until you redeem them on polymarket.com; this trader does not send on-chain redemption transactions.`;
};

export const normalizeTradeStatus = (status: unknown) => String(status ?? "").toUpperCase().replace(/^TRADE_STATUS_/, "");

/**
 * One reconciliation pass for a SETTLING order: the CLOB order record, the
 * status of each of its trades, open orders, and the wallet. A FAK remainder
 * still reported open is cancelled.
 */
export const reconcileJournalOrder = async (client: ClobClient, walletAddress: string, order: JournalOrder) => {
  const [balance, openOrders, positions] = await Promise.all([readBalance(client), client.getOpenOrders(undefined, true), readPositions(walletAddress)]);
  let matchedShares: number | null = null;
  let tradeIds: string[] = order.tradeIds ?? [];
  try {
    const record = await client.getOrder(order.orderID!);
    matchedShares = number(record?.size_matched);
    if (Array.isArray(record?.associate_trades)) tradeIds = record.associate_trades.filter((id): id is string => typeof id === "string" && id.length > 0);
  } catch { /* unreadable this pass; the decision waits */ }
  let orderStillOpen = openOrders.some((open) => open.id === order.orderID);
  const unrelatedOpen = openOrders.filter((open) => open.id !== order.orderID);
  if (unrelatedOpen.length) return { decision: { kind: "HALT", reason: "An unrelated open order appeared while an order was settling." } as SettlementDecision, balance, positions, tradeIds };
  if (orderStillOpen && Date.now() - order.submittedAt > 1_500) {
    await client.cancelOrder({ orderID: order.orderID! }).catch(() => undefined);
    orderStillOpen = (await client.getOpenOrders(undefined, true)).some((open) => open.id === order.orderID);
  }
  const trades: TradeObservation[] = [];
  for (const id of tradeIds) {
    try {
      const rows = await client.getTrades({ id }, true);
      const trade = rows.find((row) => row.id === id);
      if (trade) trades.push({ id, status: normalizeTradeStatus(trade.status), size: number(trade.size) ?? 0 });
    } catch { /* a missing trade keeps the decision waiting */ }
  }
  const walletShares = positions.find((position) => position.tokenID === order.tokenID)?.size ?? 0;
  const decision = decideSettlement({ order, matchedShares, orderStillOpen, trades, walletShares, now: Date.now() });
  return { decision, balance, positions, tradeIds };
};
