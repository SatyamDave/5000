// The session runner: PRECHECK -> RESEARCH -> WAIT_FOR_OPEN -> ACTIVE -> WIND_DOWN -> REPORT ->
// (RECOVERY_WAIT -> exit-only session -> REPORT) -> COMPLETE.
//
// One loop, one process (runner lock in cli.ts), deterministic polling. Every tick reconciles
// against the broker before anything else, so a restart, a sleep, or a lost response is handled
// by the same code path as a normal tick. The model is only called when the rules propose an entry.
import { randomUUID } from "node:crypto";
import { books, estSellFees } from "./accounting.js";
import type { Books } from "./accounting.js";
import { RobinhoodToolError } from "./broker/robinhood.js";
import type { BrokerOrder, PlaceRequest, Position, Quote, Robinhood, Tradability } from "./broker/robinhood.js";
import { isoNy, nextSessionAfter, sessionOn } from "./calendar.js";
import type { Session } from "./calendar.js";
import { MAX_UNIVERSE } from "./config.js";
import type { Config } from "./config.js";
import type { Reviewer } from "./decider/claude.js";
import { checkEntry, entryBlock, OPEN_STATUSES, quoteProblem, sizeExit, spendable } from "./guard.js";
import { buildReport, writeReport } from "./report.js";
import { applyBroker, freshState, Store } from "./state.js";
import type { LocalOrder, SessionState } from "./state.js";
import { STRATEGIES } from "./strategy/orb.js";
import type { EntryProposal, Strategy } from "./strategy/types.js";
import { dec, floorCents } from "./util.js";

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

export interface Controls {
  paused: boolean;
  killed: boolean;
  flatten: boolean;
}

export interface EngineDeps {
  cfg: Config;
  armedSha: string;
  date: string;
  connect: () => Promise<Robinhood>;
  clock: Clock;
  controls: () => Controls;
  notify: (title: string, message: string) => void;
  reviewer?: Reviewer;
  onStatus?: (status: Record<string, unknown>) => void;
  /** Stop the loop after this many iterations (tests). */
  maxIterations?: number;
}

const AUTH_RE = /sign-in|sign in|401|unauthori[sz]ed|fifty login|refresh/i;
const MINUTE = 60_000;

export class Engine {
  readonly store: Store;
  s: SessionState;
  private broker?: Robinhood;
  private readonly strategy: Strategy;
  private quotes = new Map<string, Quote>();
  private trad = new Map<string, Tradability>();
  private brokerPositions = new Map<string, Position>();
  private buyingPower = 0;
  private reconciledOk = false;
  private lastFlagsKey = "";
  private lastNoTrade = "";
  private stopped = false;

  constructor(private readonly d: EngineDeps) {
    this.store = new Store(d.date);
    const strategy = STRATEGIES[d.cfg.strategy.name];
    if (!strategy) throw new Error(`unknown strategy ${d.cfg.strategy.name}`);
    this.strategy = strategy;
    const loaded = this.store.load();
    if (loaded && loaded.armedSha !== d.armedSha) throw new Error("session.json was written under a different armed configuration; refusing to mix them");
    this.s = loaded ?? freshState(d.date, d.armedSha, d.clock.now());
    if (loaded) this.log("restart", { phase: loaded.phase });
    else this.log("session_created", { date: d.date });
  }

  get now(): number {
    return this.d.clock.now();
  }

  private log(event: string, data: Record<string, unknown> = {}): void {
    this.store.log(event, data, this.now);
  }

  private save(): void {
    this.store.save(this.s);
  }

  session(): Session {
    const date = this.s.recovery ? this.s.recoveryDate! : this.s.date;
    const s = sessionOn(date);
    if (!s) throw new Error(`${date} is not an NYSE trading day`);
    return s;
  }

  books(): Books {
    return books(this.s.orders);
  }

  stop(): void {
    this.stopped = true;
  }

  async run(): Promise<SessionState> {
    let iterations = 0;
    while (this.s.phase !== "COMPLETE" && !this.stopped) {
      if (this.d.maxIterations !== undefined && iterations++ >= this.d.maxIterations) break;
      const delay = await this.step();
      this.s.lastTickAt = this.now;
      this.save();
      this.d.onStatus?.(this.status());
      if ((this.s.phase as string) !== "COMPLETE") await this.d.clock.sleep(delay);
    }
    await this.broker?.close().catch(() => undefined);
    return this.s;
  }

  /** One iteration; returns ms to wait before the next. */
  async step(): Promise<number> {
    const c = this.d.controls();
    if (c.killed && !this.s.killed) {
      this.s.killed = true;
      this.log("kill_switch", {});
      this.d.notify("Fifty: kill switch", "New entries blocked; cancelling entry orders; positions still managed.");
    }
    if (this.s.lastTickAt !== undefined) {
      const gap = this.now - this.s.lastTickAt;
      if (gap > Math.max(3 * this.d.cfg.execution.poll_seconds * 1000, 2 * MINUTE)) {
        this.log("clock_gap", { gap_ms: gap, note: "process was suspended (sleep?) or stalled; reconciling before acting" });
        this.d.notify("Fifty: gap detected", `No tick for ${Math.round(gap / 1000)}s (sleep/suspend?). Reconciling.`);
      }
    }
    const sess = this.session();
    const poll = this.d.cfg.execution.poll_seconds * 1000;
    const precheckAt = sess.openMs - this.d.cfg.session.precheck_minutes_before_open * MINUTE;

    switch (this.s.phase) {
      case "PRECHECK": {
        if (this.now < precheckAt) return Math.min(MINUTE, precheckAt - this.now);
        if (this.now >= sess.closeMs) {
          this.log("missed_session", { note: "runner started after the close; nothing was traded" });
          return this.goto("REPORT");
        }
        if (this.now > sess.openMs) this.log("late_start", { minutes_after_open: Math.round((this.now - sess.openMs) / MINUTE) });
        return (await this.precheck()) ? this.goto("RESEARCH") : MINUTE;
      }
      case "RESEARCH":
        return (await this.research()) ? this.goto("WAIT_FOR_OPEN") : MINUTE;
      case "WAIT_FOR_OPEN":
        if (this.now >= sess.openMs) return this.goto("ACTIVE");
        return Math.min(poll, sess.openMs - this.now);
      case "ACTIVE":
      case "WIND_DOWN":
        await this.tick(sess, c);
        if (this.s.phase === "WIND_DOWN" && this.windDownDone(sess)) return this.goto("REPORT");
        return poll;
      case "REPORT":
        return this.report();
      case "RECOVERY_WAIT": {
        if (this.now < sess.openMs) return Math.min(MINUTE, sess.openMs - this.now);
        this.log("recovery_session_open", { date: sess.date });
        return this.goto("WIND_DOWN");
      }
      default:
        return poll;
    }
  }

  private goto(phase: SessionState["phase"]): number {
    this.log("phase", { from: this.s.phase, to: phase, ny: isoNy(this.now) });
    this.s.phase = phase;
    return 0;
  }

  private async client(): Promise<Robinhood> {
    this.broker ??= await this.d.connect();
    return this.broker;
  }

  private brokerFailed(err: unknown, what: string): void {
    const msg = err instanceof Error ? err.message : String(err);
    this.s.consecutiveBrokerErrors++;
    this.reconciledOk = false;
    const flag = AUTH_RE.test(msg) ? "auth_expired" : "broker_unreachable";
    this.s.flags = [flag];
    this.log("broker_error", { what, flag, message: msg.slice(0, 500) });
    if (this.s.consecutiveBrokerErrors === 3 || (flag === "auth_expired" && this.s.consecutiveBrokerErrors === 1)) {
      this.d.notify(`Fifty: ${flag}`, flag === "auth_expired" ? "Robinhood sign-in failed. Run `fifty login`. Entries paused." : `Broker unreachable: ${msg.slice(0, 120)}`);
    }
    const b = this.broker;
    this.broker = undefined; // reconnect next time
    void b?.close().catch(() => undefined);
  }

  private async precheck(): Promise<boolean> {
    try {
      const rh = await this.client();
      const acct = await rh.verifyAccount();
      const pf = await rh.portfolio();
      const positions = await rh.positions();
      this.s.accountType = acct.type;
      this.s.brokerageType = acct.brokerageType;
      if (this.s.baseline === null) {
        // Holdings that predate the experiment. The experiment only ever sells what it bought.
        this.s.baseline = Object.fromEntries(positions.filter((p) => p.quantity !== 0).map((p) => [p.symbol, p.quantity]));
        this.s.startBuyingPower = pf.buyingPower;
      }
      if (positions.some((p) => p.quantity < 0)) throw new Error("account holds a short position; refusing to run");
      if (!this.s.universe.length) {
        const fromLists = await rh.listSymbols(this.d.cfg.universe_lists);
        this.s.universe = [...new Set([...this.d.cfg.universe, ...fromLists])].slice(0, MAX_UNIVERSE);
        this.log("universe", { symbols: this.s.universe, from_lists: this.d.cfg.universe_lists, list_symbols: fromLists.length });
      }
      const trad = await rh.tradability(this.s.universe, acct.brokerageType);
      for (const t of trad) this.trad.set(t.symbol, t);
      this.buyingPower = pf.buyingPower;
      const notes = [
        `account type ${acct.type}${acct.type === "cash" ? " (cash: sale proceeds are not spendable until T+1; broker buying_power enforces this)" : ""}`,
        `broker buying power $${pf.buyingPower.toFixed(2)}; experiment capital $${this.d.cfg.boundaries.initial_capital_usd}`,
      ];
      if (pf.buyingPower < this.d.cfg.boundaries.initial_capital_usd) notes.push("buying power is below the configured capital; entries are limited to buying power");
      this.s.notes.push(...notes);
      this.s.consecutiveBrokerErrors = 0;
      this.s.flags = [];
      this.log("precheck_ok", { account_type: acct.type, buying_power: pf.buyingPower, baseline_symbols: Object.keys(this.s.baseline).length, notes });
      return true;
    } catch (err) {
      this.brokerFailed(err, "precheck");
      if (err instanceof Error && /agentic_allowed|account found|deactivated|short position|state is/.test(err.message)) {
        this.d.notify("Fifty: precheck failed", err.message);
      }
      return false;
    }
  }

  private async research(): Promise<boolean> {
    try {
      const rh = await this.client();
      const quotes = await rh.quotes(this.s.universe);
      if (this.trad.size === 0) for (const t of await rh.tradability(this.s.universe, this.s.brokerageType)) this.trad.set(t.symbol, t);
      const result = this.strategy.research({ now: this.now, quotes, tradability: [...this.trad.values()], config: this.d.cfg.strategy, universe: this.s.universe });
      this.s.watchlist = result.watchlist;
      this.s.researchNotes = result.notes;
      this.log("research", { watchlist: result.watchlist, notes: result.notes, evidence_at: quotes.map((q) => [q.symbol, new Date(q.asOfMs).toISOString()]) });
      return true;
    } catch (err) {
      this.brokerFailed(err, "research");
      return false;
    }
  }

  // ---------------------------------------------------------------- reconciliation

  private async reconcile(): Promise<boolean> {
    try {
      const rh = await this.client();
      const since = Math.min(this.s.startedAt, ...this.s.orders.map((o) => o.submittedAt)) - MINUTE;
      const brokerOrders = await rh.orders(new Date(since).toISOString());
      const byId = new Map(brokerOrders.map((b) => [b.id, b]));
      for (const o of this.s.orders) {
        if (!o.brokerId || !OPEN_STATUSES.has(o.status)) continue;
        const b = byId.get(o.brokerId) ?? (await rh.order(o.brokerId));
        if (b) this.updateOrder(o, b);
      }
      await this.resolveUnknown(rh, brokerOrders);
      const claimed = new Set(this.s.orders.map((o) => o.brokerId).filter(Boolean));
      const flags: string[] = [];
      const foreign = brokerOrders.filter((b) => !claimed.has(b.id) && Date.parse(b.createdAt) >= this.s.startedAt && b.status === "open");
      if (foreign.length) flags.push(`foreign_open_agentic_orders:${foreign.map((f) => f.symbol).join("/")}`);

      const positions = await rh.positions();
      this.brokerPositions = new Map(positions.map((p) => [p.symbol, p]));
      const b = this.books();
      const symbols = new Set([...Object.keys(this.s.baseline ?? {}), ...Object.keys(b.holdings)]);
      for (const sym of symbols) {
        const expected = (this.s.baseline?.[sym] ?? 0) + (b.holdings[sym]?.qty ?? 0);
        const actual = this.brokerPositions.get(sym)?.quantity ?? 0;
        if (Math.abs(expected - actual) > 1e-5) flags.push(`position_mismatch:${sym}(expected ${expected}, broker ${actual})`);
      }
      if (positions.some((p) => p.quantity < 0)) flags.push("short_position_in_account");
      this.buyingPower = (await rh.portfolio()).buyingPower;
      this.s.flags = flags;
      const key = flags.join("|");
      if (key !== this.lastFlagsKey) {
        this.log("flags", { flags });
        this.lastFlagsKey = key;
      }
      this.s.consecutiveBrokerErrors = 0;
      this.s.lastReconcileAt = this.now;
      this.reconciledOk = true;
      return true;
    } catch (err) {
      this.brokerFailed(err, "reconcile");
      return false;
    }
  }

  private updateOrder(o: LocalOrder, b: BrokerOrder): void {
    const before = `${o.status}/${o.filledQty}`;
    applyBroker(o, b, this.now);
    if (`${o.status}/${o.filledQty}` !== before) this.log("order_update", { localId: o.localId, purpose: o.purpose, symbol: o.symbol, side: o.side, state: b.state, filled: b.filledQty, avg: b.avgPrice, fees: b.fees, reject_reason: b.rejectReason });
  }

  /**
   * An order whose submission outcome is unknown (timeout, dropped response, crash between
   * intent and response). Robinhood's order objects carry no ref_id, so: first look for exactly
   * one unclaimed agentic order that matches it; only if none exists after a grace period,
   * re-send with the SAME ref_id (the broker deduplicates on it), at most once. Until resolved,
   * new entries stay blocked (guard.entryBlock).
   */
  private async resolveUnknown(rh: Robinhood, brokerOrders: BrokerOrder[]): Promise<void> {
    const claimed = new Set(this.s.orders.map((o) => o.brokerId).filter(Boolean));
    for (const o of this.s.orders) {
      if (o.status !== "unknown" && o.status !== "submitting") continue;
      const matches = brokerOrders.filter((b) =>
        !claimed.has(b.id) && b.symbol === o.symbol && b.side === o.side && Date.parse(b.createdAt) >= o.submittedAt - 30_000 &&
        (o.request.dollar_amount !== undefined ? b.notional === Number(o.request.dollar_amount) : b.quantity === Number(o.request.quantity)));
      if (matches.length === 1) {
        this.updateOrder(o, matches[0]!);
        claimed.add(matches[0]!.id);
        this.log("unknown_resolved", { localId: o.localId, how: "matched broker order", brokerId: o.brokerId });
        continue;
      }
      if (matches.length > 1) {
        this.log("unknown_ambiguous", { localId: o.localId, candidates: matches.length });
        continue;
      }
      const age = this.now - o.submittedAt;
      if (o.resends === 0 && age >= 20_000) {
        o.resends++;
        this.save();
        this.log("unknown_resend_same_ref_id", { localId: o.localId, ref_id: o.ref_id });
        try {
          const b = await rh.place(o.request);
          this.updateOrder(o, b);
          this.log("unknown_resolved", { localId: o.localId, how: "resend with same ref_id", brokerId: b.id });
        } catch (err) {
          if (err instanceof RobinhoodToolError) {
            o.status = "rejected";
            o.rejectReason = err.message;
            this.log("unknown_resolved", { localId: o.localId, how: "resend rejected by tool; not placed", message: err.message });
          } else this.log("unknown_resend_failed", { localId: o.localId, message: String(err).slice(0, 300) });
        }
      } else if (age > this.d.cfg.execution.unknown_order_resolve_seconds * 1000) {
        o.status = "lost";
        this.log("unknown_declared_lost", { localId: o.localId, note: "no matching broker order after resend and grace period" });
        this.d.notify("Fifty: order outcome unknown", `${o.side} ${o.symbol}: no broker record found; treated as not placed. Check the Robinhood app.`);
      }
    }
  }

  // ---------------------------------------------------------------- execution

  private async submit(o: LocalOrder): Promise<void> {
    this.s.orders.push(o);
    this.save(); // intent is durable before the request leaves
    this.log("order_intent", { localId: o.localId, ref_id: o.ref_id, purpose: o.purpose, request: o.request, reserved: o.reservedUsd, decisionId: o.decisionId });
    try {
      const b = await (await this.client()).place(o.request);
      this.updateOrder(o, b);
    } catch (err) {
      if (err instanceof RobinhoodToolError) {
        o.status = "rejected";
        o.rejectReason = err.message;
        this.log("order_rejected", { localId: o.localId, message: err.message });
      } else {
        o.status = "unknown";
        this.log("order_outcome_unknown", { localId: o.localId, message: String(err).slice(0, 300) });
        this.brokerFailed(err, "place");
      }
    }
    this.save();
  }

  private newOrder(purpose: LocalOrder["purpose"], req: Omit<PlaceRequest, "ref_id">, reservedUsd: number, extra: Partial<LocalOrder> = {}): LocalOrder {
    const ref_id = randomUUID();
    return {
      localId: `${purpose}-${this.s.orders.length + 1}`, ref_id, purpose, symbol: req.symbol, side: req.side, request: { ...req, ref_id },
      reservedUsd, status: "submitting", filledQty: 0, fees: 0, submittedAt: this.now, updatedAt: this.now, resends: 0, ...extra,
    };
  }

  private async cancel(o: LocalOrder, why: string): Promise<void> {
    if (!o.brokerId || (o.cancelRequestedAt !== undefined && this.now - o.cancelRequestedAt < 10_000)) return;
    o.cancelRequestedAt = this.now;
    try {
      const accepted = await (await this.client()).cancel(o.brokerId);
      this.log("cancel_requested", { localId: o.localId, why, accepted });
    } catch (err) {
      if (err instanceof RobinhoodToolError) this.log("cancel_refused", { localId: o.localId, why, message: err.message });
      else this.brokerFailed(err, "cancel");
    }
  }

  private async tick(sess: Session, c: Controls): Promise<void> {
    const cfg = this.d.cfg;
    if (!(await this.reconcile())) return; // nothing new is sent while broker state is unknown
    if (this.trad.size === 0 && !this.s.recovery) {
      // After a restart the in-memory tradability cache is empty; reload before any entry.
      try {
        for (const t of await (await this.client()).tradability(this.s.universe, this.s.brokerageType)) this.trad.set(t.symbol, t);
      } catch (err) {
        this.brokerFailed(err, "tradability");
        return;
      }
    }
    const b = this.books();
    const held = Object.keys(b.holdings);
    try {
      const qs = await (await this.client()).quotes([...new Set([...this.s.watchlist, ...held])]);
      for (const q of qs) this.quotes.set(q.symbol, q);
    } catch (err) {
      this.brokerFailed(err, "quotes");
      return;
    }
    const cutoff = sess.closeMs - cfg.session.entry_cutoff_minutes_before_close * MINUTE;
    const flattenAt = sess.closeMs - cfg.session.flatten_minutes_before_close * MINUTE;
    if (this.s.phase === "ACTIVE" && this.now >= cutoff) this.goto("WIND_DOWN");

    // Entry orders: cancelled when stale, when killed, and in wind-down.
    for (const o of this.s.orders.filter((x) => x.purpose === "entry" && x.status === "open")) {
      if (this.s.killed) await this.cancel(o, "kill switch");
      else if (this.s.phase === "WIND_DOWN") await this.cancel(o, "wind-down");
      else if (this.now - o.submittedAt > cfg.execution.entry_order_ttl_seconds * 1000) await this.cancel(o, "entry ttl");
    }

    // Exits.
    const flattenAll = this.s.recovery || c.flatten || (this.s.phase === "WIND_DOWN" && this.now >= flattenAt);
    for (const sym of held) {
      const plan = this.s.exits[sym];
      const q = this.quotes.get(sym);
      const fresh = !quoteProblem(q, { ...cfg, execution: { ...cfg.execution, max_spread_pct: 100 } }, this.now);
      let why: string | undefined;
      if (flattenAll) why = this.s.recovery ? "recovery flatten" : c.flatten ? "manual flatten" : "session wind-down";
      else if (plan && fresh && q!.bid <= plan.stopPrice) why = `stop ${plan.stopPrice} hit (bid ${q!.bid})`;
      else if (plan && fresh && q!.bid >= plan.targetPrice) why = `target ${plan.targetPrice} hit (bid ${q!.bid})`;
      if (why) await this.exit(sym, b, why);
      else if (plan && cfg.execution.broker_stop_orders && this.s.phase === "ACTIVE") await this.ensureBrokerStop(sym, b, plan.stopPrice);
    }

    // Entries: the strategy sees every ACTIVE tick (it builds state), but only acts when allowed.
    if (this.s.phase !== "ACTIVE" || this.s.recovery) return;
    const busy = new Set([...held, ...this.s.orders.filter((o) => OPEN_STATUSES.has(o.status)).map((o) => o.symbol)]);
    const cap = spendable(cfg, b, this.buyingPower);
    const proposals = this.strategy.onTick({
      now: this.now, openMs: sess.openMs, quotes: this.quotes, watchlist: this.s.watchlist, busy, spendableUsd: cap, config: cfg.strategy, memory: this.s.strategy,
    });
    if (!proposals.length) return;
    const block = entryBlock(this.s, cfg, this.now, sess.closeMs, c.paused);
    const decisionId = randomUUID();
    if (block) {
      this.noTrade({ decisionId, action: "NO_TRADE", why: block, proposals: proposals.map((p) => p.symbol) });
      return;
    }
    await this.enter(proposals[0]!, decisionId, b);
  }

  private async enter(proposal: EntryProposal, decisionId: string, b: Books): Promise<void> {
    const cfg = this.d.cfg;
    let p: EntryProposal | undefined = proposal;
    let approvedBy = "rules";
    if (cfg.model.decider === "claude" && this.d.reviewer) {
      if (this.s.modelCalls >= cfg.model.max_calls || this.s.modelUsd >= cfg.boundaries.model_spend_limit_usd) {
        this.log("decision", { decisionId, action: "NO_TRADE", why: "model budget exhausted; rules alone may not enter when the model decider is configured", proposal });
        return;
      }
      this.s.modelCalls++;
      try {
        const q = this.quotes.get(proposal.symbol);
        const context = JSON.stringify({ quote: q, research: this.s.researchNotes, holdings: b.holdings, realized_pnl: b.realizedPnl });
        const r = await this.d.reviewer(proposal, context);
        this.s.modelUsd += r.usd;
        p = r.proposal;
        approvedBy = "rules+model";
        this.log("model_review", { decisionId, usd: r.usd, approved: !!p, raw: r.raw.slice(0, 2000) });
      } catch (err) {
        this.log("model_error", { decisionId, message: String(err).slice(0, 300) });
        p = undefined;
      }
      if (this.s.modelUsd >= cfg.boundaries.model_spend_limit_usd) this.log("model_budget_reached", { usd: this.s.modelUsd });
    }
    if (!p) {
      this.log("decision", { decisionId, action: "NO_TRADE", why: "model declined or failed", proposal });
      return;
    }
    const q = this.quotes.get(p.symbol);
    const terms = checkEntry({ proposal: p, cfg, state: this.s, books: b, buyingPower: this.buyingPower, quote: q, tradability: this.trad.get(p.symbol), now: this.now });
    const mid = q ? (q.bid + q.ask) / 2 : undefined;
    const estQty = terms.ok ? (terms.type === "market" ? terms.dollar_amount / (q?.ask ?? 1) : terms.quantity) : 0;
    const record: Record<string, unknown> = {
      decisionId, action: terms.ok ? "BUY" : "NO_TRADE", approvedBy, symbol: p.symbol, why: terms.ok ? p.reason : terms.reason,
      size: terms.ok ? (terms.type === "market" ? { dollar_amount: terms.dollar_amount } : { quantity: terms.quantity, limit_price: terms.limit_price }) : undefined,
      entry_conditions: p.reason, exit_conditions: { stop: p.stopPrice, target: p.targetPrice, time: `flatten ${cfg.session.flatten_minutes_before_close} min before close` },
      est_costs_usd: { commission: 0, spread: q ? floorCents(((q.ask - q.bid) / 2) * estQty * 2) : null, regulatory_on_exit: q ? estSellFees(estQty, q.bid) : null },
      evidence: p.evidence,
    };
    if (terms.ok) this.log("decision", record);
    else this.noTrade(record);
    if (!terms.ok) return;
    const req: Omit<PlaceRequest, "ref_id"> = terms.type === "market"
      ? { symbol: p.symbol, side: "buy", type: "market", dollar_amount: terms.dollar_amount.toFixed(2), time_in_force: "gfd" }
      : { symbol: p.symbol, side: "buy", type: "limit", quantity: String(terms.quantity), limit_price: terms.limit_price.toFixed(2), time_in_force: "gfd" };
    this.s.exits[p.symbol] = { stopPrice: p.stopPrice, targetPrice: p.targetPrice, decisionId };
    this.s.entries++;
    this.s.lastEntryAt = this.now;
    this.strategy.onEntrySubmitted(this.s.strategy, p.symbol);
    await this.submit(this.newOrder("entry", req, terms.reserved, { decisionId, decisionMid: mid }));
  }

  /** NO_TRADE decisions are logged when the reason changes, not on every identical tick. */
  private noTrade(d: Record<string, unknown>): void {
    const key = `${String(d.symbol ?? d.proposals)}|${String(d.why)}`;
    if (key === this.lastNoTrade) return;
    this.lastNoTrade = key;
    this.log("decision", d);
  }

  private async ensureBrokerStop(sym: string, b: Books, stopPrice: number): Promise<void> {
    const whole = Math.floor((b.holdings[sym]?.qty ?? 0) + 1e-9);
    if (whole < 1) return;
    const open = this.s.orders.filter((o) => o.symbol === sym && o.side === "sell" && OPEN_STATUSES.has(o.status));
    if (open.length) return; // a stop (or exit) already covers it
    const avail = this.brokerPositions.get(sym)?.available ?? 0;
    const qty = Math.min(whole, Math.floor(avail + 1e-9));
    if (qty < 1) return;
    await this.submit(this.newOrder("stop", { symbol: sym, side: "sell", type: "stop_market", quantity: String(qty), stop_price: stopPrice.toFixed(2), time_in_force: "gfd" }, 0));
  }

  /** Sell everything the experiment holds in `sym`. A resting broker stop is cancelled first and
   *  must be confirmed cancelled (or filled) before the market sell goes out. */
  private async exit(sym: string, b: Books, why: string): Promise<void> {
    const sells = this.s.orders.filter((o) => o.symbol === sym && o.side === "sell" && OPEN_STATUSES.has(o.status));
    if (sells.some((o) => o.purpose === "exit")) return; // already exiting
    // A refused exit is retried once a minute, not every tick; after 3 refusals a human is told.
    const refused = this.s.orders.filter((o) => o.symbol === sym && o.purpose === "exit" && o.status === "rejected" && o.submittedAt > (this.s.lastEntryAt ?? 0));
    const last = refused.at(-1);
    if (last && this.now - last.updatedAt < MINUTE) return;
    if (refused.length === 3) this.d.notify("Fifty: exit refused 3 times", `${sym}: ${last?.rejectReason ?? "unknown"}. Still retrying each minute; check the Robinhood app.`);
    const stops = sells.filter((o) => o.purpose === "stop");
    if (stops.length) {
      for (const o of stops) await this.cancel(o, `exit: ${why}`);
      return; // next tick, after the cancel is confirmed by reconcile
    }
    const avail = this.brokerPositions.get(sym)?.available ?? 0;
    const qty = sizeExit(sym, b, avail);
    if (qty <= 0) {
      this.log("exit_blocked", { symbol: sym, why, note: "no sellable shares reported by broker (held for other orders?)" });
      return;
    }
    const q = this.quotes.get(sym);
    this.log("exit", { symbol: sym, why, qty });
    await this.submit(this.newOrder("exit", { symbol: sym, side: "sell", type: "market", quantity: dec(qty, 6), time_in_force: "gfd" }, 0, { decisionMid: q ? (q.bid + q.ask) / 2 : undefined }));
  }

  // ---------------------------------------------------------------- end of session

  /** Broker-confirmed flat: last reconcile succeeded and no holding or open order remains. */
  isFlat(): boolean {
    const b = this.books();
    return this.reconciledOk && !this.s.flags.some((f) => f.startsWith("position_mismatch")) &&
      Object.keys(b.holdings).length === 0 && !this.s.orders.some((o) => OPEN_STATUSES.has(o.status));
  }

  /** WIND_DOWN ends when broker-confirmed flat, or at the close (+5 min for late reports). */
  windDownDone(sess: Session): boolean {
    return this.isFlat() || this.now >= sess.closeMs + 5 * MINUTE;
  }

  private report(): number {
    const b = this.books();
    const exposure = Object.keys(b.holdings).length > 0 || this.s.orders.some((o) => OPEN_STATUSES.has(o.status));
    const r = buildReport(this.s, this.d.cfg, b, this.quotes, this.reconciledOk, this.now);
    writeReport(this.store.dir, r);
    this.s.reportedAt = this.now;
    this.log("report", { flat: !exposure, net_pnl: r.net_pnl_usd });
    if (exposure) {
      if (this.d.cfg.session.recovery_flatten_next_session && !this.s.recovery) {
        this.s.recovery = true;
        this.s.recoveryDate = nextSessionAfter(this.s.date).date;
        this.d.notify("Fifty: positions remain after close", `Exposure remains. Exit-only recovery at the ${this.s.recoveryDate} open. See fifty report.`);
        return this.goto("RECOVERY_WAIT");
      }
      this.d.notify("Fifty: UNRESOLVED EXPOSURE", "Positions or orders remain and recovery is exhausted/disabled. Close them in the Robinhood app.");
    } else this.d.notify("Fifty: session complete", `Net P&L $${r.net_pnl_usd.toFixed(2)}. Broker-confirmed flat.`);
    this.s.completedAt = this.now;
    return this.goto("COMPLETE");
  }

  status(): Record<string, unknown> {
    const b = this.books();
    return {
      date: this.s.date, phase: this.s.phase, recovery: this.s.recovery, now: new Date(this.now).toISOString(), ny: isoNy(this.now),
      killed: this.s.killed, flags: this.s.flags, watchlist: this.s.watchlist, holdings: b.holdings, realized_pnl: b.realizedPnl, fees: b.fees,
      experiment_cash: spendable(this.d.cfg, b, Number.POSITIVE_INFINITY) + this.d.cfg.boundaries.cash_reserve_usd, broker_buying_power: this.buyingPower,
      open_orders: this.s.orders.filter((o) => OPEN_STATUSES.has(o.status)).map((o) => ({ id: o.localId, purpose: o.purpose, side: o.side, symbol: o.symbol, status: o.status })),
      entries: this.s.entries, model_calls: this.s.modelCalls, model_usd: Number(this.s.modelUsd.toFixed(4)), last_reconcile: this.s.lastReconcileAt ? new Date(this.s.lastReconcileAt).toISOString() : null,
    };
  }
}
