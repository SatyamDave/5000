// The session's persistent state: one JSON file rewritten atomically after every mutation, plus an
// append-only journal. An order's intent is written here (fsync'd) BEFORE it is sent, so a crash
// between "decided" and "sent" leaves a record the next start reconciles against the broker.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { BrokerOrder, PlaceRequest } from "./broker/robinhood.js";
import { sessionDir } from "./paths.js";
import { appendLine, writeFileAtomic } from "./util.js";

export type Phase = "PRECHECK" | "RESEARCH" | "WAIT_FOR_OPEN" | "ACTIVE" | "WIND_DOWN" | "REPORT" | "RECOVERY_WAIT" | "COMPLETE";

export type LocalStatus = "submitting" | "unknown" | "open" | "filled" | "cancelled" | "rejected" | "lost";

export interface LocalOrder {
  localId: string;
  ref_id: string;
  purpose: "entry" | "exit" | "stop";
  symbol: string;
  side: "buy" | "sell";
  request: PlaceRequest;
  /** Dollars held back for this order until it is done (buys only). */
  reservedUsd: number;
  status: LocalStatus;
  brokerId?: string;
  filledQty: number;
  avgPrice?: number;
  fees: number;
  submittedAt: number;
  updatedAt: number;
  resends: number;
  cancelRequestedAt?: number;
  decisionId?: string;
  /** Mid price when decided, for the slippage estimate. */
  decisionMid?: number;
  brokerState?: string;
  rejectReason?: string;
}

export interface ExitPlan {
  stopPrice: number;
  targetPrice: number;
  decisionId: string;
}

export interface SessionState {
  date: string;
  phase: Phase;
  armedSha: string;
  startedAt: number;
  /** Positions held before the experiment started; never sold by it. */
  baseline: Record<string, number> | null;
  startBuyingPower?: number;
  accountType?: string;
  brokerageType?: string;
  /** Symbols this session may trade: config universe + universe_lists, resolved at precheck. */
  universe: string[];
  watchlist: string[];
  researchNotes: string[];
  orders: LocalOrder[];
  exits: Record<string, ExitPlan>;
  strategy: Record<string, unknown>;
  entries: number;
  lastEntryAt?: number;
  killed: boolean;
  modelCalls: number;
  modelUsd: number;
  flags: string[];
  lastTickAt?: number;
  lastReconcileAt?: number;
  consecutiveBrokerErrors: number;
  recovery: boolean;
  recoveryDate?: string;
  reportedAt?: number;
  completedAt?: number;
  notes: string[];
}

export class Store {
  readonly dir: string;
  readonly file: string;
  readonly journal: string;

  constructor(readonly date: string) {
    this.dir = sessionDir(date);
    this.file = path.join(this.dir, "session.json");
    this.journal = path.join(this.dir, "journal.jsonl");
  }

  load(): SessionState | undefined {
    return existsSync(this.file) ? (JSON.parse(readFileSync(this.file, "utf8")) as SessionState) : undefined;
  }

  save(s: SessionState): void {
    writeFileAtomic(this.file, `${JSON.stringify(s, null, 1)}\n`);
  }

  log(event: string, data: Record<string, unknown> = {}, at = Date.now()): void {
    appendLine(this.journal, { at: new Date(at).toISOString(), event, ...data });
  }
}

export function freshState(date: string, armedSha: string, now: number): SessionState {
  return {
    date, phase: "PRECHECK", armedSha, startedAt: now, baseline: null, universe: [], watchlist: [], researchNotes: [], orders: [], exits: {},
    strategy: {}, entries: 0, killed: false, modelCalls: 0, modelUsd: 0, flags: [], consecutiveBrokerErrors: 0, recovery: false, notes: [],
  };
}

/** Local status from a broker order, carrying fills across. */
export function applyBroker(o: LocalOrder, b: BrokerOrder, now: number): void {
  o.brokerId = b.id;
  o.brokerState = b.state;
  o.filledQty = b.filledQty;
  o.avgPrice = b.avgPrice;
  o.fees = b.fees;
  o.rejectReason = b.rejectReason;
  o.status = b.status;
  o.updatedAt = now;
}
