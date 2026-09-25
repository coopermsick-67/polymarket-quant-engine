import assert from "node:assert/strict";
import test from "node:test";
import { assertNoComboPositions, fetchAllWalletPositions, openPositions, parseWalletPositionRows, positionsUrl, settledPositions } from "../app/lib/wallet-positions";

// Field names and shapes as returned by data-api.polymarket.com/v2/positions (checked Sep 2026).
const row = (overrides: Record<string, unknown>) => ({
  token_id: "111", condition_id: "0xabc", current_size: 10, avg_price: 0.5, total_cost_usdc: 5.1, current_price: 0.6,
  current_value: 6, status: "OPEN", redeemable: false, title: "BTC Up or Down", slug: "btc-updown-5m-1", outcome: "Up", ...overrides,
});

test("resolved positions awaiting redemption carry no exposure and are separated from open risk", () => {
  const positions = parseWalletPositionRows([
    row({}),
    row({ token_id: "222", status: "REDEEMABLE", redeemable: true, current_price: 1, current_value: 10 }),
    row({ token_id: "333", status: "REDEEMABLE", redeemable: true, current_price: 0, current_value: 0, outcome: "Down" }),
  ]);
  assert.equal(openPositions(positions).length, 1);
  assert.equal(settledPositions(positions).length, 2);
  assert.deepEqual(settledPositions(positions).map((position) => position.exposureUsd), [0, 0]);
  assert.equal(settledPositions(positions)[0].currentValueUsd, 10);
});

test("open exposure uses the API's total cost, not just size times average price", () => {
  const [position] = parseWalletPositionRows([row({})]);
  assert.equal(position.exposureUsd, 5.1);
  assert.equal(position.side, "UP");
});

test("a position with no recorded cost does not halt the trader; its current value is the exposure", () => {
  const [position] = parseWalletPositionRows([row({ avg_price: 0, total_cost_usdc: 0, current_value: 3 })]);
  assert.equal(position.costBasisUsd, null);
  assert.equal(position.exposureUsd, 3);
});

test("unreadable rows still fail closed", () => {
  assert.throws(() => parseWalletPositionRows([row({ token_id: undefined, asset: undefined })]), /exact token ID/);
  assert.throws(() => parseWalletPositionRows([row({ current_size: "x", size: undefined })]), /size was unreadable/);
});

test("every cursor page is read, and a stuck cursor fails closed", async () => {
  const pages: Record<string, unknown> = {
    first: { data: [row({ token_id: "1" })], pagination: { has_more: true, next_cursor: "c2" } },
    c2: { data: [row({ token_id: "2" })], pagination: { has_more: false, next_cursor: null } },
  };
  const all = await fetchAllWalletPositions(async (cursor) => pages[cursor ?? "first"]);
  assert.deepEqual(all.map((position) => position.tokenID), ["1", "2"]);
  await assert.rejects(fetchAllWalletPositions(async () => ({ data: [], pagination: { has_more: true, next_cursor: "same" } })), /did not advance/);
  assert.match(positionsUrl("https://data-api.polymarket.com", "0x1", "c2"), /cursor=c2/);
});

test("a declared further page without a usable cursor fails closed instead of returning a partial wallet", async () => {
  // The audit's reproduction: has_more with no next_cursor.
  await assert.rejects(fetchAllWalletPositions(async () => ({ data: [row({ token_id: "abc" })], pagination: { has_more: true } })), /without a usable cursor/);
  await assert.rejects(fetchAllWalletPositions(async () => ({ data: [row({})], pagination: { has_more: "yes" } })), /whether more pages exist/);
  await assert.rejects(fetchAllWalletPositions(async () => ({ data: Array.from({ length: 100 }, (_, index) => row({ token_id: String(index) })) })), /without pagination data/);
  const pages: Record<string, unknown> = {
    first: { data: [row({ token_id: "1" })], pagination: { has_more: true, next_cursor: "a" } },
    a: { data: [row({ token_id: "2" })], pagination: { has_more: true, next_cursor: "b" } },
    b: { data: [row({ token_id: "3" })], pagination: { has_more: true, next_cursor: "a" } },
  };
  await assert.rejects(fetchAllWalletPositions(async (cursor) => pages[cursor ?? "first"]), /did not advance/);
});

test("an open position with shares but neither cost nor price is refused, not valued at zero", () => {
  assert.throws(() => parseWalletPositionRows([{ current_size: "10", token_id: "abc", status: "OPEN" }]), /neither a cost nor a price/);
  assert.throws(() => parseWalletPositionRows([row({ avg_price: "NaN", total_cost_usdc: null, current_value: undefined, current_price: undefined })]), /neither a cost nor a price/);
  const resolved = parseWalletPositionRows([{ current_size: "10", token_id: "abc", status: "REDEEMABLE", current_value: 0 }]);
  assert.equal(resolved[0].settled, true);
});

test("wallet reads ask for dust and archived positions, and refuse wallets holding combos", () => {
  const url = new URL(positionsUrl("https://data-api.polymarket.com", "0x1", null));
  assert.equal(url.searchParams.get("filter_amount"), "0");
  assert.equal(url.searchParams.get("include_archived"), "true");
  assert.doesNotThrow(() => assertNoComboPositions({ data: [], pagination: { has_more: false, next_cursor: null } }));
  assert.throws(() => assertNoComboPositions({ data: [{ id: "combo" }] }), /combo positions/);
  assert.throws(() => assertNoComboPositions({ error: "x" }), /could not be read/);
});
