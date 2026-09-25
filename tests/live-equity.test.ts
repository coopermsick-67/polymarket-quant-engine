import assert from "node:assert/strict";
import test from "node:test";
import { liquidationEquityUsd, rememberHeldBooks, unmarkedHeldTokens, type PositionBook } from "../app/lib/live-equity";
import { parseWalletPositionRows } from "../app/lib/wallet-positions";
import { book, marketWith } from "./market-fixture";

const NOW = 1_800_000_000_000;
const FEE = { rate: 0.07, exponent: 1, feesEnabled: true, source: "CLOB" as const };
const row = (overrides: Record<string, unknown>) => ({
  token_id: "up", condition_id: "0xabc", current_size: 10, avg_price: 0.5, total_cost_usdc: 5.1, current_price: 0.6,
  current_value: 6, status: "OPEN", redeemable: false, title: "BTC Up or Down", slug: "btc-updown-5m-1", outcome: "Up", ...overrides,
});
const equity = (balance: number, positions: ReturnType<typeof parseWalletPositionRows>, books: ReadonlyMap<string, PositionBook>) =>
  liquidationEquityUsd({ balance, positions, books, serverNow: NOW, fallbackFeeRate: 0.05, maxBookAgeMs: 30_000 });

test("a just-filled position is worth its executable bids after fees once its book is loaded", () => {
  const positions = parseWalletPositionRows([row({})]);
  const books = new Map<string, PositionBook>([["up", { book: book("up", 0.6, 0.61, NOW - 1_000), feeSchedule: FEE }]]);
  // 10 shares at a 0.60 bid, less the 0.07 * 0.6 * 0.4 = 0.0168 taker fee per share.
  assert.ok(Math.abs(equity(20, positions, books) - (20 + 10 * (0.6 - 0.0168))) < 1e-9);
});

test("an open position without a book, or with a stale or invalid one, is valued at zero", () => {
  const positions = parseWalletPositionRows([row({})]);
  assert.equal(equity(20, positions, new Map()), 20);
  assert.equal(equity(20, positions, new Map([["up", { book: book("up", 0.6, 0.61, NOW - 60_000) }]])), 20);
  assert.equal(equity(20, positions, new Map([["up", { book: { ...book("up", 0.6, 0.61, NOW), timestamp: null } }]])), 20);
});

test("resolved positions awaiting redemption count at their fixed value without a book", () => {
  const positions = parseWalletPositionRows([row({ token_id: "won", status: "REDEEMABLE", redeemable: true, current_price: 1, current_value: 10 })]);
  assert.equal(equity(5, positions, new Map()), 15);
});

test("held tokens without a book are reported so the caller can fetch them before trusting equity", () => {
  const positions = parseWalletPositionRows([row({}), row({ token_id: "down", outcome: "Down" }),
    row({ token_id: "won", status: "REDEEMABLE", redeemable: true, current_price: 1, current_value: 10 })]);
  const books = new Map<string, PositionBook>([["up", { book: book("up", 0.6, 0.61, NOW) }]]);
  assert.deepEqual(unmarkedHeldTokens(positions, books), ["down"]);
});

test("scanned market books are kept only for held tokens, and released once the position is gone", () => {
  const books = new Map<string, PositionBook>([["gone", { book: book("gone", 0.5, 0.51, NOW) }]]);
  const market = marketWith(NOW, 0.6, 0.58, 0.6);
  rememberHeldBooks(books, parseWalletPositionRows([row({})]), [market]);
  assert.deepEqual([...books.keys()], ["up"]);
  assert.equal(books.get("up")?.feeSchedule, market.feeSchedule);
  rememberHeldBooks(books, [], [market]);
  assert.equal(books.size, 0);
});

test("a $25 account that just spent most of its cash on a fill still clears the entry floor once the fill is marked", () => {
  // The post-settlement regression: $22 went into 40 shares at 0.55, leaving $3 of cash.
  const positions = parseWalletPositionRows([row({ current_size: 40, total_cost_usdc: 22 })]);
  const unmarked = equity(3, positions, new Map());
  const marked = equity(3, positions, new Map([["up", { book: book("up", 0.54, 0.55, NOW), feeSchedule: FEE }]]));
  assert.equal(unmarked, 3);
  assert.ok(marked > 10, `marked equity ${marked} should clear the $10 floor`);
});
