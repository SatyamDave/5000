// The replaceable strategy interface. A strategy only PROPOSES; guard.ts decides whether a
// proposal may become an order, and engine.ts owns every broker call. A strategy never sees the
// broker, the account number, credentials or configuration boundaries.
import type { Quote, Tradability } from "../broker/robinhood.js";
import type { Config } from "../config.js";

export interface Evidence {
  source: string; // e.g. "get_equity_quotes"
  symbol?: string;
  at: string; // ISO timestamp of the data point (venue time where the broker gives one)
  value: string;
}

export interface EntryProposal {
  symbol: string;
  notionalUsd: number;
  stopPrice: number;
  targetPrice: number;
  reason: string;
  evidence: Evidence[];
}

export interface ResearchInput {
  now: number;
  quotes: Quote[];
  tradability: Tradability[];
  config: Config["strategy"];
  universe: string[];
}

export interface ResearchResult {
  watchlist: string[];
  notes: string[];
}

export interface TickInput {
  now: number;
  openMs: number;
  quotes: Map<string, Quote>;
  watchlist: string[];
  /** Symbols the experiment currently holds or has an open order in. */
  busy: Set<string>;
  /** Cash the experiment may spend on the next entry (already net of reserves and limits). */
  spendableUsd: number;
  config: Config["strategy"];
  /** Strategy-owned state, persisted in session.json between ticks and restarts. */
  memory: Record<string, unknown>;
}

export interface Strategy {
  readonly name: string;
  readonly description: string;
  research(input: ResearchInput): ResearchResult;
  /** Zero or more entry proposals. [] is NO_TRADE. */
  onTick(input: TickInput): EntryProposal[];
  /** Told when an entry proposal actually became a submitted order. */
  onEntrySubmitted(memory: Record<string, unknown>, symbol: string): void;
}
