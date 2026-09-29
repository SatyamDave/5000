// Account boundaries and execution controls, enforced in code. Pure functions: every input is
// passed in, so the tests can drive each rule directly. Nothing a strategy or the model returns
// reaches the broker without passing checkEntry()/sizeExit() first.
import type { Books } from "./accounting.js";
import { experimentCash } from "./accounting.js";
import type { Quote, Tradability } from "./broker/robinhood.js";
import type { Config } from "./config.js";
import type { SessionState } from "./state.js";
import type { EntryProposal } from "./strategy/types.js";
import { floorCents } from "./util.js";

export const OPEN_STATUSES = new Set(["submitting", "unknown", "open"]);

/** Why new entries are blocked right now, or undefined. Exits are never blocked by this. */
export function entryBlock(s: SessionState, cfg: Config, now: number, closeMs: number, paused: boolean): string | undefined {
  if (s.killed) return "kill switch engaged";
  if (paused) return "paused";
  if (s.recovery) return "recovery session: exits only";
  if (s.phase !== "ACTIVE") return `phase ${s.phase}`;
  if (now >= closeMs - cfg.session.entry_cutoff_minutes_before_close * 60_000) return "past entry cutoff";
  if (s.flags.length) return `broker state uncertain: ${s.flags.join(", ")}`;
  if (s.orders.some((o) => o.status === "unknown" || o.status === "submitting")) return "an order's submission outcome is unknown";
  if (s.entries >= cfg.strategy.max_entries_per_session) return "max entries per session reached";
  if (s.lastEntryAt !== undefined && now - s.lastEntryAt < cfg.strategy.min_seconds_between_entries * 1000) return "min time between entries";
  return undefined;
}

export function quoteProblem(q: Quote | undefined, cfg: Config, now: number): string | undefined {
  if (!q) return "no quote";
  if (q.state !== "active") return `instrument state ${q.state}`;
  if (!(q.bid > 0 && q.ask > 0 && q.ask >= q.bid)) return `invalid book bid ${q.bid} ask ${q.ask}`;
  const age = now - q.asOfMs;
  if (!(q.asOfMs > 0) || age > cfg.execution.quote_max_age_seconds * 1000) return `stale quote (${Math.round(age / 1000)}s old)`;
  if (age < -30_000) return "quote timestamp is in the future (clock skew?)";
  const spreadPct = ((q.ask - q.bid) / ((q.ask + q.bid) / 2)) * 100;
  if (spreadPct > cfg.execution.max_spread_pct) return `spread ${spreadPct.toFixed(3)}% > ${cfg.execution.max_spread_pct}%`;
  return undefined;
}

/** The most the next entry may commit: experiment cash and broker buying power, less the reserve. */
export function spendable(cfg: Config, b: Books, buyingPower: number): number {
  const exp = experimentCash(cfg.boundaries.initial_capital_usd, b);
  return Math.max(0, floorCents(Math.min(exp, buyingPower - b.reserved) - cfg.boundaries.cash_reserve_usd));
}

export type EntryOrder =
  | { ok: true; type: "market"; dollar_amount: number; reserved: number }
  | { ok: true; type: "limit"; quantity: number; limit_price: number; reserved: number }
  | { ok: false; reason: string };

/** Turns an approved proposal into exact order terms, or refuses. */
export function checkEntry(args: {
  proposal: EntryProposal;
  cfg: Config;
  state: SessionState;
  books: Books;
  buyingPower: number;
  quote: Quote | undefined;
  tradability: Tradability | undefined;
  now: number;
}): EntryOrder {
  const { proposal: p, cfg, state, books: b, quote: q, tradability: t, now } = args;
  if (!state.universe.includes(p.symbol) || !state.watchlist.includes(p.symbol)) return { ok: false, reason: `${p.symbol} is outside the configured universe/watchlist` };
  if (!t || !t.tradeable || t.halted || !t.accountTypeOk) return { ok: false, reason: `${p.symbol} is not tradeable for this account right now` };
  const qp = quoteProblem(q, cfg, now);
  if (qp) return { ok: false, reason: `${p.symbol}: ${qp}` };
  if (Object.keys(b.holdings).length >= cfg.strategy.max_open_positions && !b.holdings[p.symbol]) return { ok: false, reason: "max open positions" };
  // One entry in flight at a time: two concurrent buys can never both spend the same dollars.
  if (state.orders.some((o) => o.side === "buy" && OPEN_STATUSES.has(o.status))) return { ok: false, reason: "another entry order is still open" };
  if (!(p.stopPrice > 0 && p.stopPrice < q!.ask && p.targetPrice > q!.ask)) return { ok: false, reason: "exit plan must have stop < ask < target" };
  const cap = spendable(cfg, b, args.buyingPower);
  const notional = floorCents(Math.min(p.notionalUsd, cap));
  if (notional < 1) return { ok: false, reason: `spendable $${cap.toFixed(2)} is below the $1 minimum` };
  // Whole shares: a marketable limit through the ask, reserving the worst-case cost.
  const limit = Math.round(q!.ask * (1 + cfg.execution.limit_collar_pct / 100) * 100) / 100;
  const qty = Math.floor(notional / limit);
  if (t.fractional && !(cfg.execution.prefer_whole_shares && qty >= 1)) return { ok: true, type: "market", dollar_amount: notional, reserved: notional };
  if (qty < 1) return { ok: false, reason: `$${notional.toFixed(2)} buys less than one whole share at ${limit} (not fractionable)` };
  return { ok: true, type: "limit", quantity: qty, limit_price: limit, reserved: floorCents(qty * limit + 0.0099) };
}

/** Shares the experiment may sell in `symbol`: its own holding, never the baseline, never short. */
export function sizeExit(symbol: string, b: Books, brokerAvailable: number): number {
  const mine = b.holdings[symbol]?.qty ?? 0;
  return Math.floor(Math.max(0, Math.min(mine, brokerAvailable)) * 1e6 + 1e-6) / 1e6;
}
