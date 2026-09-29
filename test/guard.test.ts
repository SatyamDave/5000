import assert from "node:assert/strict";
import { test } from "node:test";
import { books } from "../src/accounting.js";
import type { Quote, Tradability } from "../src/broker/robinhood.js";
import { clampReview } from "../src/decider/claude.js";
import { checkEntry, entryBlock, quoteProblem, sizeExit, spendable } from "../src/guard.js";
import { freshState } from "../src/state.js";
import type { LocalOrder } from "../src/state.js";
import { testConfig } from "./helpers.js";

const NOW = Date.parse("2026-09-30T15:00:00Z");
const quote = (over: Partial<Quote> = {}): Quote => ({ symbol: "SIMA", bid: 9.99, ask: 10.01, last: 10, previousClose: 9.5, asOfMs: NOW - 1000, state: "active", ...over });
const trad = (over: Partial<Tradability> = {}): Tradability => ({ symbol: "SIMA", tradeable: true, fractional: true, halted: false, accountTypeOk: true, ...over });
const proposal = { symbol: "SIMA", notionalUsd: 1000, stopPrice: 9.5, targetPrice: 11, reason: "t", evidence: [] };

function state() {
  const s = freshState("2026-09-30", "x", NOW);
  s.phase = "ACTIVE";
  s.watchlist = ["SIMA"];
  s.universe = ["SIMA"];
  return s;
}

function order(over: Partial<LocalOrder>): LocalOrder {
  return { localId: "o", ref_id: "r", purpose: "entry", symbol: "SIMA", side: "buy", request: { symbol: "SIMA", side: "buy", type: "market", time_in_force: "gfd", ref_id: "r" }, reservedUsd: 0, status: "filled", filledQty: 0, fees: 0, submittedAt: NOW, updatedAt: NOW, resends: 0, ...over };
}

test("overspend: a proposal larger than experiment cash is cut to capital minus reserve", () => {
  const cfg = testConfig((c) => { c.execution.prefer_whole_shares = false; });
  const r = checkEntry({ proposal, cfg, state: state(), books: books([]), buyingPower: 5000, quote: quote(), tradability: trad(), now: NOW });
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.type === "market" && r.dollar_amount, 49.5); // $50 capital, $0.50 reserve, despite $5,000 buying power
});

test("overspend: broker buying power below capital caps the entry", () => {
  const r = checkEntry({ proposal, cfg: testConfig((c) => { c.execution.prefer_whole_shares = false; }), state: state(), books: books([]), buyingPower: 20, quote: quote(), tradability: trad(), now: NOW });
  assert.equal(r.ok && r.type === "market" && r.dollar_amount, 19.5);
});

test("overspend: a second entry is refused while one is still open", () => {
  const s = state();
  s.orders.push(order({ status: "open", reservedUsd: 30 }));
  const r = checkEntry({ proposal: { ...proposal, symbol: "SIMA" }, cfg: testConfig(), state: s, books: books(s.orders), buyingPower: 50, quote: quote(), tradability: trad(), now: NOW });
  assert.equal(r.ok, false);
});

test("reinvestment: realized gains raise spendable cash; losses lower it", () => {
  const cfg = testConfig();
  const win = [order({ filledQty: 5, avgPrice: 10 }), order({ side: "sell", filledQty: 5, avgPrice: 14, fees: 0.02 })];
  assert.equal(spendable(cfg, books(win), 1000), 69.48);
  const loss = [order({ filledQty: 5, avgPrice: 10 }), order({ side: "sell", filledQty: 5, avgPrice: 6 })];
  assert.equal(spendable(cfg, books(loss), 1000), 29.5);
});

test("whole-share instruments get a collared limit order and at least one share", () => {
  const p = { ...proposal, stopPrice: 29, targetPrice: 99 };
  const r = checkEntry({ proposal: p, cfg: testConfig(), state: state(), books: books([]), buyingPower: 50, quote: quote({ bid: 30, ask: 30.02 }), tradability: trad({ fractional: false }), now: NOW });
  assert.equal(r.ok && r.type === "limit" && r.quantity, 1);
  assert.equal(r.ok && r.type === "limit" && r.limit_price, 30.08); // ask + 0.2% collar
  const tooDear = checkEntry({ proposal: p, cfg: testConfig(), state: state(), books: books([]), buyingPower: 50, quote: quote({ bid: 80, ask: 80.05 }), tradability: trad({ fractional: false }), now: NOW });
  assert.equal(tooDear.ok, false);
});

test("stale, crossed, wide and future quotes are rejected", () => {
  const cfg = testConfig();
  assert.match(quoteProblem(quote({ asOfMs: NOW - 60_000 }), cfg, NOW)!, /stale/);
  assert.match(quoteProblem(quote({ bid: 10.1, ask: 10 }), cfg, NOW)!, /invalid/);
  assert.match(quoteProblem(quote({ bid: 9, ask: 11 }), cfg, NOW)!, /spread/);
  assert.match(quoteProblem(quote({ asOfMs: NOW + 120_000 }), cfg, NOW)!, /future/);
  assert.match(quoteProblem(quote({ bid: 0, ask: 0 }), cfg, NOW)!, /invalid/);
  assert.equal(quoteProblem(quote(), cfg, NOW), undefined);
});

test("symbols outside the universe/watchlist and halted symbols are refused", () => {
  const cfg = testConfig();
  assert.equal(checkEntry({ proposal: { ...proposal, symbol: "EVIL" }, cfg, state: state(), books: books([]), buyingPower: 50, quote: quote({ symbol: "EVIL" }), tradability: trad(), now: NOW }).ok, false);
  assert.equal(checkEntry({ proposal, cfg, state: state(), books: books([]), buyingPower: 50, quote: quote(), tradability: trad({ halted: true }), now: NOW }).ok, false);
});

test("entry blocks: kill, pause, flags, unknown orders, cutoff", () => {
  const cfg = testConfig();
  const close = Date.parse("2026-09-30T20:00:00Z");
  assert.equal(entryBlock(state(), cfg, NOW, close, false), undefined);
  assert.match(entryBlock({ ...state(), killed: true }, cfg, NOW, close, false)!, /kill/);
  assert.match(entryBlock(state(), cfg, NOW, close, true)!, /paused/);
  assert.match(entryBlock({ ...state(), flags: ["auth_expired"] }, cfg, NOW, close, false)!, /uncertain/);
  const s = state();
  s.orders.push(order({ status: "unknown" }));
  assert.match(entryBlock(s, cfg, NOW, close, false)!, /unknown/);
  assert.match(entryBlock(state(), cfg, close - 10 * 60_000, close, false)!, /cutoff/);
});

test("exits never sell baseline shares or more than the broker says is available", () => {
  const b = books([order({ filledQty: 2.5, avgPrice: 10 })]);
  assert.equal(sizeExit("SIMA", b, 100), 2.5); // account holds 100 incl. 97.5 baseline; sells only 2.5
  assert.equal(sizeExit("SIMA", b, 1), 1);
  assert.equal(sizeExit("SIMB", b, 100), 0);
});

test("model review can only shrink risk", () => {
  const p = { ...proposal, notionalUsd: 40 };
  assert.equal(clampReview(p, { action: "APPROVE", notional_usd: 9999, stop_price: 1, target_price: 12, reason: "" })!.notionalUsd, 40);
  assert.equal(clampReview(p, { action: "APPROVE", notional_usd: 10, stop_price: 1, target_price: 12, reason: "" })!.stopPrice, 9.5);
  assert.equal(clampReview(p, { action: "APPROVE", notional_usd: 10, stop_price: 9.8, target_price: 12, reason: "" })!.stopPrice, 9.8);
  assert.equal(clampReview(p, { action: "NO_TRADE", notional_usd: 10, stop_price: 9.8, target_price: 12, reason: "" }), undefined);
});

test("prefer_whole_shares: buys whole shares when one fits, fractional dollars when none does", () => {
  const whole = checkEntry({ proposal: { ...proposal, stopPrice: 9, targetPrice: 20 }, cfg: testConfig(), state: state(), books: books([]), buyingPower: 50, quote: quote(), tradability: trad(), now: NOW });
  assert.equal(whole.ok && whole.type === "limit" && whole.quantity, 4); // 49.50 / 10.03 -> 4 shares
  assert.ok(whole.ok && whole.reserved <= 49.5);
  const pricey = checkEntry({ proposal: { ...proposal, stopPrice: 90, targetPrice: 200 }, cfg: testConfig(), state: state(), books: books([]), buyingPower: 50, quote: quote({ bid: 99.99, ask: 100.01 }), tradability: trad(), now: NOW });
  assert.equal(pricey.ok && pricey.type === "market" && pricey.dollar_amount, 49.5);
});
