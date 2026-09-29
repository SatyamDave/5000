import assert from "node:assert/strict";
import { test } from "node:test";
import { nextSessionAfter, nyDate, nyTime, sessionOn } from "../src/calendar.js";

test("regular session in daylight time opens 13:30Z and closes 20:00Z", () => {
  const s = sessionOn("2026-09-30")!;
  assert.equal(new Date(s.openMs).toISOString(), "2026-09-30T13:30:00.000Z");
  assert.equal(new Date(s.closeMs).toISOString(), "2026-09-30T20:00:00.000Z");
});

test("standard time after the November DST change opens 14:30Z", () => {
  assert.equal(new Date(sessionOn("2026-11-02")!.openMs).toISOString(), "2026-11-02T14:30:00.000Z");
  assert.equal(new Date(sessionOn("2026-03-06")!.openMs).toISOString(), "2026-03-06T14:30:00.000Z");
  assert.equal(new Date(sessionOn("2026-03-09")!.openMs).toISOString(), "2026-03-09T13:30:00.000Z");
});

test("holidays and weekends have no session", () => {
  for (const d of ["2026-11-26", "2026-12-25", "2026-07-03", "2027-03-26", "2027-12-24", "2026-10-03", "2026-10-04"]) assert.equal(sessionOn(d), undefined, d);
});

test("early closes end at 13:00 ET", () => {
  const s = sessionOn("2026-11-27")!;
  assert.equal(s.earlyClose, true);
  assert.equal(new Date(s.closeMs).toISOString(), "2026-11-27T18:00:00.000Z");
  assert.equal(sessionOn("2026-12-24")!.earlyClose, true);
});

test("next session skips weekends and holidays", () => {
  assert.equal(nextSessionAfter("2026-11-25").date, "2026-11-27");
  assert.equal(nextSessionAfter("2026-10-02").date, "2026-10-05");
  assert.equal(nextSessionAfter("2026-12-31").date, "2027-01-04");
});

test("an uncovered year fails closed", () => {
  assert.throws(() => sessionOn("2028-01-03"), /not in src\/calendar.ts/);
});

test("nyDate/nyTime round-trip around midnight ET", () => {
  assert.equal(nyDate(Date.parse("2026-10-01T03:59:00Z")), "2026-09-30");
  assert.equal(nyTime("2026-09-30", 23, 59), Date.parse("2026-10-01T03:59:00Z"));
});
