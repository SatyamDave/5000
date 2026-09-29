import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseConfig } from "../src/config.js";
import type { Config } from "../src/config.js";
import { projectRoot } from "../src/paths.js";
import { SIM_ACCOUNT } from "../src/sim.js";

export const DAY = "2026-09-30"; // Wednesday, regular session

/** Fresh state dir per test so sessions never bleed into each other. */
export function freshStateDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fifty-test-"));
  process.env.FIFTY_STATE_DIR = dir;
  process.env.FIFTY_NO_NOTIFY = "1";
  return dir;
}

export function testConfig(over: (c: Config) => void = () => undefined): Config {
  const c = parseConfig(readFileSync(path.join(projectRoot(), "config", "fifty.example.json"), "utf8"));
  c.boundaries.account_number = SIM_ACCOUNT;
  c.universe = ["SIMA", "SIMB", "SIMC", "SIMD", "SIME", "SIMF"];
  c.universe_lists = [];
  over(c);
  return c;
}

/** A price path that rises steadily after the opening range, so the breakout rule enters. */
export function rising(openMs: number, start = 10, perMinute = 0.001) {
  return (_symbol: string, ms: number) => {
    const m = Math.max(0, (ms - openMs) / 60_000);
    const wobble = m < 20 ? Math.sin(m) * 0.01 : 0;
    return Math.round(start * (1 + wobble + (m > 20 ? (m - 20) * perMinute : 0)) * 100) / 100;
  };
}

export const placements = (calls: Array<{ tool: string; args: Record<string, unknown> }>) => calls.filter((c) => c.tool === "place_equity_order");
