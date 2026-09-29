// Experiment P&L from the orders this session placed, and nothing else. Pure, so a restart
// recomputes the same numbers from session.json.
import type { LocalOrder } from "./state.js";
import { cents, shares } from "./util.js";

export interface Holding {
  qty: number;
  costBasis: number;
}

export interface Books {
  holdings: Record<string, Holding>;
  realizedPnl: number; // after fees
  fees: number;
  openCostBasis: number;
  /** Dollars still committed to unfinished buys. */
  reserved: number;
  boughtUsd: number;
  soldUsd: number;
}

/** Orders in submission order; average-cost basis per symbol. */
export function books(orders: LocalOrder[]): Books {
  const holdings: Record<string, Holding> = {};
  let realized = 0, fees = 0, reserved = 0, bought = 0, sold = 0;
  for (const o of orders) {
    const h = (holdings[o.symbol] ??= { qty: 0, costBasis: 0 });
    fees += o.fees;
    if (o.filledQty > 0 && o.avgPrice !== undefined) {
      const notional = o.filledQty * o.avgPrice;
      if (o.side === "buy") {
        h.qty += o.filledQty;
        h.costBasis += notional + o.fees;
        bought += notional;
      } else {
        const q = Math.min(o.filledQty, h.qty);
        const basis = h.qty > 0 ? (h.costBasis * q) / h.qty : 0;
        h.qty = shares(h.qty - q);
        h.costBasis = h.qty > 0 ? h.costBasis - basis : 0;
        realized += notional - o.fees - basis;
        sold += notional;
      }
    } else if (o.side === "buy") {
      h.costBasis += o.fees;
    } else {
      realized -= o.fees;
    }
    const unfinished = o.status === "submitting" || o.status === "unknown" || o.status === "open";
    if (o.side === "buy" && unfinished) reserved += Math.max(0, o.reservedUsd - (o.filledQty * (o.avgPrice ?? 0)));
  }
  for (const [s, h] of Object.entries(holdings)) if (h.qty <= 1e-9) delete holdings[s];
  const openCostBasis = Object.values(holdings).reduce((a, h) => a + h.costBasis, 0);
  return { holdings, realizedPnl: cents(realized), fees: cents(fees), openCostBasis: cents(openCostBasis), reserved: cents(reserved), boughtUsd: cents(bought), soldUsd: cents(sold) };
}

/** Contributed capital + realized P&L, minus what is invested or committed. Never negative. */
export function experimentCash(initialCapital: number, b: Books): number {
  return Math.max(0, cents(initialCapital + b.realizedPnl - b.openCostBasis - b.reserved));
}

/** Estimated regulatory fees on a sale: SEC Section 31 ($20.60 per $1M, since 2026-04-04) and
 *  FINRA TAF ($0.000195/share, cap $9.79, 2026 rate). Robinhood commission is $0. */
export function estSellFees(qty: number, price: number): number {
  const sec = Math.ceil(qty * price * 20.6e-6 * 100) / 100;
  const taf = Math.min(9.79, Math.ceil(qty * 0.000195 * 100) / 100);
  return cents(sec + taf);
}
