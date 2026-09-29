import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let root: string | undefined;

/** The directory holding this project's package.json, from src/ or anywhere below it. */
export function projectRoot(): string {
  if (root) return root;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(path.join(dir, "package.json")) && existsSync(path.join(dir, "src", "cli.ts"))) return (root = dir);
    dir = path.dirname(dir);
  }
  throw new Error("could not locate the fifty project root");
}

/** Runtime state: session files, control files, logs. FIFTY_STATE_DIR overrides (tests, simulation). */
export function stateDir(): string {
  const dir = path.resolve(process.env.FIFTY_STATE_DIR ?? path.join(projectRoot(), "state"));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function sessionDir(date: string): string {
  const dir = path.join(stateDir(), "sessions", date);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export const controlFile = (name: "PAUSE" | "KILL" | "FLATTEN") => path.join(stateDir(), name);
export const armedFile = () => path.join(stateDir(), "armed.json");
export const statusFile = () => path.join(stateDir(), "status.json");
export const runnerLockFile = () => path.join(stateDir(), "runner.lock");
