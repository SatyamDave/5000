// End-to-end sessions: real Engine + real Robinhood client code + simulated MCP server + fake clock.
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { MockRobinhood } from "../src/broker/mock-server.js";
import { connect, Robinhood, ToolNotAllowedError } from "../src/broker/robinhood.js";
import { sessionOn } from "../src/calendar.js";
import { Engine } from "../src/engine.js";
import { runnerLockFile } from "../src/paths.js";
import { acquireRunnerLock } from "../src/service.js";
import { simulate, SIM_ACCOUNT } from "../src/sim.js";
import { DAY, freshStateDir, placements, rising, testConfig } from "./helpers.js";

const OPEN = sessionOn(DAY)!.openMs;
const CLOSE = sessionOn(DAY)!.closeMs;
const journal = (dir: string) => readFileSync(path.join(dir, "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("a normal session trades, flattens before the close and reports broker-confirmed flat", async () => {
  freshStateDir();
  const { state, mock, engine } = await simulate({ cfg: testConfig(), date: DAY, pricePath: rising(OPEN), quiet: true });
  assert.equal(state.phase, "COMPLETE");
  assert.ok(placements(mock.calls).length >= 2, "expected at least an entry and an exit");
  const r = JSON.parse(readFileSync(path.join(engine.store.dir, "report.json"), "utf8"));
  assert.equal(r.broker_confirmed_flat, true);
  assert.equal(r.remaining_positions.length, 0);
  for (const [sym, q] of mock.positions) assert.ok(q < 1e-9, `${sym} still held`);
  // Every order went out in the real input schema (the mock rejects anything else as "schema:").
  assert.equal(state.orders.filter((o) => o.rejectReason?.includes("schema")).length, 0);
  // Every sell happened before the close.
  for (const o of mock.orders) assert.ok(Date.parse(o.created_at) < CLOSE);
});

test("wrong account: an account missing from get_accounts never gets past precheck", async () => {
  freshStateDir();
  const cfg = testConfig((c) => { c.boundaries.account_number = "SOMEONEELSE1"; });
  const { state, mock: m } = await simulate({ cfg, date: DAY, mockAccount: SIM_ACCOUNT, quiet: true, maxIterations: 50 });
  assert.equal(placements(m.calls).length, 0);
  assert.equal(state.phase, "PRECHECK");
});

test("wrong account: a non-agentic account is refused", async () => {
  freshStateDir();
  const { state, mock, notes } = await simulate({ cfg: testConfig(), date: DAY, agenticAllowed: false, quiet: true, maxIterations: 20 });
  assert.equal(placements(mock.calls).length, 0);
  assert.equal(state.phase, "PRECHECK");
  assert.ok(notes.some((n) => /agentic_allowed/.test(n)));
});

test("wrong account: the client refuses any call carrying a different account number", async () => {
  const mock = new MockRobinhood({ account: SIM_ACCOUNT, cash: 50, prices: { SIMA: 10 }, now: () => OPEN });
  const rh = new Robinhood(await connect({ transport: await mock.start() }), SIM_ACCOUNT, { trading: false, timeoutMs: 5000 });
  await assert.rejects(rh.place({ symbol: "SIMA", side: "buy", type: "market", dollar_amount: "5.00", time_in_force: "gfd", ref_id: "x" }), ToolNotAllowedError);
  assert.equal(mock.calls.length, 0, "a read-only client must not even reach the wire");
  await rh.close();
});

test("overspend: $1,000 in the account, $50 configured: the experiment never buys more than its own cash", async () => {
  freshStateDir();
  const { state, mock } = await simulate({ cfg: testConfig(), date: DAY, cash: 1000, pricePath: rising(OPEN), quiet: true });
  let cash = 50;
  for (const o of mock.orders.slice().sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const notional = (o.avg ?? 0) * o.filled;
    if (o.side === "buy") {
      cash -= notional;
      assert.ok(cash >= -0.01, `bought beyond experiment cash: ${cash}`);
    } else cash += notional - o.fees;
  }
  assert.equal(state.phase, "COMPLETE");
});

test("ambiguous submission: response lost after the order was created -> matched, never duplicated", async () => {
  freshStateDir();
  const { state, mock, engine } = await simulate({ cfg: testConfig(), date: DAY, pricePath: rising(OPEN), faults: { placeLostResponse: 1 }, quiet: true });
  const entries = mock.orders.filter((o) => o.side === "buy");
  const ev = journal(engine.store.dir);
  assert.ok(ev.some((e) => e.event === "order_outcome_unknown"));
  assert.ok(ev.some((e) => e.event === "unknown_resolved" && e.how === "matched broker order"));
  // Each local entry maps to exactly one broker order: no duplicate from a blind retry.
  assert.equal(new Set(state.orders.filter((o) => o.side === "buy").map((o) => o.brokerId)).size, entries.length);
  assert.equal(state.phase, "COMPLETE");
});

test("ambiguous submission: request lost before reaching the broker -> one resend with the same ref_id", async () => {
  freshStateDir();
  const { state, mock, engine } = await simulate({ cfg: testConfig(), date: DAY, pricePath: rising(OPEN), faults: { placeDropBeforeCreate: 1 }, quiet: true });
  const ev = journal(engine.store.dir);
  const resend = ev.find((e) => e.event === "unknown_resend_same_ref_id");
  assert.ok(resend);
  const sent = placements(mock.calls).filter((c) => c.args.ref_id === resend.ref_id);
  assert.equal(sent.length, 2, "original + exactly one resend");
  assert.equal(mock.orders.filter((o) => o.ref_id === resend.ref_id).length, 1, "broker holds one order for that ref_id");
  assert.equal(state.phase, "COMPLETE");
});

test("duplicate execution: the broker deduplicates a resent ref_id", async () => {
  const mock = new MockRobinhood({ account: SIM_ACCOUNT, cash: 50, prices: { SIMA: 10 }, now: () => OPEN + 3_600_000 });
  const rh = new Robinhood(await connect({ transport: await mock.start() }), SIM_ACCOUNT, { trading: true, timeoutMs: 5000 });
  const req = { symbol: "SIMA", side: "buy" as const, type: "market" as const, dollar_amount: "5.00", time_in_force: "gfd" as const, ref_id: "11111111-1111-4111-8111-111111111111" };
  const a = await rh.place(req);
  const b = await rh.place(req);
  assert.equal(a.id, b.id);
  assert.equal(mock.orders.length, 1);
  await rh.close();
});

test("duplicate execution: a second runner cannot start while another live process holds the lock", () => {
  freshStateDir();
  writeFileSync(runnerLockFile(), String(process.ppid)); // a live process that is not us
  assert.throws(() => acquireRunnerLock(), /another runner/);
  writeFileSync(runnerLockFile(), "999999"); // dead pid: stale lock is taken over
  const release = acquireRunnerLock();
  assert.equal(readFileSync(runnerLockFile(), "utf8"), String(process.pid));
  release();
  assert.equal(existsSync(runnerLockFile()), false);
});

test("partial fill: the filled part is booked, the rest cancelled, and only filled shares are sold", async () => {
  freshStateDir();
  const cfg = testConfig((c) => { c.strategy.max_entries_per_session = 1; c.execution.broker_stop_orders = false; });
  const { state, mock } = await simulate({ cfg, date: DAY, pricePath: rising(OPEN), faults: { partialFillFraction: 0.5, noFills: false }, quiet: true,
    onStep: (_now, m) => {
      // Hold the remainder open: after the first partial fill, stop filling buys.
      if (m.orders.some((o) => o.state === "partially_filled")) m.faults.noFills = true;
      if (m.orders.some((o) => o.side === "buy" && o.state === "partially_filled_rest_cancelled")) m.faults.noFills = false;
    } });
  const entry = state.orders.find((o) => o.purpose === "entry")!;
  assert.equal(entry.brokerState, "partially_filled_rest_cancelled");
  assert.ok(entry.filledQty > 0);
  const sold = state.orders.filter((o) => o.side === "sell").reduce((a, o) => a + o.filledQty, 0);
  assert.ok(Math.abs(sold - entry.filledQty) < 1e-6, `sold ${sold} vs filled ${entry.filledQty}`);
  assert.equal(state.phase, "COMPLETE");
  assert.ok((mock.positions.get(entry.symbol) ?? 0) < 1e-9);
});

test("restart recovery: a crash mid-session resumes from session.json without duplicating orders", async () => {
  freshStateDir();
  const cfg = testConfig();
  let now = OPEN - 31 * 60_000;
  const mock = new MockRobinhood({ account: SIM_ACCOUNT, cash: 50, prices: Object.fromEntries(cfg.universe.map((s) => [s, 10])), pricePath: rising(OPEN), now: () => now });
  const make = (maxIterations?: number) => new Engine({
    cfg, armedSha: "t", date: DAY, clock: { now: () => now, sleep: async (ms) => { now += Math.max(1000, ms); } },
    connect: async () => new Robinhood(await connect({ transport: await mock.start() }), SIM_ACCOUNT, { trading: true, timeoutMs: 5000 }),
    controls: () => ({ paused: false, killed: false, flatten: false }), notify: () => undefined, maxIterations,
  });
  // Run until the first entry has filled, then "crash".
  const first = make(2000);
  const origStep = first.step.bind(first);
  first.step = async () => { const d = await origStep(); if (first.s.orders.some((o) => o.purpose === "entry" && o.status === "filled")) first.stop(); return d; };
  await first.run();
  const before = mock.orders.length;
  assert.ok(before >= 1);
  const second = make();
  assert.notEqual(second.s.phase, "PRECHECK", "resumed, not restarted");
  assert.equal(second.s.orders.length, first.s.orders.length);
  const entriesBefore = second.s.entries;
  const s = await second.run();
  assert.equal(s.phase, "COMPLETE");
  assert.ok(s.entries > entriesBefore, "the resumed runner can still enter (tradability reloaded)");
  const brokerIds = s.orders.map((o) => o.brokerId).filter(Boolean);
  assert.equal(new Set(brokerIds).size, brokerIds.length);
  assert.equal(mock.orders.length, s.orders.filter((o) => o.brokerId).length, "every broker order is tracked; none duplicated");
  for (const q of mock.positions.values()) assert.ok(q < 1e-9);
});

test("auth expiry mid-session pauses everything, notifies, and recovers when sign-in works again", async () => {
  freshStateDir();
  const outageStart = OPEN + 60 * 60_000, outageEnd = OPEN + 90 * 60_000;
  const marks: number[] = [];
  const { state, notes, engine } = await simulate({ cfg: testConfig(), date: DAY, pricePath: rising(OPEN), quiet: true,
    onStep: (now, m) => {
      const out = now >= outageStart && now < outageEnd;
      if (out !== !!m.faults.authExpired) marks.push(placements(m.calls).length);
      m.faults.authExpired = out;
    } });
  assert.ok(notes.some((n) => /auth_expired/.test(n)));
  assert.equal(marks.length, 2);
  assert.equal(marks[0], marks[1], "no placement attempted while the sign-in was failing");
  assert.ok(journal(engine.store.dir).some((e) => e.event === "broker_error" && e.flag === "auth_expired"));
  assert.equal(state.phase, "COMPLETE");
});

test("stale quotes: nothing is bought on data older than quote_max_age_seconds", async () => {
  freshStateDir();
  const { mock, state } = await simulate({ cfg: testConfig(), date: DAY, pricePath: rising(OPEN), faults: { quoteLagMs: 5 * 60_000 }, quiet: true });
  assert.equal(placements(mock.calls).length, 0);
  assert.equal(state.phase, "COMPLETE");
});

test("early close: the session winds down and completes before 13:00 ET", async () => {
  freshStateDir();
  const date = "2026-11-27";
  const s = sessionOn(date)!;
  const { mock, state, engine } = await simulate({ cfg: testConfig(), date, pricePath: rising(s.openMs), quiet: true });
  assert.equal(state.phase, "COMPLETE");
  for (const o of mock.orders) assert.ok(Date.parse(o.created_at) < s.closeMs);
  assert.ok(existsSync(path.join(engine.store.dir, "report.md")));
});

test("a runner started after the close trades nothing and reports a missed session", async () => {
  freshStateDir();
  const { mock, state, engine } = await simulate({ cfg: testConfig(), date: DAY, startMs: CLOSE + 60_000, quiet: true });
  assert.equal(placements(mock.calls).length, 0);
  assert.equal(state.phase, "COMPLETE");
  assert.ok(journal(engine.store.dir).some((e) => e.event === "missed_session"));
});

test("session completion is final: re-running a completed session sends nothing", async () => {
  freshStateDir();
  const cfg = testConfig();
  const first = await simulate({ cfg, date: DAY, pricePath: rising(OPEN), quiet: true });
  const n = first.mock.calls.length;
  const again = await simulate({ cfg, date: DAY, mock: first.mock, startMs: CLOSE + 3600_000, quiet: true });
  assert.equal(again.state.phase, "COMPLETE");
  assert.equal(first.mock.calls.length, n);
});

test("kill switch: blocks entries, cancels the open entry order, keeps managing and closing positions", async () => {
  freshStateDir();
  const killAt = OPEN + 45 * 60_000;
  const cfg = testConfig((c) => { c.strategy.max_open_positions = 2; });
  let entriesAfterKill = 0;
  const { state, mock, engine } = await simulate({ cfg, date: DAY, pricePath: rising(OPEN), quiet: true,
    controls: (now) => ({ killed: now >= killAt }),
    onStep: (now, m) => {
      if (now >= killAt + 60_000) entriesAfterKill = m.orders.filter((o) => o.side === "buy" && Date.parse(o.created_at) > killAt + 1000).length;
      // Make the second entry rest unfilled so the kill switch has an entry order to cancel.
      m.faults.noFills = m.orders.filter((o) => o.side === "buy").length >= 2 && now < killAt + 5 * 60_000;
    } });
  assert.equal(entriesAfterKill, 0);
  assert.equal(state.killed, true);
  const ev = journal(engine.store.dir);
  assert.ok(ev.some((e) => e.event === "kill_switch"));
  const openBuys = mock.orders.filter((o) => o.side === "buy" && Date.parse(o.created_at) < killAt && o.filled === 0);
  for (const o of openBuys) assert.equal(o.state, "cancelled");
  assert.equal(state.phase, "COMPLETE");
  for (const q of mock.positions.values()) assert.ok(q < 1e-9, "positions were still exited after the kill");
});

test("baseline holdings are never sold", async () => {
  freshStateDir();
  const { mock, state } = await simulate({ cfg: testConfig(), date: DAY, pricePath: rising(OPEN), holdings: { SIMA: 3, OTHER: 7 }, prices: { SIMA: 10, SIMB: 10, SIMC: 10, SIMD: 10, SIME: 10, SIMF: 10, OTHER: 50 }, quiet: true });
  assert.equal(state.phase, "COMPLETE");
  assert.ok(Math.abs((mock.positions.get("SIMA") ?? 0) - 3) < 1e-6);
  assert.equal(mock.positions.get("OTHER"), 7);
  assert.ok(!placements(mock.calls).some((c) => c.args.symbol === "OTHER"));
});

test("exposure after the close: reported, then sold exit-only at the next open", async () => {
  freshStateDir();
  const cfg = testConfig((c) => { c.strategy.max_entries_per_session = 1; c.execution.broker_stop_orders = false; c.strategy.stop_loss_pct = 50; c.strategy.take_profit_pct = 90; });
  const flattenAt = CLOSE - 15 * 60_000;
  const { state, mock, engine, notes } = await simulate({ cfg, date: DAY, pricePath: rising(OPEN), quiet: true,
    onStep: (now, m) => { m.faults.noFills = now >= flattenAt - 60_000 && now < CLOSE + 3600_000; } });
  assert.ok(notes.some((n) => /positions remain after close/.test(n)));
  assert.equal(state.recovery, true);
  assert.equal(state.recoveryDate, "2026-10-01");
  assert.equal(state.phase, "COMPLETE");
  for (const q of mock.positions.values()) assert.ok(q < 1e-9);
  const ev = journal(engine.store.dir);
  assert.ok(ev.some((e) => e.event === "recovery_session_open"));
  // No new entry on the recovery day.
  const next = sessionOn("2026-10-01")!;
  assert.equal(mock.orders.filter((o) => o.side === "buy" && Date.parse(o.created_at) >= next.openMs - 3600_000).length, 0);
});

test("network loss: no orders while the broker is unreachable; the session still completes flat", async () => {
  freshStateDir();
  const down = [OPEN + 30 * 60_000, OPEN + 50 * 60_000];
  const marks: number[] = [];
  const { state, mock } = await simulate({ cfg: testConfig(), date: DAY, pricePath: rising(OPEN), quiet: true,
    onStep: (now, m) => {
      const out = now >= down[0]! && now < down[1]!;
      if (out !== !!m.faults.networkDown) marks.push(placements(m.calls).length);
      m.faults.networkDown = out;
    } });
  assert.equal(marks.length, 2);
  assert.equal(marks[0], marks[1], "no placement attempted while the network was down");
  assert.equal(state.phase, "COMPLETE");
  for (const q of mock.positions.values()) assert.ok(q < 1e-9);
});

test("model decider: can only shrink an entry, and stops at the session spend limit", async () => {
  freshStateDir();
  const cfg = testConfig((c) => { c.model.decider = "claude"; c.boundaries.model_spend_limit_usd = 1; c.strategy.max_entries_per_session = 20; c.strategy.min_seconds_between_entries = 0; c.strategy.watchlist_size = 6; });
  let calls = 0;
  const { state, mock, engine } = await simulate({ cfg, date: DAY, pricePath: rising(OPEN), quiet: true,
    reviewer: async (p) => { calls++; return { usd: 0.4, raw: "{}", proposal: { ...p, notionalUsd: Math.min(p.notionalUsd, 10) } }; } });
  assert.equal(calls, 3, "0.4 + 0.4 + 0.4 >= 1.0: no fourth call");
  assert.ok(state.modelUsd >= 1 && state.modelUsd < 1.3);
  for (const o of mock.orders.filter((x) => x.side === "buy")) assert.ok((o.notional ?? 0) <= 10);
  assert.ok(journal(engine.store.dir).some((e) => e.event === "decision" && /model budget exhausted/.test(e.why ?? "")));
  assert.equal(state.phase, "COMPLETE");
});

test("universe_lists: symbols come from the broker's curated list, non-stocks dropped, frozen for the session", async () => {
  freshStateDir();
  const cfg = testConfig((c) => { c.universe = []; c.universe_lists = ["sim MOVERS"]; });
  const { state, mock } = await simulate({ cfg, date: DAY, pricePath: rising(OPEN), quiet: true });
  assert.deepEqual(state.universe, ["SIMA", "SIMB", "SIMC", "SIMD", "SIME", "SIMF"]);
  assert.ok(placements(mock.calls).length >= 2);
  assert.ok(placements(mock.calls).every((c) => state.universe.includes(String(c.args.symbol))));
  assert.equal(mock.calls.filter((c) => c.tool === "get_watchlist_items").length, 1, "resolved once, at precheck");
  assert.equal(state.phase, "COMPLETE");
});

test("universe_lists: an unknown list name fails precheck instead of trading nothing or anything", async () => {
  freshStateDir();
  const cfg = testConfig((c) => { c.universe = []; c.universe_lists = ["No such list"]; });
  const { state, mock } = await simulate({ cfg, date: DAY, quiet: true, maxIterations: 30 });
  assert.equal(state.phase, "PRECHECK");
  assert.equal(placements(mock.calls).length, 0);
});
