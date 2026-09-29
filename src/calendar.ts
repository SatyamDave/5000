// NYSE regular-session calendar. Source: https://www.nyse.com/trade/hours-calendars (checked
// 2026-09-29). A date outside the covered years throws: no guessing a session that may not exist.
// Only US equities are in scope (config refuses other asset classes), so this is the only calendar.

const HOLIDAYS: Record<number, string[]> = {
  2026: ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"],
  2027: ["2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24"],
};
/** 1:00 p.m. ET closes. */
const EARLY_CLOSES: Record<number, string[]> = {
  2026: ["2026-11-27", "2026-12-24"],
  2027: ["2027-11-26"],
};

export const TZ = "America/New_York";

export interface Session {
  date: string; // YYYY-MM-DD, New York trading date
  openMs: number;
  closeMs: number;
  earlyClose: boolean;
}

const dateRe = /^(\d{4})-(\d{2})-(\d{2})$/;

/** New York wall-clock parts of an instant. */
function nyParts(ms: number): Record<string, number> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(ms));
  const out: Record<string, number> = {};
  for (const p of parts) if (p.type !== "literal") out[p.type] = Number(p.value);
  return out;
}

/** The instant a New York wall-clock time occurs (DST-aware). */
export function nyTime(date: string, hour: number, minute: number): number {
  const m = dateRe.exec(date);
  if (!m) throw new Error(`bad date ${date}`);
  const wall = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), hour, minute);
  let guess = wall + 5 * 3600_000; // EST; corrected below
  for (let i = 0; i < 2; i++) {
    const p = nyParts(guess);
    const seen = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!);
    guess += wall - seen;
  }
  return guess;
}

/** The New York calendar date of an instant. */
export function nyDate(ms: number): string {
  const p = nyParts(ms);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function covered(year: number): void {
  if (!HOLIDAYS[year]) throw new Error(`NYSE calendar for ${year} is not in src/calendar.ts; add it from nyse.com before trading that year`);
}

/** The regular session on `date`, or undefined for weekends and holidays. */
export function sessionOn(date: string): Session | undefined {
  const m = dateRe.exec(date);
  if (!m) throw new Error(`bad date ${date}`);
  const year = Number(m[1]);
  covered(year);
  const weekday = new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]))).getUTCDay();
  if (weekday === 0 || weekday === 6 || HOLIDAYS[year]!.includes(date)) return undefined;
  const earlyClose = EARLY_CLOSES[year]!.includes(date);
  return { date, openMs: nyTime(date, 9, 30), closeMs: nyTime(date, earlyClose ? 13 : 16, 0), earlyClose };
}

/** The first regular session strictly after `date`. */
export function nextSessionAfter(date: string): Session {
  let ms = nyTime(date, 12, 0);
  for (let i = 0; i < 14; i++) {
    ms += 24 * 3600_000;
    const s = sessionOn(nyDate(ms));
    if (s) return s;
  }
  throw new Error(`no NYSE session within 14 days after ${date}`);
}

export function isoNy(ms: number): string {
  const p = nyParts(ms);
  const pad = (n: number | undefined) => String(n).padStart(2, "0");
  return `${nyDate(ms)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)} ET`;
}
