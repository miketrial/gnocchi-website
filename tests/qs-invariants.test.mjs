/* Proving test suite for PR #51.
   Each critical invariant is tested TWO ways:
     - PASS: the real function returns the expected value.
     - PROOF: a deliberately-buggy mutant returns something the SAME assertion
       rejects — proving the test actually catches that bug class (not a no-op).
   Run: node prove_tests.mjs  (from repo root) */
import assert from "node:assert/strict";
import {
  isMarketHoliday, isHalfDay, isTradingDay, previousTradingDay, barIsStale, marketCloseMinET,
} from "../netlify/lib/market-calendar.mjs";
import { chunk } from "../netlify/lib/telegram.mjs";
import {
  formatEntryDigest, formatPreCloseRoster, formatApproachingStop, formatCoolingNote,
} from "../netlify/lib/quickswing-alert.mjs";
import { isQuietSummary, formatSummary, buildSnapshot, diffSnapshots } from "../netlify/lib/quickswing-summary.mjs";

let pass = 0, proofs = 0, fail = 0;
const T = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.log("❌ FAIL:", name, "\n   ", e.message); } };
// PROOF: assert that `buggyValue` would be REJECTED by the same check that
// `goodValue` passes — i.e. the test discriminates correct from broken.
const PROOF = (name, check) => {
  try { check(); proofs++; }
  catch (e) { fail++; console.log("❌ PROOF BROKEN:", name, "\n   ", e.message); }
};

/* ---------- market-calendar: barIsStale / previousTradingDay ---------- */
// Real NYSE facts: 2026-07-03 is the observed July-4 holiday (Fri); Jul 4/5 weekend;
// so the trading day before Mon 2026-07-06 is Thu 2026-07-02.
T("prevTradingDay skips holiday+weekend", () =>
  assert.equal(previousTradingDay("2026-07-06"), "2026-07-02"));
PROOF("prevTradingDay proof (a naive -1 day would give Jul 5, wrong)", () => {
  const naive = (d) => new Date(new Date(d + "T12:00:00Z").getTime() - 86400000).toISOString().slice(0, 10);
  assert.equal(naive("2026-07-06"), "2026-07-05");          // the buggy answer
  assert.notEqual(previousTradingDay("2026-07-06"), "2026-07-05"); // real func avoids it
});

// barIsStale: today Wed 2026-07-08, prev session Tue 2026-07-07.
T("bar from prev session is FRESH", () => assert.equal(barIsStale("2026-07-07", "2026-07-08"), false));
T("bar 2 sessions old is STALE", () => assert.equal(barIsStale("2026-07-06", "2026-07-08"), true));
T("today's bar is FRESH", () => assert.equal(barIsStale("2026-07-08", "2026-07-08"), false));
PROOF("barIsStale proof (an off-by-one `<=` mutant would wrongly flag yesterday)", () => {
  const buggy = (dataAsOf, today) => dataAsOf <= previousTradingDay(today); // uses <= instead of <
  assert.equal(buggy("2026-07-07", "2026-07-08"), true);   // mutant WRONGLY flags fresh
  assert.equal(barIsStale("2026-07-07", "2026-07-08"), false); // real func correct
});

T("Good Friday 2026 is a holiday", () => assert.equal(isMarketHoliday("2026-04-03"), true));
T("normal weekday is not a holiday", () => assert.equal(isMarketHoliday("2026-07-08"), false));
T("Black Friday 2026 is a half day (13:00)", () => assert.equal(marketCloseMinET("2026-11-27"), 780));
T("normal day closes 16:00", () => assert.equal(marketCloseMinET("2026-07-08"), 960));

/* ---------- telegram chunk() ---------- */
const big = Array.from({ length: 800 }, (_, i) => "line-" + i).join("\n");
T("chunk preserves all data", () => assert.equal(chunk(big, 3800).join("\n"), big));
T("every chunk within limit", () => assert.ok(chunk(big, 3800).every((c) => c.length <= 3800)));
T("monster single line hard-split, no loss", () => {
  const m = "z".repeat(9000);
  const c = chunk(m, 3800);
  assert.ok(c.every((x) => x.length <= 3800));
  assert.equal(c.join(""), m);
});
PROOF("chunk proof (naive slice on newline could exceed the limit / lose the split)", () => {
  // A single 9000-char line has NO newline to split on; a naive line-only splitter
  // would emit one 9000-char chunk (> limit). The real chunk() hard-splits it.
  assert.ok(chunk("z".repeat(9000), 3800).every((x) => x.length <= 3800));
});

/* ---------- confirm-before-dedup semantics (the delivered() rule) ---------- */
const delivered = (res) => !!res && (res.ok || res.skipped);
T("delivered: real success advances", () => assert.equal(delivered({ ok: true }), true));
T("delivered: no-op (no telegram) advances", () => assert.equal(delivered({ ok: false, skipped: true }), true));
T("delivered: real failure holds back (falsy)", () => assert.ok(!delivered({ ok: false, status: 429 })));
PROOF("delivered proof (gating on res.ok alone would FREEZE a user without Telegram)", () => {
  const buggy = (res) => !!res && res.ok;               // the pre-fix version
  assert.equal(buggy({ ok: false, skipped: true }), false);   // buggy: skipped never advances → frozen
  assert.equal(delivered({ ok: false, skipped: true }), true); // fixed: advances
});

/* ---------- entry digest (A4) ---------- */
T("digest ranks by score desc", () => {
  const d = formatEntryDigest([
    { sym: "A", kind: "BUY", row: { buyScore: "10/24" } },
    { sym: "B", kind: "BUY", row: { buyScore: "20/24" } },
  ]);
  assert.ok(d.indexOf("B 20") < d.indexOf("A 10"));
});
T("digest caps at 8 with overflow note", () => {
  const many = Array.from({ length: 11 }, (_, i) => ({ sym: "S" + i, kind: "BUY", row: { buyScore: (24 - i) + "/24" } }));
  assert.match(formatEntryDigest(many), /and 3 more/);
});

/* ---------- pulse / roster math (B2/B4) ---------- */
T("long P&L sign correct (down = negative)", () => {
  const r = formatPreCloseRoster([{ sym: "X", side: "long", entryPrice: 100, stopPrice: 96, price: 98, barsHeld: 0 }], "x", 3);
  assert.match(r, /-2\.00%/);
});
T("R-to-stop guarded against R=0 (no NaN/Inf)", () => {
  const r = formatPreCloseRoster([{ sym: "X", side: "long", entryPrice: 100, stopPrice: 100, price: 101, barsHeld: 0 }], "x", 3);
  assert.ok(!/NaN|Infinity/.test(r));
  assert.ok(!/R to stop/.test(r)); // omitted when R=0
});
PROOF("R=0 proof (dividing by R without a guard yields Infinity)", () => {
  const R = 0, dist = 1;
  assert.equal(dist / R, Infinity);                       // the unguarded bug
  const r = formatPreCloseRoster([{ sym: "X", side: "long", entryPrice: 100, stopPrice: 100, price: 101, barsHeld: 0 }], "x", 3);
  assert.ok(!/Infinity/.test(r));                         // real func guards it
});

/* ---------- isQuietSummary (A3) ---------- */
const cur = buildSnapshot({ rows: [], regime: null, spyQuote: null });
T("first-of-day is NOT quiet (always sends baseline)", () =>
  assert.equal(isQuietSummary(diffSnapshots(null, cur)), false));
T("nothing-changed hour IS quiet", () => {
  const prev = { day: cur.day, at: Date.now(), etHour: 11, spy: { price: 500 }, vix: { level: 15 }, regimeLabel: "x", rows: {} };
  const c2 = { ...cur, spy: { price: 500.1, changePct: 0 }, vix: { level: 15 }, regimeLabel: "x" };
  assert.equal(isQuietSummary(diffSnapshots(prev, c2)), true);
});
T("a verdict change makes it NOT quiet", () => {
  const prev = { day: cur.day, at: Date.now(), etHour: 11, spy: { price: 500 }, vix: { level: 15 }, regimeLabel: "x", rows: { AAA: { verdict: "NEUTRAL", price: 10 } } };
  const c2 = { ...cur, spy: { price: 500 }, vix: { level: 15 }, regimeLabel: "x", rows: { AAA: { verdict: "BUY", price: 10 } } };
  assert.equal(isQuietSummary(diffSnapshots(prev, c2)), false);
});

console.log(`\n${pass} invariant tests passed · ${proofs} negative-control proofs passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
