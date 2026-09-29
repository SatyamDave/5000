import { closeSync, fsyncSync, openSync, renameSync, writeSync, appendFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

// ponytail: dollars and shares are JS numbers rounded at every boundary (cents, 1e-6 shares).
// Fine at a $50-$5,000 scale; switch to bigint fixed-point if the account grows past ~$1e9.
export const cents = (x: number) => Math.round(x * 100) / 100;
export const floorCents = (x: number) => Math.floor(x * 100 + 1e-9) / 100;
export const shares = (x: number) => Math.round(x * 1e6) / 1e6;

/** A decimal string the broker returned, as a number. Throws on anything that is not one. */
export function num(value: unknown, what: string): number {
  if (typeof value !== "string" || !/^-?\d+(\.\d+)?$/.test(value.trim())) {
    throw new Error(`${what} is ${JSON.stringify(value)}, not a decimal string`);
  }
  return Number(value);
}

export function optNum(value: unknown, what: string): number | undefined {
  return value === null || value === undefined || value === "" ? undefined : num(value, what);
}

/** Decimal string for the wire: no exponent, no trailing zeros. */
export function dec(x: number, places: number): string {
  return x.toFixed(places).replace(/\.?0+$/, "") || "0";
}

/** Write-temp-fsync-rename, so a crash never leaves a half-written file. */
export function writeFileAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
}

export function appendLine(file: string, obj: unknown): void {
  appendFileSync(file, `${JSON.stringify(obj)}\n`, { mode: 0o600 });
}

/** "••••1234" -- how an account number is ever shown. */
export const mask = (account: string) => `••••${account.slice(-4)}`;
