// The end-of-session report. Realized proceeds and unrealized marks are kept apart; "flat" is
// claimed only when the last broker reconcile succeeded and showed no remaining exposure.
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { Books } from "./accounting.js";
import { estSellFees } from "./accounting.js";
import type { Quote } from "./broker/robinhood.js";
import type { Config } from "./config.js";
import { OPEN_STATUSES } from "./guard.js";
import type { SessionState } from "./state.js";
import { cents } from "./util.js";

export interface Report {
  date: string;
  generated_at: string;
  broker_confirmed_flat: boolean;
  initial_capital_usd: number;
  realized_pnl_usd: number;
  unrealized_pnl_usd: number;
  net_pnl_usd: number;
  model_cost_usd: number;
  net_after_model_usd: number;
  ending_value_usd: number;
  fees_usd: number;
  slippage_estimate_usd: number;
  target_usd: number;
  target_reached: boolean;
  entries: number;
  orders: Array<Record<string, unknown>>;
  remaining_positions: Array<{ symbol: string; qty: number; cost_basis: number; mark: number | null; unrealized: number | null }>;
  open_orders: string[];
  flags: string[];
  killed: boolean;
  recovery: boolean;
  notes: string[];
}

export function buildReport(s: SessionState, cfg: Config, b: Books, quotes: Map<string, Quote>, reconciledOk: boolean, now: number): Report {
  let unrealized = 0;
  const remaining = Object.entries(b.holdings).map(([symbol, h]) => {
    const bid = quotes.get(symbol)?.bid;
    const mark = bid && bid > 0 ? bid : null;
    const u = mark === null ? null : cents(h.qty * mark - estSellFees(h.qty, mark) - h.costBasis);
    unrealized += u ?? 0;
    return { symbol, qty: h.qty, cost_basis: cents(h.costBasis), mark, unrealized: u };
  });
  let slippage = 0;
  for (const o of s.orders) {
    if (o.filledQty > 0 && o.avgPrice !== undefined && o.decisionMid !== undefined) {
      slippage += (o.side === "buy" ? o.avgPrice - o.decisionMid : o.decisionMid - o.avgPrice) * o.filledQty;
    }
  }
  const open = s.orders.filter((o) => OPEN_STATUSES.has(o.status));
  const net = cents(b.realizedPnl + unrealized);
  const ending = cents(cfg.boundaries.initial_capital_usd + net);
  return {
    date: s.date,
    generated_at: new Date(now).toISOString(),
    broker_confirmed_flat: reconciledOk && remaining.length === 0 && open.length === 0 && !s.flags.some((f) => f.startsWith("position_mismatch")),
    initial_capital_usd: cfg.boundaries.initial_capital_usd,
    realized_pnl_usd: b.realizedPnl,
    unrealized_pnl_usd: cents(unrealized),
    net_pnl_usd: net,
    model_cost_usd: Number(s.modelUsd.toFixed(4)),
    net_after_model_usd: cents(net - s.modelUsd),
    ending_value_usd: ending,
    fees_usd: b.fees,
    slippage_estimate_usd: cents(slippage),
    target_usd: cfg.target_usd,
    target_reached: remaining.length === 0 && ending >= cfg.target_usd,
    entries: s.entries,
    orders: s.orders.map((o) => ({ id: o.localId, purpose: o.purpose, side: o.side, symbol: o.symbol, type: o.request.type, status: o.status, broker_state: o.brokerState, filled: o.filledQty, avg: o.avgPrice, fees: o.fees, reject_reason: o.rejectReason })),
    remaining_positions: remaining,
    open_orders: open.map((o) => `${o.localId} ${o.side} ${o.symbol} ${o.status}`),
    flags: s.flags,
    killed: s.killed,
    recovery: s.recovery,
    notes: [...s.notes, ...s.researchNotes],
  };
}

export function renderMarkdown(r: Report): string {
  const usd = (x: number) => `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(2)}`;
  const lines = [
    `# Fifty session report: ${r.date}`,
    "",
    `Generated ${r.generated_at}. Broker-confirmed flat: **${r.broker_confirmed_flat ? "yes" : "NO"}**.`,
    "",
    `| | |`,
    `|---|---|`,
    `| Initial capital | ${usd(r.initial_capital_usd)} |`,
    `| Realized P&L (after fees) | ${usd(r.realized_pnl_usd)} |`,
    `| Unrealized P&L (marked at bid, est. exit fees) | ${usd(r.unrealized_pnl_usd)} |`,
    `| Net P&L | ${usd(r.net_pnl_usd)} |`,
    `| Model cost | ${usd(r.model_cost_usd)} |`,
    `| Net after model cost | ${usd(r.net_after_model_usd)} |`,
    `| Fees | ${usd(r.fees_usd)} |`,
    `| Slippage vs decision mid (est.) | ${usd(r.slippage_estimate_usd)} |`,
    `| Ending value | ${usd(r.ending_value_usd)} |`,
    `| Target ${usd(r.target_usd)} reached | ${r.target_reached ? "yes" : "no"} |`,
    `| Entries | ${r.entries} |`,
    "",
  ];
  if (r.remaining_positions.length) {
    lines.push("## Remaining exposure", "", ...r.remaining_positions.map((p) => `- ${p.symbol}: ${p.qty} sh, cost ${usd(p.cost_basis)}, mark ${p.mark ?? "n/a"}, unrealized ${p.unrealized === null ? "n/a" : usd(p.unrealized)}`), "");
  }
  if (r.open_orders.length) lines.push("## Open orders", "", ...r.open_orders.map((o) => `- ${o}`), "");
  if (r.flags.length) lines.push("## Flags at report time", "", ...r.flags.map((f) => `- ${f}`), "");
  lines.push("## Orders", "", "| id | side | symbol | type | status | filled | avg | fees |", "|---|---|---|---|---|---|---|---|",
    ...r.orders.map((o) => `| ${o.id} | ${o.side} | ${o.symbol} | ${o.type} | ${o.status} | ${o.filled} | ${o.avg ?? ""} | ${o.fees} |`), "");
  if (r.notes.length) lines.push("## Notes", "", ...r.notes.map((n) => `- ${n}`), "");
  return lines.join("\n");
}

export function writeReport(dir: string, r: Report): void {
  writeFileSync(path.join(dir, "report.json"), `${JSON.stringify(r, null, 1)}\n`, { mode: 0o600 });
  writeFileSync(path.join(dir, "report.md"), renderMarkdown(r), { mode: 0o600 });
}
