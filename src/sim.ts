// simulate-session: the real Engine, the real Robinhood client code, a simulated clock and the
// simulated MCP server. No network, no credentials, no real orders.
import { MockRobinhood } from "./broker/mock-server.js";
import type { MockFaults } from "./broker/mock-server.js";
import { connect, Robinhood } from "./broker/robinhood.js";
import { sessionOn } from "./calendar.js";
import type { Config } from "./config.js";
import type { Reviewer } from "./decider/claude.js";
import { Engine } from "./engine.js";
import type { Controls } from "./engine.js";

export const SIM_ACCOUNT = "SIMACCT0001";

export interface SimOptions {
  cfg: Config;
  date: string;
  cash?: number;
  prices?: Record<string, number>;
  pricePath?: (symbol: string, ms: number) => number;
  faults?: MockFaults;
  holdings?: Record<string, number>;
  accountType?: "cash" | "limited_margin";
  fractional?: boolean;
  agenticAllowed?: boolean;
  /** The account the simulated broker owns (default: the configured one). */
  mockAccount?: string;
  /** Start this many minutes before the open (default: 1 minute before precheck). */
  startMinutesBeforeOpen?: number;
  startMs?: number;
  controls?: (now: number) => Partial<Controls>;
  /** Called before every engine step, with the sim clock and mock (inject faults mid-run). */
  onStep?: (now: number, mock: MockRobinhood, engine: Engine) => void;
  reviewer?: Reviewer;
  maxIterations?: number;
  mock?: MockRobinhood;
  quiet?: boolean;
}

export function simConfig(cfg: Config): Config {
  return { ...cfg, boundaries: { ...cfg.boundaries, account_number: SIM_ACCOUNT } };
}

export async function simulate(o: SimOptions) {
  const sess = sessionOn(o.date);
  if (!sess) throw new Error(`${o.date} is not an NYSE trading day`);
  let now = o.startMs ?? sess.openMs - ((o.startMinutesBeforeOpen ?? o.cfg.session.precheck_minutes_before_open + 1) * 60_000);
  const clock = { now: () => now, sleep: async (ms: number) => { now += Math.max(1000, ms); } };
  const syms = o.cfg.universe.length ? o.cfg.universe : ["SIMA", "SIMB", "SIMC", "SIMD", "SIME", "SIMF"];
  const prices = o.prices ?? Object.fromEntries(syms.map((s, i) => [s, 5 + i * 3.7]));
  const mock = o.mock ?? new MockRobinhood({
    account: o.mockAccount ?? o.cfg.boundaries.account_number, cash: o.cash ?? 50, prices, pricePath: o.pricePath, now: clock.now, faults: o.faults,
    holdings: o.holdings, accountType: o.accountType, fractional: o.fractional, agenticAllowed: o.agenticAllowed,
  });
  const notes: string[] = [];
  const engine = new Engine({
    cfg: o.cfg, armedSha: "simulation", date: o.date, clock,
    connect: async () => new Robinhood(await connect({ transport: await mock.start() }), o.cfg.boundaries.account_number, { trading: true, timeoutMs: o.cfg.execution.call_timeout_ms }),
    controls: () => ({ paused: false, killed: false, flatten: false, ...o.controls?.(now) }),
    notify: (t, m) => { notes.push(`${t}: ${m}`); if (!o.quiet) console.log(`[notify] ${t}: ${m}`); },
    reviewer: o.reviewer,
    maxIterations: o.maxIterations ?? 20_000,
  });
  const origStep = engine.step.bind(engine);
  engine.step = async () => {
    o.onStep?.(now, mock, engine);
    return origStep();
  };
  const state = await engine.run();
  return { engine, mock, state, notes, clock };
}
