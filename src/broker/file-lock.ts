// Vendored unchanged from fall_forward_labs agent/src/broker/file-lock.ts @ e29a4c5 (same owner).
// A cross-process lock beside a file, for the one critical section that must not run twice at
// once on a host: refreshing the Robinhood sign-in, whose refresh tokens are single-use. Stdlib
// only: the lock is a file created with O_EXCL ("wx") holding the holder's pid and a nonce.
import { closeSync, linkSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { randomBytes } from "node:crypto";

export interface LockOptions {
  /** How long to wait for another holder before failing closed. */
  waitMs?: number;
  /** A lock older than this is treated as abandoned even if its pid is alive (pid reuse, or a
   *  holder hung past every timeout inside the critical section). */
  staleMs?: number;
  pollMs?: number;
}

const DEFAULTS = { waitMs: 30_000, staleMs: 60_000, pollMs: 50 };

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function errCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException).code;
}

/** Removes the lock if its holder is dead or it is older than staleMs. Moves it aside with an
 *  atomic rename first, so two waiters breaking the same stale lock cannot delete each other's
 *  fresh one; a waiter that finds it moved a lock it did not judge stale puts it back. */
function breakIfStale(lockFile: string, staleMs: number): void {
  let seen: string;
  let ageMs: number;
  try {
    seen = readFileSync(lockFile, "utf8");
    ageMs = Date.now() - statSync(lockFile).mtimeMs;
  } catch (err) {
    if (errCode(err) === "ENOENT") return;
    throw err;
  }
  const pid = Number.parseInt(seen, 10);
  // A lock with no readable pid may be one a live process has created but not yet written.
  const holderDead = Number.isInteger(pid) && pid > 0 && !pidAlive(pid);
  if (!holderDead && ageMs < staleMs) return;
  const aside = `${lockFile}.${process.pid}.${randomBytes(4).toString("hex")}.stale`;
  try {
    renameSync(lockFile, aside);
  } catch (err) {
    if (errCode(err) === "ENOENT") return;
    throw err;
  }
  // ponytail: safe for the two contenders this host runs (recorder, gateway); with three, a
  // third could create the lock between the rename and the link below.
  if (readFileSync(aside, "utf8") !== seen) {
    try {
      linkSync(aside, lockFile);
    } catch (err) {
      if (errCode(err) !== "EEXIST") throw err;
    }
  }
  unlinkSync(aside);
}

async function acquire(lockFile: string, opts: Required<LockOptions>): Promise<string> {
  const token = `${process.pid} ${randomBytes(8).toString("hex")}\n`;
  const deadline = Date.now() + opts.waitMs;
  for (;;) {
    try {
      const fd = openSync(lockFile, "wx", 0o600);
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
      return token;
    } catch (err) {
      if (errCode(err) !== "EEXIST") throw err;
    }
    breakIfStale(lockFile, opts.staleMs);
    if (Date.now() >= deadline) {
      throw new Error(`timed out after ${opts.waitMs}ms waiting for the lock at ${lockFile}, held by another process`);
    }
    await new Promise((res) => setTimeout(res, opts.pollMs));
  }
}

function release(lockFile: string, token: string): void {
  try {
    // Only our own lock: if it was broken as stale and someone else holds it now, leave theirs.
    if (readFileSync(lockFile, "utf8") === token) unlinkSync(lockFile);
  } catch (err) {
    if (errCode(err) !== "ENOENT") throw err;
  }
}

/** Runs fn while holding lockFile. Fails closed (throws, fn never runs) if the lock stays held
 *  by a live process for longer than waitMs. */
export async function withFileLock<T>(lockFile: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const opts = { ...DEFAULTS, ...options };
  const token = await acquire(lockFile, opts);
  try {
    return await fn();
  } finally {
    release(lockFile, token);
  }
}
