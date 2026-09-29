// fifty: doctor | simulate-session | arm-session --date D | disarm | run | status | pause | resume |
//        stop [--flatten] | report [--date D] | login
import { existsSync, mkdtempSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { books } from "./accounting.js";
import { realTools } from "./broker/mock-server.js";
import { connect, READ_TOOLS, Robinhood, TRADE_TOOLS } from "./broker/robinhood.js";
import { login, readStoredAuth, tokenPath } from "./broker/robinhood-oauth.js";
import { isoNy, nextSessionAfter, nyDate, sessionOn } from "./calendar.js";
import { configPath, loadConfig, parseConfig, ROBINHOOD_MCP_URL } from "./config.js";
import type { Config } from "./config.js";
import { claudeReviewer } from "./decider/claude.js";
import { Engine, realClock } from "./engine.js";
import { armedFile, controlFile, projectRoot, sessionDir, stateDir, statusFile } from "./paths.js";
import { buildReport, renderMarkdown } from "./report.js";
import { acquireRunnerLock, agentStatus, anthropicKey, installAgent, notify, plistPath, removeAgent, sh } from "./service.js";
import { simConfig, simulate } from "./sim.js";
import { Store } from "./state.js";
import { mask, writeFileAtomic } from "./util.js";

interface Armed {
  date: string;
  armed_at: string;
  config_sha256: string;
  config: Config;
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

function readArmed(): Armed | undefined {
  return existsSync(armedFile()) ? (JSON.parse(readFileSync(armedFile(), "utf8")) as Armed) : undefined;
}

function controls() {
  return { paused: existsSync(controlFile("PAUSE")), killed: existsSync(controlFile("KILL")), flatten: existsSync(controlFile("FLATTEN")) };
}

function exitPolicy(cfg: Config): string {
  const s = cfg.session, st = cfg.strategy;
  return [
    `per-position stop ${st.stop_loss_pct}% (or opening-range low), target ${st.take_profit_pct}%`,
    cfg.execution.broker_stop_orders ? "broker-side stop_market orders on whole-share positions (keep working if this Mac or process dies; gfd)" : "local exits only (stop working if this process or the network is down)",
    `no new entries from ${s.entry_cutoff_minutes_before_close} min before close; sell everything from ${s.flatten_minutes_before_close} min before close (market orders)`,
    s.recovery_flatten_next_session ? "positions still open after the close: exit-only at the next session's open" : "positions still open after the close: reported, not auto-sold",
  ].join("\n    ");
}

function summary(cfg: Config, date: string, sha: string): string {
  const sess = sessionOn(date)!;
  return [
    `  account:          ${mask(cfg.boundaries.account_number)} (must be agentic_allowed; verified at precheck)`,
    `  capital:          $${cfg.boundaries.initial_capital_usd} contributed; no deposits, transfers, borrowing or top-ups; realized gains reinvested`,
    `  asset scope:      ${cfg.boundaries.asset_classes.join(", ")} (long only; no options, no crypto, no shorts)`,
    `  universe:         ${cfg.universe.join(", ")}`,
    `  session:          ${date} ${isoNy(sess.openMs)} to ${isoNy(sess.closeMs)}${sess.earlyClose ? " (EARLY CLOSE)" : ""}`,
    `  precheck starts:  ${isoNy(sess.openMs - cfg.session.precheck_minutes_before_open * 60_000)}`,
    `  strategy:         ${cfg.strategy.name}; ${cfg.strategy.position_size_pct}% of experiment cash per entry, max ${cfg.strategy.max_open_positions} open, max ${cfg.strategy.max_entries_per_session} entries`,
    `  exit policy:      ${exitPolicy(cfg)}`,
    `  model:            ${cfg.model.decider === "none" ? "none (rules only)" : `${cfg.model.model_id}, max ${cfg.model.max_calls} calls`}`,
    `  infra spend cap:  $${cfg.boundaries.model_spend_limit_usd} model API for the session (the only paid infrastructure this runs)`,
    `  target (score):   $${cfg.target_usd}. A long shot; the entire capital is at risk.`,
    `  config sha256:    ${sha.slice(0, 16)}...`,
  ].join("\n");
}

const PASS = "PASS", WARN = "WARN", FAIL = "FAIL";

async function doctor(): Promise<number> {
  let failed = 0;
  const line = (status: string, what: string, detail = "") => {
    if (status === FAIL) failed++;
    console.log(`${status.padEnd(4)}  ${what}${detail ? `: ${detail}` : ""}`);
  };
  line(Number(process.versions.node.split(".")[0]) >= 22 ? PASS : FAIL, "node", process.versions.node);
  let cfg: Config | undefined;
  try {
    const loaded = loadConfig();
    cfg = loaded.config;
    const placeholder = /REPLACE/.test(loaded.text);
    line(placeholder ? FAIL : PASS, "config", `${configPath()}${placeholder ? " still has REPLACE placeholders" : ""}`);
  } catch (err) {
    line(FAIL, "config", `${configPath()}: ${err instanceof Error ? err.message.slice(0, 300) : err}`);
  }
  const date = opt("date") ?? (() => { const t = nyDate(Date.now()); return sessionOn(t) && Date.now() < sessionOn(t)!.closeMs ? t : nextSessionAfter(t).date; })();
  try {
    const s = sessionOn(date);
    line(s ? PASS : FAIL, "calendar", s ? `${date} open ${isoNy(s.openMs)} close ${isoNy(s.closeMs)}${s.earlyClose ? " (early close)" : ""}` : `${date} is not an NYSE trading day`);
  } catch (err) {
    line(FAIL, "calendar", String(err));
  }
  const file = tokenPath();
  const stored = (() => { try { return readStoredAuth(file); } catch (err) { line(FAIL, "robinhood sign-in", String(err)); return undefined; } })();
  if (!stored) line(FAIL, "robinhood sign-in", `none at ${file}; run: fifty login`);
  else {
    const mode = statSync(file).mode & 0o777;
    const exp = stored.expires_at_ms ? new Date(stored.expires_at_ms).toISOString() : "unknown";
    line(mode === 0o600 ? PASS : FAIL, "token file", `mode ${mode.toString(8)}, access token expires ${exp}, refresh token ${stored.tokens.refresh_token ? "present" : "ABSENT"}`);
    if (stored.server_url !== ROBINHOOD_MCP_URL) line(FAIL, "token server", `sign-in is for ${stored.server_url}, not ${ROBINHOOD_MCP_URL}`);
  }
  if (stored && (!cfg || /REPLACE/.test(cfg.boundaries.account_number))) {
    try {
      const rh = new Robinhood(await connect(), "", { trading: false, timeoutMs: 15_000 });
      const accts = await rh.agenticAccountsMasked();
      line(accts.length ? WARN : FAIL, "agentic accounts visible to this sign-in", accts.length ? `${accts.join("; ")} -- put the full number in config boundaries.account_number` : "none (finish Agentic onboarding on robinhood.com)");
      await rh.close();
    } catch (err) {
      line(FAIL, "robinhood read-only check", err instanceof Error ? err.message.slice(0, 400) : String(err));
    }
  }
  if (stored && cfg && !/REPLACE/.test(cfg.boundaries.account_number)) {
    let rh: Robinhood | undefined;
    try {
      const client = await connect();
      // tools/list is not a tool call; it only lists schemas.
      const live = new Map<string, { inputSchema: { properties?: Record<string, unknown> } }>();
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        for (const t of page.tools) live.set(t.name, t as never);
        cursor = page.nextCursor;
      } while (cursor);
      const missing = [...READ_TOOLS, ...TRADE_TOOLS].filter((t) => !live.has(t));
      line(missing.length ? FAIL : PASS, "MCP tools", missing.length ? `missing ${missing.join(", ")}` : `${live.size} tools listed; all ${READ_TOOLS.length + TRADE_TOOLS.length} used tools present`);
      const pinned = realTools();
      const drift = [...READ_TOOLS, ...TRADE_TOOLS].filter((t) => JSON.stringify(live.get(t)?.inputSchema) !== JSON.stringify(pinned.get(t)?.inputSchema));
      line(drift.length ? WARN : PASS, "schema drift vs docs/robinhood-tools-2026-09-29.json", drift.length ? `input schema changed: ${drift.join(", ")} (re-check robinhood.ts)` : "none");
      rh = new Robinhood(client, cfg.boundaries.account_number, { trading: false, timeoutMs: cfg.execution.call_timeout_ms });
      const acct = await rh.verifyAccount();
      line(PASS, "account", `${mask(acct.accountNumber)} agentic_allowed, type ${acct.type}${acct.type === "cash" ? " (sale proceeds unusable until T+1)" : ""}`);
      const pf = await rh.portfolio();
      line(pf.buyingPower >= cfg.boundaries.initial_capital_usd ? PASS : WARN, "buying power", `$${pf.buyingPower.toFixed(2)} (configured capital $${cfg.boundaries.initial_capital_usd})`);
      const pos = await rh.positions();
      line(pos.some((p) => p.quantity < 0) ? FAIL : PASS, "positions", `${pos.length} existing (kept as baseline, never sold)`);
      const open = (await rh.orders(new Date(Date.now() - 7 * 86_400_000).toISOString())).filter((o) => o.status === "open");
      line(open.length ? WARN : PASS, "open agentic orders", String(open.length));
      const trad = await rh.tradability(cfg.universe, acct.brokerageType);
      const bad = trad.filter((t) => !t.tradeable || t.halted || !t.accountTypeOk).map((t) => t.symbol);
      const unresolved = cfg.universe.filter((s) => !trad.some((t) => t.symbol === s));
      line(bad.length || unresolved.length ? WARN : PASS, "tradability", `${trad.filter((t) => t.fractional).length}/${cfg.universe.length} fractional${bad.length ? `; not tradeable now: ${bad.join(",")}` : ""}${unresolved.length ? `; unresolved: ${unresolved.join(",")}` : ""}`);
      const quotes = await rh.quotes(cfg.universe);
      const ages = quotes.map((q) => Math.round((Date.now() - q.asOfMs) / 1000));
      line(PASS, "quotes", `${quotes.length}/${cfg.universe.length} returned; freshest ${Math.min(...ages)}s old (stale outside market hours is expected)`);
    } catch (err) {
      line(FAIL, "robinhood read-only check", err instanceof Error ? err.message.slice(0, 400) : String(err));
    } finally {
      await rh?.close().catch(() => undefined);
    }
  }
  if (cfg?.model.decider === "claude") line(anthropicKey() ? PASS : FAIL, "anthropic key", anthropicKey() ? "found (env or Keychain fifty-anthropic)" : "missing: security add-generic-password -a \"$USER\" -s fifty-anthropic -w");
  const batt = sh("pmset", ["-g", "batt"]);
  line(/AC Power/.test(batt) ? PASS : WARN, "power", /AC Power/.test(batt) ? "on AC (caffeinate -s holds off system sleep)" : "on battery: keep the lid open and plugged in; caffeinate -s only works on AC");
  const sleep = /^\s*sleep\s+(\d+)/m.exec(sh("pmset", ["-g"]))?.[1];
  line(PASS, "system sleep setting", `${sleep ?? "?"} min (the runner holds an idle-sleep assertion while alive)`);
  const armed = readArmed();
  line(PASS, "armed", armed ? `${armed.date} (config ${armed.config_sha256.slice(0, 12)})` : "not armed");
  line(PASS, "launchd agent", `${agentStatus()} (${plistPath()})`);
  console.log(failed ? `\n${failed} check(s) failed.` : "\nAll required checks passed. Read-only: no order tool was called.");
  return failed ? 1 : 0;
}

async function simulateCmd(): Promise<number> {
  const base = existsSync(configPath()) ? loadConfig().config : parseConfig(readFileSync(path.join(projectRoot(), "config", "fifty.example.json"), "utf8"));
  const universe = base.universe.some((s) => /REPLACE|WITH|YOUR|SYMBOLS/.test(s)) ? ["SIMA", "SIMB", "SIMC", "SIMD", "SIME", "SIMF"] : base.universe;
  const cfg = simConfig({ ...base, universe, model: { ...base.model, decider: "none" } });
  const date = opt("date") ?? nextSessionAfter(nyDate(Date.now())).date;
  const dir = mkdtempSync(path.join(stateDir(), "sim-"));
  process.env.FIFTY_STATE_DIR = dir;
  console.log(`simulate-session: ${date}, simulated broker and clock, state in ${dir}. No network, no real orders.`);
  const { engine, mock } = await simulate({ cfg, date, cash: Number(opt("cash") ?? 50), quiet: false, faults: flag("lost-response") ? { placeLostResponse: 1 } : undefined });
  const r = JSON.parse(readFileSync(path.join(engine.store.dir, "report.json"), "utf8"));
  console.log(renderMarkdown(r));
  console.log(`simulated broker received ${mock.calls.length} tool calls; ${mock.calls.filter((c) => c.tool === "place_equity_order").length} placements. Journal: ${engine.store.journal}`);
  return engine.s.phase === "COMPLETE" ? 0 : 1;
}

async function arm(): Promise<number> {
  const date = opt("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("usage: fifty arm-session --date YYYY-MM-DD");
  const sess = sessionOn(date);
  if (!sess) throw new Error(`${date} is not an NYSE trading day`);
  if (Date.now() >= sess.closeMs) throw new Error(`${date}'s session has already closed`);
  const existing = readArmed();
  if (existing) throw new Error(`already armed for ${existing.date}; run fifty disarm first`);
  const { config, sha256, text } = loadConfig();
  if (/REPLACE/.test(text)) throw new Error(`${configPath()} still has REPLACE placeholders`);
  if (config.model.decider === "claude" && !anthropicKey()) throw new Error("model decider is claude but no Anthropic key (env ANTHROPIC_API_KEY or Keychain fifty-anthropic)");
  if (!existsSync(tokenPath())) throw new Error("no Robinhood sign-in; run fifty login first");
  console.log(`\nArming ONE live session. After this, the runner trades without asking, within:\n\n${summary(config, date, sha256)}\n`);
  if (!flag("yes")) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = await rl.question(`Type ARM ${date} to arm, anything else to abort: `);
    rl.close();
    if (answer.trim() !== `ARM ${date}`) {
      console.log("aborted; nothing armed");
      return 1;
    }
  }
  for (const f of ["PAUSE", "KILL", "FLATTEN"] as const) if (existsSync(controlFile(f))) unlinkSync(controlFile(f));
  const armed: Armed = { date, armed_at: new Date().toISOString(), config_sha256: sha256, config };
  writeFileAtomic(armedFile(), `${JSON.stringify(armed, null, 1)}\n`);
  installAgent();
  const precheck = new Date(sess.openMs - config.session.precheck_minutes_before_open * 60_000 - 5 * 60_000);
  const p = (n: number) => String(n).padStart(2, "0");
  console.log(`\narmed. launchd agent loaded: ${agentStatus()}`);
  console.log(`To wake this Mac from sleep before precheck (needs your password):\n  sudo pmset schedule wake "${p(precheck.getMonth() + 1)}/${p(precheck.getDate())}/${precheck.getFullYear()} ${p(precheck.getHours())}:${p(precheck.getMinutes())}:00"`);
  console.log("Watch: fifty status   Pause entries: fifty pause   Kill switch: fifty stop [--flatten]   Undo: fifty disarm");
  return 0;
}

async function run(): Promise<number> {
  const armed = readArmed();
  if (!armed) {
    console.log(`${new Date().toISOString()} run: not armed; exiting`);
    return 0;
  }
  const release = acquireRunnerLock();
  try {
    const cfg = armed.config; // frozen at arming; later edits to config/fifty.json are ignored
    const current = existsSync(configPath()) ? loadConfig().sha256 : undefined;
    if (current && current !== armed.config_sha256) console.log("note: config/fifty.json changed after arming; the armed copy is used");
    const key = cfg.model.decider === "claude" ? anthropicKey() : undefined;
    if (key) process.env.ANTHROPIC_API_KEY = key;
    const engine = new Engine({
      cfg, armedSha: armed.config_sha256, date: armed.date, clock: realClock, controls, notify,
      connect: async () => new Robinhood(await connect(), cfg.boundaries.account_number, { trading: true, timeoutMs: cfg.execution.call_timeout_ms }),
      reviewer: key ? claudeReviewer(cfg.model) : undefined,
      onStatus: (s) => writeFileAtomic(statusFile(), `${JSON.stringify(s, null, 1)}\n`),
    });
    for (const sig of ["SIGTERM", "SIGINT"] as const) process.on(sig, () => engine.stop());
    console.log(`${new Date().toISOString()} run: ${armed.date}, phase ${engine.s.phase}`);
    const s = await engine.run();
    if (s.phase === "COMPLETE") {
      // One session only: disarm so a reboot or next login never repeats the experiment.
      renameSync(armedFile(), path.join(sessionDir(armed.date), "armed.json"));
      // Exit 0 means launchd will not restart us; removing the plist stops it loading at next login.
      if (existsSync(plistPath())) unlinkSync(plistPath());
    }
    return 0;
  } finally {
    release();
  }
}

function status(): number {
  const armed = readArmed();
  console.log(`armed: ${armed ? armed.date : "no"}   launchd: ${agentStatus()}`);
  const c = controls();
  console.log(`controls: paused=${c.paused} kill=${c.killed} flatten=${c.flatten}`);
  if (existsSync(statusFile())) {
    const s = JSON.parse(readFileSync(statusFile(), "utf8"));
    const age = Math.round((Date.now() - Date.parse(s.now)) / 1000);
    console.log(JSON.stringify(s, null, 1));
    if (armed && age > 120) console.log(`WARNING: last status is ${age}s old; the runner may be asleep, stopped or waiting for precheck`);
  } else console.log("no status yet");
  const log = path.join(stateDir(), "logs", "runner.log");
  if (existsSync(log)) console.log(`log: ${log}`);
  return 0;
}

function touch(name: "PAUSE" | "KILL" | "FLATTEN"): void {
  writeFileSync(controlFile(name), new Date().toISOString());
}

function report(): number {
  const date = opt("date") ?? readArmed()?.date ?? nyDate(Date.now());
  const store = new Store(date);
  const final = path.join(store.dir, "report.md");
  if (existsSync(final) && !flag("live")) {
    console.log(readFileSync(final, "utf8"));
    return 0;
  }
  const s = store.load();
  if (!s) {
    console.log(`no session state for ${date}`);
    return 1;
  }
  const cfg = readArmed()?.config ?? loadConfig().config;
  console.log("(interim report from session.json; unrealized P&L needs live quotes and shows n/a)\n");
  console.log(renderMarkdown(buildReport(s, cfg, books(s.orders), new Map(), false, Date.now())));
  return 0;
}

async function main(): Promise<number> {
  switch (cmd) {
    case "doctor": return doctor();
    case "simulate-session": return simulateCmd();
    case "arm-session": return arm();
    case "disarm":
      if (existsSync(armedFile())) unlinkSync(armedFile());
      removeAgent();
      console.log("disarmed; launchd agent removed. A runner already inside a session keeps managing exits only if restarted manually.");
      return 0;
    case "run": return run();
    case "status": return status();
    case "pause": touch("PAUSE"); console.log("paused: no new entries; exits and monitoring continue"); return 0;
    case "resume": if (existsSync(controlFile("PAUSE"))) unlinkSync(controlFile("PAUSE")); console.log("resumed"); return 0;
    case "stop":
      touch("KILL");
      if (flag("flatten")) touch("FLATTEN");
      console.log(`kill switch set: no new entries, entry orders cancelled${flag("flatten") ? ", all experiment positions sold" : ", positions still managed by their exits and the wind-down"}`);
      return 0;
    case "report": return report();
    case "login": {
      const n = await login({ serverUrl: ROBINHOOD_MCP_URL });
      console.log(`signed in; stored at ${tokenPath()} (0600). Server lists ${n} tools. No tool was called.`);
      return 0;
    }
    default:
      console.log("usage: fifty doctor | simulate-session [--date D] | arm-session --date D [--yes] | disarm | status | pause | resume | stop [--flatten] | report [--date D] | login");
      return cmd ? 1 : 0;
  }
}

main().then((code) => { process.exitCode = code; }, (err) => { console.error(`fifty ${cmd}: ${err instanceof Error ? err.message : err}`); process.exitCode = 1; });
