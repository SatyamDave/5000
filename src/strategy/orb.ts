// Example strategy for software testing and evaluation: opening-range breakout (long only).
//
// Research (before the open): drop untradeable/halted symbols, rank the rest by the absolute
//   pre-market move vs the prior close, keep `watchlist_size`.
// Opening range: for `opening_range_minutes` after the open, record each symbol's high and low
//   last trade price as seen by polling.
// Entry: after the range, when last > range high * (1 + breakout_buffer_pct), propose a buy of
//   `position_size_pct` of spendable cash. Stop = max(range low, entry * (1 - stop_loss_pct)).
//   Target = entry * (1 + take_profit_pct). One entry per symbol per session.
//
// Assumptions and weaknesses, stated plainly: no edge has been shown for this rule on any data
// here, and no backtest was run. The range is built from polled snapshots, so it misses
// intra-poll extremes. Breakout entries buy after a move, into widening spreads, so slippage is
// adverse by construction. Market orders on fractional shares have no price protection beyond
// the spread check. A 100x day needs a sequence of large wins; this rule does not make that likely.
import type { EntryProposal, ResearchInput, ResearchResult, Strategy, TickInput } from "./types.js";

interface Range { high: number; low: number; n: number }

export const openingRangeBreakout: Strategy = {
  name: "opening-range-breakout",
  description: "Long-only opening-range breakout over a pre-open watchlist ranked by pre-market move.",

  research(input: ResearchInput): ResearchResult {
    const ok = new Set(input.tradability.filter((t) => t.tradeable && !t.halted && t.accountTypeOk && t.state !== "inactive").map((t) => t.symbol));
    const notes: string[] = [];
    const ranked = input.quotes
      .filter((q) => ok.has(q.symbol) && q.previousClose > 0 && q.state === "active" && (q.preMarket ?? q.last) >= input.config.min_price_usd)
      .map((q) => ({ q, move: ((q.preMarket ?? q.last) - q.previousClose) / q.previousClose }))
      .sort((a, b) => Math.abs(b.move) - Math.abs(a.move) || a.q.symbol.localeCompare(b.q.symbol));
    for (const s of input.universe) if (!ok.has(s)) notes.push(`${s}: excluded (not tradeable, halted or not allowed for this account type)`);
    const watchlist = ranked.slice(0, input.config.watchlist_size).map((r) => r.q.symbol);
    for (const r of ranked.slice(0, input.config.watchlist_size)) notes.push(`${r.q.symbol}: pre-open move ${(r.move * 100).toFixed(2)}% vs prior close ${r.q.previousClose}`);
    return { watchlist, notes };
  },

  onTick(input: TickInput): EntryProposal[] {
    const ranges = (input.memory.ranges ??= {}) as Record<string, Range>;
    const entered = (input.memory.entered ??= []) as string[];
    const rangeEnd = input.openMs + input.config.opening_range_minutes * 60_000;
    const out: EntryProposal[] = [];
    for (const symbol of input.watchlist) {
      const q = input.quotes.get(symbol);
      if (!q || q.last <= 0) continue;
      if (input.now < rangeEnd) {
        const r = (ranges[symbol] ??= { high: q.last, low: q.last, n: 0 });
        r.high = Math.max(r.high, q.last);
        r.low = Math.min(r.low, q.last);
        r.n++;
        continue;
      }
      const r = ranges[symbol];
      if (!r || r.n < 2 || entered.includes(symbol) || input.busy.has(symbol)) continue;
      const trigger = r.high * (1 + input.config.breakout_buffer_pct / 100);
      if (q.last <= trigger) continue;
      const notional = Math.floor(input.spendableUsd * (input.config.position_size_pct / 100) * 100) / 100;
      if (notional < 1) continue;
      const entry = q.ask;
      out.push({
        symbol,
        notionalUsd: notional,
        stopPrice: Math.round(Math.max(r.low, entry * (1 - input.config.stop_loss_pct / 100)) * 100) / 100,
        targetPrice: Math.round(entry * (1 + input.config.take_profit_pct / 100) * 100) / 100,
        reason: `last ${q.last} broke opening-range high ${r.high} (+${input.config.breakout_buffer_pct}% buffer = ${trigger.toFixed(4)}) after ${r.n} samples`,
        evidence: [
          { source: "get_equity_quotes", symbol, at: new Date(q.asOfMs).toISOString(), value: `bid ${q.bid} ask ${q.ask} last ${q.last}` },
          { source: "opening_range", symbol, at: new Date(rangeEnd).toISOString(), value: `high ${r.high} low ${r.low} samples ${r.n}` },
        ],
      });
    }
    return out;
  },

  onEntrySubmitted(memory, symbol) {
    const entered = (memory.entered ??= []) as string[];
    if (!entered.includes(symbol)) entered.push(symbol);
  },
};

export const STRATEGIES: Record<string, Strategy> = { [openingRangeBreakout.name]: openingRangeBreakout };
