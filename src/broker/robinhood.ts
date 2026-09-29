// The only module that knows Robinhood Trading MCP tool names and field names.
//
// Input AND output schemas: from the real server's tools/list on 2026-09-29
// (docs/robinhood-tools-2026-09-29.json). The mock server used by simulate-session and the tests
// (mock-server.ts) validates every call against those same input schemas.
//
// Envelope handling (unwrap/envelopeData) and the account check are adapted from
// fall_forward_labs agent/src/broker/robinhood.ts @ e29a4c5. Field mapping is new: that file read
// `filled_quantity` and `ref_id` from orders, but the real order schema has `cumulative_quantity`
// and no `ref_id` at all.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ROBINHOOD_MCP_URL } from "../config.js";
import { num, optNum } from "../util.js";
import { storedAuthTransport } from "./robinhood-oauth.js";

export class RobinhoodToolError extends Error {
  /** The tool itself answered with an error: per the tool guides, the order was NOT placed. */
  constructor(public readonly tool: string, message: string) {
    super(`${tool}: ${message}`);
    this.name = "RobinhoodToolError";
  }
}

export class ToolNotAllowedError extends Error {
  constructor(tool: string) {
    super(`refusing to call "${tool}": not on this client's allowlist`);
    this.name = "ToolNotAllowedError";
  }
}

export const READ_TOOLS = [
  "get_accounts",
  "get_portfolio",
  "get_equity_positions",
  "get_equity_orders",
  "get_equity_quotes",
  "get_equity_tradability",
  "get_popular_watchlists",
  "get_watchlist_items",
] as const;
export const TRADE_TOOLS = ["place_equity_order", "cancel_equity_order"] as const;

type McpLike = Pick<Client, "callTool" | "close">;

export async function connect(opts: { transport?: Transport } = {}): Promise<Client> {
  const client = new Client({ name: "fifty", version: "0.1.0" });
  await client.connect(opts.transport ?? (await storedAuthTransport(ROBINHOOD_MCP_URL)));
  return client;
}

export type OrderStatus = "open" | "filled" | "cancelled" | "rejected";

// Every lifecycle state the real schema lists. Unknown states throw (fail closed).
const STATES: Record<string, OrderStatus> = {
  new: "open",
  queued: "open",
  unconfirmed: "open",
  confirmed: "open",
  partially_filled: "open",
  pending_cancelled: "open",
  filled: "filled",
  cancelled: "cancelled",
  partially_filled_rest_cancelled: "cancelled",
  voided: "cancelled",
  rejected: "rejected",
  failed: "rejected",
};

export interface BrokerOrder {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  /** market | limit | stop_market | stop_limit, recovered from type + trigger. */
  kind: string;
  state: string;
  status: OrderStatus;
  quantity?: number;
  filledQty: number;
  avgPrice?: number;
  fees: number;
  notional?: number;
  limitPrice?: number;
  stopPrice?: number;
  placedAgent: string;
  createdAt: string;
  rejectReason?: string;
}

export interface Quote {
  symbol: string;
  bid: number;
  ask: number;
  last: number;
  previousClose: number;
  preMarket?: number;
  /** Oldest of the bid/ask venue timestamps, ms. */
  asOfMs: number;
  state: string;
}

export interface Position {
  symbol: string;
  quantity: number;
  available: number;
  heldForSells: number;
  avgPrice?: number;
}

export interface Tradability {
  symbol: string;
  tradeable: boolean;
  fractional: boolean;
  state?: string;
  halted: boolean;
  accountTypeOk: boolean;
}

export interface AccountInfo {
  accountNumber: string;
  type: string;
  brokerageType?: string;
  agenticAllowed: boolean;
  state?: string;
  unsettledFunds?: number;
}

export interface Portfolio {
  buyingPower: number;
  unleveragedBuyingPower: number;
  cash: number;
  totalValue: number;
}

export interface PlaceRequest {
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit" | "stop_market";
  quantity?: string;
  dollar_amount?: string;
  limit_price?: string;
  stop_price?: string;
  time_in_force: "gfd" | "gtc";
  ref_id: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/** The `data` object of a `{ data, guide }` envelope. Any other top-level key throws. */
export function envelopeData(tool: string, body: Record<string, unknown>): Record<string, unknown> {
  const extra = Object.keys(body).filter((k) => k !== "data" && k !== "guide");
  if (extra.length > 0) throw new Error(`${tool}: unexpected top-level key(s) [${extra.join(", ")}]`);
  if (!isRecord(body.data)) throw new Error(`${tool}: response has no "data" object`);
  return body.data;
}

function unwrap(tool: string, result: CallToolResult): Record<string, unknown> {
  const text = result.content?.find((c): c is { type: "text"; text: string } => c.type === "text")?.text;
  if (result.isError) throw new RobinhoodToolError(tool, text ?? "tool reported an error with no text");
  if (result.structuredContent) return envelopeData(tool, result.structuredContent as Record<string, unknown>);
  if (!text) throw new Error(`${tool}: response has neither structuredContent nor text`);
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error(`${tool}: response JSON is not an object`);
  return envelopeData(tool, parsed);
}

function list(tool: string, data: Record<string, unknown>, field: string): Record<string, unknown>[] {
  const v = data[field];
  if (v === null) return [];
  if (!Array.isArray(v)) throw new Error(`${tool}: expected "${field}" array`);
  return v.map((e, i) => {
    if (!isRecord(e)) throw new Error(`${tool}: ${field}[${i}] is not an object`);
    return e;
  });
}

function orderKind(o: Record<string, unknown>): string {
  const stop = o.trigger === "stop";
  if (o.type === "market") return stop ? "stop_market" : "market";
  if (o.type === "limit") return stop ? "stop_limit" : "limit";
  throw new Error(`unknown order type ${JSON.stringify(o.type)}`);
}

export function parseOrder(tool: string, o: Record<string, unknown>): BrokerOrder {
  const state = str(o.state);
  const status = state ? STATES[state] : undefined;
  if (!status) throw new Error(`${tool}: unrecognized order state ${JSON.stringify(o.state)}; pausing is safer than guessing`);
  const id = str(o.id);
  const symbol = str(o.symbol);
  if (!id || !symbol || (o.side !== "buy" && o.side !== "sell")) throw new Error(`${tool}: order missing id/symbol/side`);
  const filledQty = num(o.cumulative_quantity ?? "0", `${tool} cumulative_quantity`);
  const avgPrice = optNum(o.average_price, `${tool} average_price`);
  if (filledQty > 0 && avgPrice === undefined) throw new Error(`${tool}: order ${id} has fills but no average_price`);
  const dollar = isRecord(o.dollar_based_amount) ? optNum(o.dollar_based_amount.amount, `${tool} dollar_based_amount`) : undefined;
  return {
    id,
    symbol,
    side: o.side,
    kind: orderKind(o),
    state: state!,
    status,
    quantity: optNum(o.quantity, `${tool} quantity`),
    filledQty,
    avgPrice,
    fees: optNum(o.fees, `${tool} fees`) ?? 0,
    notional: dollar,
    limitPrice: optNum(o.price, `${tool} price`),
    stopPrice: optNum(o.stop_price, `${tool} stop_price`),
    placedAgent: str(o.placed_agent) ?? "",
    createdAt: str(o.created_at) ?? "",
    rejectReason: str(o.reject_reason),
  };
}

const MAX_PAGES = 20;

/**
 * Every Robinhood call the runner makes, scoped to one account. The allowlist is fixed at
 * construction: a read-only client (doctor, research) cannot reach place/cancel at all. No
 * transfer, deposit, options or crypto tool is ever on it.
 */
export class Robinhood {
  private readonly allowed: Set<string>;

  constructor(
    private readonly client: McpLike,
    readonly account: string,
    opts: { trading: boolean; timeoutMs: number },
  ) {
    this.allowed = new Set<string>([...READ_TOOLS, ...(opts.trading ? TRADE_TOOLS : [])]);
    this.timeoutMs = opts.timeoutMs;
  }

  private readonly timeoutMs: number;

  async close(): Promise<void> {
    await this.client.close();
  }

  private async call(tool: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.allowed.has(tool)) throw new ToolNotAllowedError(tool);
    if ("account_number" in args && args.account_number !== this.account) throw new Error(`${tool}: account mismatch`);
    try {
      const result = (await this.client.callTool({ name: tool, arguments: args }, undefined, { timeout: this.timeoutMs })) as CallToolResult;
      return unwrap(tool, result);
    } catch (err) {
      // Tool error text can echo arguments; never let the account number reach a log.
      if (err instanceof Error) {
        err.message = err.message.split(this.account).join("<account>");
        if (err.stack) err.stack = err.stack.split(this.account).join("<account>");
      }
      throw err;
    }
  }

  private async paged(tool: string, args: Record<string, unknown>, field: string): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      const data = await this.call(tool, cursor ? { ...args, cursor } : args);
      out.push(...list(tool, data, field));
      cursor = str(data.next);
      if (!cursor) return out;
    }
    throw new Error(`${tool}: still paginating after ${MAX_PAGES} pages; refusing a partial list`);
  }

  /** The configured account, verified agentic_allowed, active and not deactivated. */
  async verifyAccount(): Promise<AccountInfo> {
    const data = await this.call("get_accounts", {});
    const matches = list("get_accounts", data, "accounts").filter((a) => a.account_number === this.account);
    if (matches.length !== 1) throw new Error(`get_accounts: configured account found ${matches.length} times (expected exactly 1)`);
    const a = matches[0]!;
    if (a.agentic_allowed !== true) throw new Error("get_accounts: configured account does not have agentic_allowed=true");
    if (a.deactivated === true || a.permanently_deactivated === true) throw new Error("get_accounts: configured account is deactivated");
    if (a.state !== undefined && a.state !== "active") throw new Error(`get_accounts: configured account state is ${JSON.stringify(a.state)}, not active`);
    return {
      accountNumber: this.account,
      type: str(a.type) ?? "unknown",
      brokerageType: str(a.brokerage_account_type),
      agenticAllowed: true,
      state: str(a.state),
      unsettledFunds: optNum(a.unsettled_funds, "unsettled_funds"),
    };
  }

  /** Masked agentic accounts, to help the user fill in config. Nothing else is read or kept. */
  async agenticAccountsMasked(): Promise<string[]> {
    const data = await this.call("get_accounts", {});
    return list("get_accounts", data, "accounts")
      .filter((a) => a.agentic_allowed === true && typeof a.account_number === "string")
      .map((a) => `••••${(a.account_number as string).slice(-4)} type=${String(a.type)} state=${String(a.state)}`);
  }

  /** US stock symbols on the named Robinhood curated lists (case-insensitive names). Throws when a
   *  named list does not exist, so a typo never silently means "trade nothing" or "trade anything". */
  async listSymbols(names: string[]): Promise<string[]> {
    if (!names.length) return [];
    const lists = list("get_popular_watchlists", await this.call("get_popular_watchlists", {}), "lists");
    const out: string[] = [];
    for (const name of names) {
      const match = lists.find((l) => String(l.display_name).toLowerCase() === name.toLowerCase());
      if (!match || typeof match.id !== "string") throw new Error(`Robinhood list "${name}" not found; available: ${lists.map((l) => String(l.display_name)).join(", ")}`);
      const items = list("get_watchlist_items", await this.call("get_watchlist_items", { list_id: match.id }), "items");
      for (const it of items) {
        const sym = str(it.symbol);
        if (it.object_type === "instrument" && sym && /^[A-Z][A-Z0-9.]{0,9}$/.test(sym) && !out.includes(sym)) out.push(sym);
      }
    }
    return out;
  }

  async portfolio(): Promise<Portfolio> {
    const d = await this.call("get_portfolio", { account_number: this.account });
    if (!isRecord(d.buying_power)) throw new Error("get_portfolio: buying_power is missing; broker state uncertain");
    return {
      buyingPower: num(d.buying_power.buying_power, "buying_power"),
      unleveragedBuyingPower: num(d.buying_power.unleveraged_buying_power, "unleveraged_buying_power"),
      cash: num(d.cash, "cash"),
      totalValue: num(d.total_value, "total_value"),
    };
  }

  async positions(): Promise<Position[]> {
    const rows = await this.paged("get_equity_positions", { account_number: this.account }, "positions");
    return rows.map((p) => {
      const symbol = str(p.symbol);
      if (!symbol) throw new Error("get_equity_positions: row without symbol");
      return {
        symbol,
        quantity: num(p.quantity, "position quantity"),
        available: num(p.shares_available_for_sells, "shares_available_for_sells"),
        heldForSells: num(p.shares_held_for_sells ?? "0", "shares_held_for_sells"),
        avgPrice: optNum(p.average_buy_price, "average_buy_price"),
      };
    });
  }

  /** Agentic orders in the account created at or after `sinceIso`. */
  async orders(sinceIso: string): Promise<BrokerOrder[]> {
    const rows = await this.paged("get_equity_orders", { account_number: this.account, created_at_gte: sinceIso, placed_agent: "agentic" }, "orders");
    return rows.map((o) => parseOrder("get_equity_orders", o));
  }

  async order(id: string): Promise<BrokerOrder | undefined> {
    const data = await this.call("get_equity_orders", { account_number: this.account, order_id: id });
    const rows = list("get_equity_orders", data, "orders");
    if (rows.length > 1) throw new Error("get_equity_orders: order_id filter returned more than one order");
    return rows[0] ? parseOrder("get_equity_orders", rows[0]) : undefined;
  }

  async quotes(symbols: string[]): Promise<Quote[]> {
    const out: Quote[] = [];
    for (let i = 0; i < symbols.length; i += 20) {
      const data = await this.call("get_equity_quotes", { symbols: symbols.slice(i, i + 20) });
      for (const r of list("get_equity_quotes", data, "results")) {
        const q = r.quote;
        if (!isRecord(q) || !str(q.symbol)) continue; // unresolved symbol: absent, not zero
        const times = [str(q.venue_bid_time), str(q.venue_ask_time)].map((t) => (t ? Date.parse(t) : NaN));
        out.push({
          symbol: q.symbol as string,
          bid: num(q.bid_price, "bid_price"),
          ask: num(q.ask_price, "ask_price"),
          last: num(q.last_trade_price, "last_trade_price"),
          previousClose: num(q.adjusted_previous_close ?? q.previous_close, "previous_close"),
          preMarket: optNum(q.last_non_reg_trade_price, "last_non_reg_trade_price"),
          asOfMs: times.some(Number.isNaN) ? 0 : Math.min(...times),
          state: str(q.state) ?? "unknown",
        });
      }
    }
    return out;
  }

  async tradability(symbols: string[], brokerageType: string | undefined): Promise<Tradability[]> {
    const out: Tradability[] = [];
    for (let i = 0; i < symbols.length; i += 10) {
      const data = await this.call("get_equity_tradability", { account_number: this.account, symbols: symbols.slice(i, i + 10) });
      for (const t of list("get_equity_tradability", data, "results")) {
        const perType = Array.isArray(t.account_type_tradabilities) ? t.account_type_tradabilities.filter(isRecord) : [];
        const mine = perType.find((x) => x.account_type === brokerageType);
        const sessions = Array.isArray(t.internal_halt_sessions) ? t.internal_halt_sessions : [];
        out.push({
          symbol: String(t.symbol),
          tradeable: t.tradeable === true,
          fractional: t.fractional_tradability === "tradable",
          state: str(t.state),
          halted: sessions.includes("regular_hours") || (str(t.internal_halt_reason) ?? "") !== "",
          accountTypeOk: mine ? mine.account_type_tradability === "tradable" : true,
        });
      }
    }
    return out;
  }

  async place(req: PlaceRequest): Promise<BrokerOrder> {
    const args: Record<string, unknown> = { account_number: this.account, market_hours: "regular_hours", ...req };
    for (const k of Object.keys(args)) if (args[k] === undefined) delete args[k];
    const data = await this.call("place_equity_order", args);
    if (!isRecord(data.order)) throw new Error("place_equity_order: response has no order object; outcome unknown");
    return parseOrder("place_equity_order", data.order);
  }

  /** true when the broker accepted the cancel request (asynchronous; re-read the order). */
  async cancel(orderId: string): Promise<boolean> {
    const data = await this.call("cancel_equity_order", { account_number: this.account, order_id: orderId });
    return data.accepted === true;
  }
}
