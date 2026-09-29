// The experiment's configuration. Two kinds of settings, kept apart on purpose:
//   boundaries  -- account, capital, asset scope, spend limit. Enforced by guard.ts; frozen at
//                  arming (armed.json holds a copy and its sha256); nothing the strategy or the
//                  model returns can change them.
//   strategy    -- sizing, entries, exits, cadence. Explicit and replaceable; still frozen at arming.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { projectRoot } from "./paths.js";

/** The only broker endpoint this code ever connects to for trading. */
export const ROBINHOOD_MCP_URL = "https://agent.robinhood.com/mcp/trading";

const pct = z.number().min(0).max(100);

export const ConfigSchema = z.object({
  boundaries: z.object({
    /** The Agentic account. Must exist in get_accounts with agentic_allowed=true. */
    account_number: z.string().regex(/^[A-Za-z0-9]+$/, "account_number must be alphanumeric"),
    /** Contributed capital. Never topped up; realized gains may be reinvested. */
    initial_capital_usd: z.number().positive().max(100_000),
    /** Only "equity" is implemented; crypto and options are refused (see README). */
    asset_classes: z.array(z.literal("equity")).min(1),
    /** Hard cap on model API spend for the whole session (USD). 0 disables the model. */
    model_spend_limit_usd: z.number().min(0).max(100),
    /** Cash kept aside for fees and rounding; never spent on entries. */
    cash_reserve_usd: z.number().min(0),
  }).strict(),
  /** Scoreboard only: reported, never used to size or loosen anything. */
  target_usd: z.number().positive(),
  /** Symbols the strategy may trade. May be empty when universe_lists is set. */
  universe: z.array(z.string().regex(/^[A-Z][A-Z0-9.]{0,9}$/)).max(40),
  /** Robinhood curated list names (get_popular_watchlists, e.g. "Daily movers"). Their US stock
   *  symbols are added to the universe once, at precheck, and frozen for the session. */
  universe_lists: z.array(z.string().min(1)).max(5),
  strategy: z.object({
    name: z.enum(["opening-range-breakout"]),
    /** Pre-open research keeps this many symbols from the universe. */
    watchlist_size: z.number().int().min(1).max(20),
    /** Research drops symbols trading below this (fractional shares need > $1). */
    min_price_usd: z.number().min(0),
    opening_range_minutes: z.number().int().min(1).max(120),
    breakout_buffer_pct: pct,
    /** Fraction of available experiment cash per entry (concentration). 100 = all-in. */
    position_size_pct: pct.refine((x) => x > 0),
    max_open_positions: z.number().int().min(1).max(20),
    max_entries_per_session: z.number().int().min(1).max(500),
    stop_loss_pct: pct,
    take_profit_pct: pct,
    /** Minimum seconds between entries (trading frequency). */
    min_seconds_between_entries: z.number().int().min(0),
  }).strict(),
  model: z.object({
    /** "none" runs the rules alone. "claude" asks Claude to approve/resize each proposed entry. */
    decider: z.enum(["none", "claude"]),
    model_id: z.string(),
    max_calls: z.number().int().min(0).max(1000),
    usd_per_mtok_input: z.number().min(0),
    usd_per_mtok_output: z.number().min(0),
  }).strict(),
  execution: z.object({
    poll_seconds: z.number().min(1).max(300),
    quote_max_age_seconds: z.number().min(1).max(120),
    max_spread_pct: pct,
    /** Whole-share limit entries are priced this far through the ask. */
    limit_collar_pct: pct,
    /** Unfilled entry orders older than this are cancelled. */
    entry_order_ttl_seconds: z.number().int().min(5),
    call_timeout_ms: z.number().int().min(1000).max(120_000),
    /** An order whose submission outcome is unknown is declared lost after this long unseen. */
    unknown_order_resolve_seconds: z.number().int().min(30),
    /** Place a broker-side stop_market for whole-share positions (survives this process dying). */
    broker_stop_orders: z.boolean(),
    /** Buy whole shares (marketable limit) when at least one fits, so the broker-side stop covers
     *  the position; leftover cash stays idle. false = dollar-amount market orders (fractional). */
    prefer_whole_shares: z.boolean(),
  }).strict(),
  session: z.object({
    precheck_minutes_before_open: z.number().int().min(5).max(240),
    /** No new entries this many minutes before the close. */
    entry_cutoff_minutes_before_close: z.number().int().min(1).max(390),
    /** Every position is sold starting this many minutes before the close. */
    flatten_minutes_before_close: z.number().int().min(1).max(390),
    /** If positions remain after the close, sell them (exit-only) at the next session's open. */
    recovery_flatten_next_session: z.boolean(),
  }).strict().refine((s) => s.entry_cutoff_minutes_before_close >= s.flatten_minutes_before_close, "entry cutoff must come before flatten"),
}).strict().refine((c) => c.universe.length > 0 || c.universe_lists.length > 0, "set universe symbols or universe_lists");

/** Most symbols the resolved universe may hold (quote/tradability batching, research cost). */
export const MAX_UNIVERSE = 60;

export type Config = z.infer<typeof ConfigSchema>;

export function configPath(): string {
  return path.resolve(process.env.FIFTY_CONFIG ?? path.join(projectRoot(), "config", "fifty.json"));
}

export function parseConfig(text: string): Config {
  return ConfigSchema.parse(JSON.parse(text));
}

export function loadConfig(file = configPath()): { config: Config; sha256: string; text: string } {
  const text = readFileSync(file, "utf8");
  return { config: parseConfig(text), sha256: createHash("sha256").update(text).digest("hex"), text };
}
