// Simulated Robinhood Trading MCP server for simulate-session and the tests. It speaks real MCP
// over an in-memory transport, so the exact client code that talks to Robinhood (robinhood.ts)
// is what gets exercised. Every call is checked against the REAL input schema from
// docs/robinhood-tools-2026-09-29.json and answers in the real output shape. Prices are
// synthetic. No network.
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { projectRoot } from "../paths.js";

export interface MockFaults {
  /** Create the order, then fail the response (the "did it go through?" case). Count of times. */
  placeLostResponse?: number;
  /** Fail the next N placements at the transport level BEFORE creating the order. */
  placeDropBeforeCreate?: number;
  /** The tool rejects the next N placements outright. */
  placeReject?: number;
  /** Market orders fill only this fraction immediately; the rest stays open. */
  partialFillFraction?: number;
  /** Every call fails as if the sign-in expired. */
  authExpired?: boolean;
  /** Every call fails at the transport level. */
  networkDown?: boolean;
  /** Quotes carry venue timestamps this many ms in the past. */
  quoteLagMs?: number;
  /** Market orders never fill (e.g. halted/illiquid); they stay open until cancelled. */
  noFills?: boolean;
}

export interface MockOptions {
  account: string;
  accountType?: "cash" | "limited_margin";
  agenticAllowed?: boolean;
  cash: number;
  /** symbol -> starting price. */
  prices: Record<string, number>;
  /** Price path: symbol, ms -> price. Default: seeded random walk. */
  pricePath?: (symbol: string, ms: number) => number;
  now: () => number;
  /** Pre-existing holdings (not part of the experiment). */
  holdings?: Record<string, number>;
  /** Extra accounts returned by get_accounts. */
  otherAccounts?: string[];
  faults?: MockFaults;
  fractional?: boolean;
  onCall?: (tool: string, args: Record<string, unknown>) => void;
}

interface MockOrder {
  id: string;
  ref_id?: string;
  symbol: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  trigger: "immediate" | "stop";
  state: string;
  quantity: number | null;
  notional: number | null;
  filled: number;
  avg: number | null;
  price: number | null;
  stop_price: number | null;
  fees: number;
  created_at: string;
  tif: string;
}

let schemas: Map<string, Tool> | undefined;
export function realTools(): Map<string, Tool> {
  if (!schemas) {
    const dump = JSON.parse(readFileSync(path.join(projectRoot(), "docs", "robinhood-tools-2026-09-29.json"), "utf8")) as { tools: Tool[] };
    schemas = new Map(dump.tools.map((t) => [t.name, t]));
  }
  return schemas;
}

function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

export function schemaProblems(tool: string, args: Record<string, unknown>): string[] {
  const schema = realTools().get(tool)?.inputSchema;
  if (!schema) return [`unknown tool ${tool}`];
  const props = (schema.properties ?? {}) as Record<string, { type?: string | string[] }>;
  const problems: string[] = [];
  for (const r of schema.required ?? []) if (!(r in args)) problems.push(`missing required "${r}"`);
  for (const [k, v] of Object.entries(args)) {
    const p = props[k];
    if (!p) {
      problems.push(`unknown argument "${k}"`);
      continue;
    }
    const allowed = p.type === undefined ? undefined : Array.isArray(p.type) ? p.type : [p.type];
    if (allowed && !allowed.includes(jsonType(v))) problems.push(`"${k}" is ${jsonType(v)}, schema says ${allowed.join("|")}`);
  }
  return problems;
}

/** Deterministic pseudo-random walk: same symbol and minute always give the same price. */
function defaultPath(start: Record<string, number>): (symbol: string, ms: number) => number {
  return (symbol, ms) => {
    const base = start[symbol] ?? 10;
    const day = Math.floor(ms / 86_400_000);
    const minutes = Math.floor((ms % 86_400_000) / 60_000);
    let seed = ([...symbol].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) + day * 7919) >>> 0;
    let p = base;
    // ponytail: O(minutes of day) per quote; fine for simulation, cache per minute if it gets slow.
    for (let i = 0; i < minutes; i++) {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      p *= 1 + (((seed >>> 8) % 2001) - 1000) / 1000 * 0.003;
    }
    return Math.max(0.5, Math.round(p * 100) / 100);
  };
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const s6 = (x: number) => String(Math.round(x * 1e6) / 1e6);

export class MockRobinhood {
  readonly orders: MockOrder[] = [];
  readonly positions = new Map<string, number>();
  cash: number;
  unsettled = 0;
  readonly calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  faults: MockFaults;
  private readonly pricePath: (symbol: string, ms: number) => number;

  constructor(readonly opts: MockOptions) {
    this.cash = opts.cash;
    this.faults = { ...opts.faults };
    this.pricePath = opts.pricePath ?? defaultPath(opts.prices);
    for (const [s, q] of Object.entries(opts.holdings ?? {})) this.positions.set(s, q);
  }

  price(symbol: string): number {
    return this.pricePath(symbol, this.opts.now());
  }

  quote(symbol: string) {
    const mid = this.price(symbol);
    const half = Math.max(0.01, r2(mid * 0.0005));
    return { bid: r2(mid - half), ask: r2(mid + half), last: mid };
  }

  /** Server half of a linked in-memory pair; returns the client transport. */
  async start() {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const server = new Server({ name: "mock-robinhood", version: "0.0.0" }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...realTools().values()] }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => this.handle(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>));
    await server.connect(serverSide);
    return clientSide;
  }

  private ok(data: Record<string, unknown>): CallToolResult {
    const body = { data, guide: "SIMULATED" };
    return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body };
  }

  private err(text: string): CallToolResult {
    return { isError: true, content: [{ type: "text", text }] };
  }

  handle(tool: string, args: Record<string, unknown>): CallToolResult {
    this.calls.push({ tool, args });
    this.opts.onCall?.(tool, args);
    if (this.faults.networkDown) throw new McpError(ErrorCode.InternalError, "SIMULATED network failure");
    if (this.faults.authExpired) throw new McpError(ErrorCode.InvalidRequest, "SIMULATED 401: sign-in expired");
    const problems = schemaProblems(tool, args);
    if (problems.length) return this.err(`schema: ${problems.join("; ")}`);
    if ("account_number" in args && args.account_number !== this.opts.account) return this.err("account_number is not an agentic account of this user");
    this.step();
    switch (tool) {
      case "get_accounts":
        return this.ok({ accounts: [this.opts.account, ...(this.opts.otherAccounts ?? [])].map((n, i) => ({
          account_number: n, rhs_account_number: `9${i}`, type: i === 0 ? this.opts.accountType ?? "limited_margin" : "margin",
          unsettled_funds: s6(this.unsettled), brokerage_account_type: "individual", is_default: i !== 0,
          agentic_allowed: i === 0 ? this.opts.agenticAllowed ?? true : false, option_level: "", state: "active",
          deactivated: false, permanently_deactivated: false,
        })) });
      case "get_portfolio": {
        const eq = [...this.positions].reduce((a, [s, q]) => a + q * this.price(s), 0);
        const bp = s6(this.buyingPower());
        return this.ok({
          total_value: s6(this.cash + this.unsettled + eq), equity_value: s6(eq), options_value: "0", futures_value: "0", event_contracts_value: "0",
          crypto_value: "0", cash: s6(this.cash), pending_deposits: "0", mutual_funds_value: "0", fixed_income_value: "0", currency: "USD",
          buying_power: { buying_power: bp, unleveraged_buying_power: bp, intraday_buying_power: null, off_intraday_buying_power: null, display_currency: "USD" },
        });
      }
      case "get_equity_positions":
        return this.ok({ positions: [...this.positions].filter(([, q]) => q > 1e-9).map(([symbol, q]) => {
          const held = this.orders.filter((o) => o.symbol === symbol && o.side === "sell" && this.isOpen(o)).reduce((a, o) => a + (o.quantity ?? 0) - o.filled, 0);
          return {
            symbol, quantity: s6(q), intraday_quantity: "0", average_buy_price: null, shares_available_for_sells: s6(Math.max(0, q - held)),
            shares_held_for_sells: s6(held), shares_held_for_stock_grants: "0", shares_held_for_options_events: "0",
            shares_held_for_asset_transfer: "0", shares_pending_from_options_events: "0", type: "long",
          };
        }), next: "" });
      case "get_equity_orders": {
        let rows = this.orders;
        if (typeof args.order_id === "string") rows = rows.filter((o) => o.id === args.order_id);
        if (typeof args.created_at_gte === "string") rows = rows.filter((o) => o.created_at >= (args.created_at_gte as string));
        return this.ok({ orders: [...rows].reverse().map((o) => this.render(o)), next: "" });
      }
      case "get_equity_quotes":
        return this.ok({ results: (args.symbols as string[]).filter((s) => s in this.opts.prices).map((s) => {
          const q = this.quote(s);
          const t = new Date(this.opts.now() - (this.faults.quoteLagMs ?? 0)).toISOString();
          const prev = this.pricePath(s, this.opts.now() - 86_400_000);
          return { quote: {
            symbol: s, last_trade_price: s6(q.last), venue_last_trade_time: t, last_non_reg_trade_price: null, venue_last_non_reg_trade_time: null,
            adjusted_previous_close: s6(prev), previous_close: s6(prev), previous_close_date: null, bid_price: s6(q.bid), venue_bid_time: t,
            ask_price: s6(q.ask), venue_ask_time: t, has_traded: true, state: "active",
          } };
        }) });
      case "get_equity_tradability":
        return this.ok({ results: (args.symbols as string[]).map((s) => ({
          symbol: s, tradeable: s in this.opts.prices, fractional_tradability: this.opts.fractional === false ? "untradable" : "tradable",
          extended_hours_fractional_tradability: false, state: "active",
          account_type_tradabilities: [{ account_type: "individual", account_type_tradability: "tradable" }],
        })) });
      case "get_popular_watchlists":
        return this.ok({ lists: [{ id: "sim-movers", display_name: "Sim movers", item_count: Object.keys(this.opts.prices).length }] });
      case "get_watchlist_items":
        if (args.list_id !== "sim-movers") return this.err("list not found");
        return this.ok({ has_futures_contracts: false, items: [
          ...Object.keys(this.opts.prices).map((s) => ({ object_id: `inst-${s}`, object_type: "instrument", symbol: s })),
          { object_id: "btc", object_type: "currency_pair", symbol: "BTC-USD" },
        ] });
      case "place_equity_order":
        return this.place(args);
      case "cancel_equity_order": {
        const o = this.orders.find((x) => x.id === args.order_id);
        if (!o) return this.err("order not found");
        if (!this.isOpen(o)) return this.err(`order is ${o.state}; cannot cancel`);
        o.state = o.filled > 0 ? "partially_filled_rest_cancelled" : "cancelled";
        return this.ok({ accepted: true });
      }
      default:
        return this.err(`SIMULATED server does not implement ${tool}`);
    }
  }

  private buyingPower(): number {
    const reserved = this.orders.filter((o) => o.side === "buy" && this.isOpen(o))
      .reduce((a, o) => a + (o.notional !== null ? o.notional : ((o.quantity ?? 0) - o.filled) * (o.price ?? this.quote(o.symbol).ask)), 0);
    return Math.max(0, this.cash - reserved);
  }

  private isOpen(o: MockOrder): boolean {
    return ["new", "queued", "confirmed", "unconfirmed", "partially_filled", "pending_cancelled"].includes(o.state);
  }

  private place(args: Record<string, unknown>): CallToolResult {
    if (this.faults.placeReject && this.faults.placeReject > 0) {
      this.faults.placeReject--;
      return this.err("SIMULATED rejection: order not placed");
    }
    if (this.faults.placeDropBeforeCreate && this.faults.placeDropBeforeCreate > 0) {
      this.faults.placeDropBeforeCreate--;
      throw new McpError(ErrorCode.RequestTimeout, "SIMULATED: request lost before reaching the broker");
    }
    const existing = typeof args.ref_id === "string" ? this.orders.find((o) => o.ref_id === args.ref_id) : undefined;
    if (existing) return this.ok({ order: this.render(existing) });
    const type = String(args.type);
    const symbol = String(args.symbol);
    const side = args.side as "buy" | "sell";
    if (!(symbol in this.opts.prices)) return this.err("unknown symbol");
    if (!["market", "limit", "stop_market"].includes(type)) return this.err(`SIMULATED server does not support ${type}`);
    if (args.dollar_amount !== undefined && type !== "market") return this.err("dollar_amount is only valid with type=market");
    const qty = args.quantity !== undefined ? Number(args.quantity) : null;
    const notional = args.dollar_amount !== undefined ? Number(args.dollar_amount) : null;
    if (qty !== null && !Number.isInteger(qty) && type !== "market") return this.err("fractional quantity only for market orders");
    if (side === "sell" && qty !== null && qty > (this.positions.get(symbol) ?? 0) + 1e-9) return this.err("insufficient shares; short selling not allowed");
    if (side === "buy") {
      const cost = notional ?? (qty ?? 0) * (type === "limit" ? Number(args.limit_price) : this.quote(symbol).ask);
      if (cost > this.buyingPower() + 1e-9) return this.err("insufficient buying power");
    }
    const o: MockOrder = {
      id: randomUUID(), ref_id: args.ref_id as string | undefined, symbol, side,
      type: type === "limit" ? "limit" : "market", trigger: type === "stop_market" ? "stop" : "immediate",
      state: "confirmed", quantity: qty, notional, filled: 0, avg: null,
      price: args.limit_price !== undefined ? Number(args.limit_price) : null,
      stop_price: args.stop_price !== undefined ? Number(args.stop_price) : null,
      fees: 0, created_at: new Date(this.opts.now()).toISOString(), tif: String(args.time_in_force ?? "gfd"),
    };
    this.orders.push(o);
    this.step();
    if (this.faults.placeLostResponse && this.faults.placeLostResponse > 0) {
      this.faults.placeLostResponse--;
      throw new McpError(ErrorCode.RequestTimeout, "SIMULATED: response lost after the order was created");
    }
    return this.ok({ order: this.render(o) });
  }

  /** Advance every open order against the current quote. */
  step(): void {
    for (const o of this.orders) {
      if (!this.isOpen(o) || o.state === "pending_cancelled" || this.faults.noFills) continue;
      const q = this.quote(o.symbol);
      if (o.trigger === "stop") {
        if (o.side === "sell" && q.bid <= (o.stop_price ?? 0)) o.trigger = "immediate"; // triggered: now a market order
        else continue;
      }
      const px = o.side === "buy" ? q.ask : q.bid;
      if (o.type === "limit" && (o.side === "buy" ? px > (o.price ?? 0) : px < (o.price ?? Infinity))) continue;
      const want = o.notional !== null ? o.notional / px : (o.quantity ?? 0);
      let fill = want - o.filled;
      if (this.faults.partialFillFraction && o.filled === 0) fill = want * this.faults.partialFillFraction;
      if (o.side === "sell") fill = Math.min(fill, this.positions.get(o.symbol) ?? 0);
      fill = Math.floor(fill * 1e6 + 1e-6) / 1e6; // fractional shares are booked to 6 decimals
      if (fill <= 1e-9) continue;
      this.fill(o, fill, px);
    }
  }

  private fill(o: MockOrder, qty: number, px: number): void {
    const prevNotional = (o.avg ?? 0) * o.filled;
    o.filled += qty;
    o.avg = (prevNotional + qty * px) / o.filled;
    const fee = o.side === "sell" ? Math.ceil(qty * px * 20.6e-6 * 100) / 100 + Math.min(9.79, Math.ceil(qty * 0.000195 * 100) / 100) : 0;
    o.fees = r2(o.fees + fee);
    const pos = Math.round(((this.positions.get(o.symbol) ?? 0) + (o.side === "buy" ? qty : -qty)) * 1e6) / 1e6;
    this.positions.set(o.symbol, Math.abs(pos) < 1e-9 ? 0 : pos);
    if (o.side === "buy") this.cash -= qty * px;
    else if (this.opts.accountType === "cash") this.unsettled += qty * px - fee;
    else this.cash += qty * px - fee;
    o.filled = Math.round(o.filled * 1e6) / 1e6;
    const target = o.notional !== null ? Math.floor((o.notional / px) * 1e6 + 1e-6) / 1e6 : (o.quantity ?? 0);
    o.state = o.filled >= target - 1e-6 ? "filled" : "partially_filled";
    if (o.state === "partially_filled" && this.faults.partialFillFraction) this.faults.partialFillFraction = undefined;
  }

  render(o: MockOrder): Record<string, unknown> {
    return {
      id: o.id, instrument_id: `inst-${o.symbol}`, symbol: o.symbol, side: o.side, type: o.type, state: o.state,
      quantity: o.quantity === null ? (o.filled > 0 ? s6(o.filled) : null) : s6(o.quantity), cumulative_quantity: s6(o.filled),
      price: o.price === null ? null : s6(o.price), stop_price: o.stop_price === null ? null : s6(o.stop_price),
      average_price: o.avg === null ? null : s6(o.avg), fees: s6(o.fees),
      dollar_based_amount: o.notional === null ? null : { amount: o.notional.toFixed(2), currency_code: "USD" },
      time_in_force: o.tif, market_hours: "regular_hours", trigger: o.trigger, placed_agent: "agentic",
      created_at: o.created_at, last_transaction_at: null, executions: [],
    };
  }
}
