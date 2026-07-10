/* Swing backtest engine — recordShortTransition (the LONG-ONLY as-if state
   machine), the rolling-window prune, the seed merge, and the SPY benchmark
   math (short-backtest.mjs). These are the functions the live rescan and the
   lazy seed fold every scored bar through, so a regression here silently
   corrupts every trade in the popover. Run: node tests/swing-engine.test.mjs */
import assert from "node:assert/strict";
import {
  recordShortTransition, pruneShortWindow, mergeShortSeed, emptyShortLog, needsShortSeed,
  shortSpyReturnBetween, annotateShortBenchmarks, sessionComplete,
  SBT_STOP_ATR_MULT, SBT_TIME_STOP_DAYS, SBT_SEED_VERSION,
} from "../netlify/lib/short-backtest.mjs";

let pass = 0, proofs = 0, fail = 0;
const T = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.log("❌ FAIL:", name, "\n   ", e.message); } };
const PROOF = (name, fn) => { try { fn(); proofs++; } catch (e) { fail++; console.log("❌ PROOF BROKEN:", name, "\n   ", e.message); } };

// Minimal signal shape the state machine reads.
const sig = (o) => ({
  bar: { date: o.date, open: o.open ?? o.close, high: o.high ?? o.close, low: o.low ?? o.close, close: o.close },
  atr14: o.atr14 ?? 2,
  entryStrong: o.entryStrong ?? false,
  deathCross: o.deathCross ?? false,
});
const enter = (date = "2026-01-05", close = 100, atr14 = 2) =>
  recordShortTransition("X", sig({ date, close, atr14, entryStrong: true }), null);

/* ---------- ENTRY ---------- */
T("entry opens a long at close with a 4×ATR stop", () => {
  const log = enter("2026-01-05", 100, 2);
  assert.equal(log.open.side, "long");
  assert.equal(log.open.entryPrice, 100);
  assert.equal(log.open.stopPrice, 100 - SBT_STOP_ATR_MULT * 2); // 92
  assert.equal(log.open.barsHeld, 0);
  assert.equal(log.closed.length, 0);
});
T("no entry when the bar is not entryStrong", () => {
  const log = recordShortTransition("X", sig({ date: "2026-01-05", close: 100, entryStrong: false }), null);
  assert.equal(log.open, null);
});
T("null stop when ATR is unavailable", () => {
  const log = recordShortTransition("X", sig({ date: "2026-01-05", close: 100, atr14: 0, entryStrong: true }), null);
  assert.equal(log.open.stopPrice, null);
});

/* ---------- STOP fills ---------- */
T("STOP: intraday touch fills at the stop line", () => {
  const open = enter();
  const log = recordShortTransition("X", sig({ date: "2026-01-06", close: 95, open: 95, high: 96, low: 90 }), open);
  assert.equal(log.open, null);
  assert.equal(log.closed[0].exitReason, "STOP");
  assert.equal(log.closed[0].exitPrice, 92);       // low 90 ≤ stop 92, open 95 > stop ⇒ fill at stop
  assert.equal(log.closed[0].pnlPct, -8);
});
T("STOP: gap-through-open fills at the (worse) open", () => {
  const open = enter();
  const log = recordShortTransition("X", sig({ date: "2026-01-06", close: 88, open: 90, high: 91, low: 87 }), open);
  assert.equal(log.closed[0].exitReason, "STOP");
  assert.equal(log.closed[0].exitPrice, 90);       // gap: open 90 ≤ stop 92 ⇒ fill at open
  assert.equal(log.closed[0].pnlPct, -10);
});
T("STOP: snapshot with no intraday low fills at min(close, stop)", () => {
  const open = enter();
  const log = recordShortTransition("X", sig({ date: "2026-01-06", close: 90, open: 0, high: 0, low: 0 }), open);
  assert.equal(log.closed[0].exitReason, "STOP");
  assert.equal(log.closed[0].exitPrice, 90);       // no low ⇒ min(close 90, stop 92)
});
PROOF("STOP proof: a gap-down open must NOT be flattered to the stop price", () => {
  const open = enter();
  const log = recordShortTransition("X", sig({ date: "2026-01-06", close: 88, open: 90, high: 91, low: 87 }), open);
  assert.notEqual(log.closed[0].exitPrice, 92);    // buggy "always fill at stop" would book −8% not −10%
});

/* ---------- TREND (death cross) & priority ---------- */
T("TREND: death cross exits at the close (trend is over)", () => {
  const open = enter();
  const log = recordShortTransition("X", sig({ date: "2026-01-06", close: 105, low: 104, deathCross: true }), open);
  assert.equal(log.closed[0].exitReason, "TREND");
  assert.equal(log.closed[0].exitPrice, 105);
  assert.equal(log.closed[0].pnlPct, 5);
});
T("priority: STOP beats TREND when both fire on the same bar", () => {
  const open = enter();
  const log = recordShortTransition("X", sig({ date: "2026-01-06", close: 91, low: 90, deathCross: true }), open);
  assert.equal(log.closed[0].exitReason, "STOP");  // stop is checked first
});

/* ---------- TIME cap ---------- */
T("TIME: exits after the 63-session cap", () => {
  const open = enter();
  open.open.barsHeld = SBT_TIME_STOP_DAYS - 1;      // one session short of the cap
  open.open.lastSessionDate = "2026-04-01";
  const log = recordShortTransition("X", sig({ date: "2026-04-02", close: 130, low: 129 }), open);
  assert.equal(log.open, null);
  assert.equal(log.closed[0].exitReason, "TIME");
  assert.equal(log.closed[0].exitPrice, 130);
});

/* ---------- barsHeld counts once per session date ---------- */
T("barsHeld increments once per NEW session date, not per rescan", () => {
  let log = enter("2026-01-05", 100, 2);            // barsHeld 0
  log = recordShortTransition("X", sig({ date: "2026-01-06", close: 101, low: 100 }), log); // new day ⇒ 1
  const after1 = log.open.barsHeld;
  log = recordShortTransition("X", sig({ date: "2026-01-06", close: 102, low: 101 }), log); // same day ⇒ still 1
  assert.equal(after1, 1);
  assert.equal(log.open.barsHeld, 1);
});
PROOF("barsHeld proof: two intraday rescans on one date must not double-count", () => {
  let log = enter("2026-01-05", 100, 2);
  log = recordShortTransition("X", sig({ date: "2026-01-06", close: 101, low: 100 }), log);
  log = recordShortTransition("X", sig({ date: "2026-01-06", close: 102, low: 101 }), log);
  assert.notEqual(log.open.barsHeld, 2);            // a naive per-call ++ would give 2
});

/* ---------- unscoreable bar leaves the position untouched ---------- */
T("unscoreable bar (close ≤ 0) preserves the open position", () => {
  const open = enter();
  const log = recordShortTransition("X", sig({ date: "2026-01-06", close: 0 }), open);
  assert.ok(log.open);
  assert.equal(log.open.entryPrice, 100);
  assert.equal(log.closed.length, 0);
});

/* ---------- pruneShortWindow ---------- */
T("prune drops trades whose ENTRY is older than the window, keeps recent", () => {
  const recent = new Date(Date.now() - 5 * 86400000).toISOString();
  const log = { open: null, closed: [
    { sym: "X", entryScoredAt: recent, pnlPct: 1 },
    { sym: "X", entryScoredAt: "2020-01-01T21:00:00.000Z", pnlPct: 2 },
  ] };
  const out = pruneShortWindow(log);
  assert.equal(out.closed.length, 1);
  assert.equal(out.closed[0].entryScoredAt, recent);
});
T("prune preserves seeded/seedVersion metadata", () => {
  const out = pruneShortWindow({ open: null, closed: [], seeded: true, seedVersion: SBT_SEED_VERSION });
  assert.equal(out.seeded, true);
  assert.equal(out.seedVersion, SBT_SEED_VERSION);
});
T("prune caps closed at 200", () => {
  const now = new Date().toISOString();
  const closed = Array.from({ length: 250 }, (_, i) => ({ sym: "X", entryScoredAt: now, pnlPct: i }));
  assert.equal(pruneShortWindow({ open: null, closed }).closed.length, 200);
});

/* ---------- mergeShortSeed (forward trades win) ---------- */
T("merge: a forward trade wins over a seed trade with the same key", () => {
  const existing = { closed: [{ sym: "X", entryScoredAt: "2026-01-05T21:00:00.000Z", pnlPct: 5 }] };
  const seed = { closed: [
    { sym: "X", entryScoredAt: "2026-01-05T21:00:00.000Z", pnlPct: 99 }, // dup key ⇒ dropped
    { sym: "X", entryScoredAt: "2025-12-01T21:00:00.000Z", pnlPct: 7 },  // unique ⇒ kept
  ] };
  const out = mergeShortSeed(existing, seed);
  assert.equal(out.closed.length, 2);
  assert.equal(out.closed.find(t => t.entryScoredAt.startsWith("2026-01-05")).pnlPct, 5); // forward wins
  assert.equal(out.seeded, true);
  assert.equal(out.seedVersion, SBT_SEED_VERSION);
});
PROOF("merge proof: the seed must not overwrite a real forward trade's P&L", () => {
  const existing = { closed: [{ sym: "X", entryScoredAt: "2026-01-05T21:00:00.000Z", pnlPct: 5 }] };
  const seed = { closed: [{ sym: "X", entryScoredAt: "2026-01-05T21:00:00.000Z", pnlPct: 99 }] };
  assert.notEqual(mergeShortSeed(existing, seed).closed[0].pnlPct, 99);
});
T("merge: an entry OPEN in the forward log is not also booked as a seed CLOSED trade", () => {
  // The forward log holds sym X open at D; the seed replay (more history) already
  // folded X's exit at D as a closed trade. The merge must keep X open and DROP the
  // seed's closed copy — never show it as both open and realized (double-count bug).
  const existing = { open: { sym: "X", entryScoredAt: "2026-06-01T21:00:00.000Z", entryPrice: 100 }, closed: [] };
  const seed = { closed: [{ sym: "X", entryScoredAt: "2026-06-01T21:00:00.000Z", pnlPct: -20, exitReason: "STOP" }] };
  const out = mergeShortSeed(existing, seed);
  assert.equal(out.open.sym, "X");
  assert.equal(out.closed.filter(t => t.entryScoredAt === "2026-06-01T21:00:00.000Z").length, 0);
});
PROOF("merge proof: same entry must NOT appear as both open and closed", () => {
  const existing = { open: { sym: "X", entryScoredAt: "2026-06-01T21:00:00.000Z" }, closed: [] };
  const seed = { closed: [{ sym: "X", entryScoredAt: "2026-06-01T21:00:00.000Z", pnlPct: -20 }] };
  const out = mergeShortSeed(existing, seed);
  const openKey = `${out.open.sym}|${out.open.entryScoredAt}`;
  assert.ok(!out.closed.some(t => `${t.sym}|${t.entryScoredAt}` === openKey)); // pre-fix this would be true
});

/* ---------- SPY benchmark math ---------- */
T("shortSpyReturnBetween: as-of close lookup, both ends", () => {
  const spy = [{ date: "2026-02-01", close: 110 }, { date: "2026-01-15", close: 105 }, { date: "2026-01-01", close: 100 }];
  assert.equal(shortSpyReturnBetween(spy, "2026-01-01", "2026-02-01"), 10);   // (110-100)/100
});
T("shortSpyReturnBetween: picks the most recent bar ≤ the date", () => {
  const spy = [{ date: "2026-02-01", close: 110 }, { date: "2026-01-15", close: 105 }, { date: "2026-01-01", close: 100 }];
  assert.equal(shortSpyReturnBetween(spy, "2026-01-20", "2026-02-05"), Math.round(((110 - 105) / 105) * 10000) / 100);
});
T("annotateShortBenchmarks fills spyPct only where missing", () => {
  const spy = [{ date: "2026-02-01", close: 110 }, { date: "2026-01-01", close: 100 }];
  const log = { closed: [
    { entryScoredAt: "2026-01-01", exitScoredAt: "2026-02-01" },        // gets 10
    { entryScoredAt: "2026-01-01", exitScoredAt: "2026-02-01", spyPct: 42 }, // preserved
  ] };
  annotateShortBenchmarks(log, spy);
  assert.equal(log.closed[0].spyPct, 10);
  assert.equal(log.closed[1].spyPct, 42);
});

/* ---------- completed-session guard (partial-today-bar look-ahead) ----------
   The fold must only book COMPLETED sessions; during market hours hist[0] is FMP's
   in-progress partial bar. 2026-07-08 is a normal weekday (close 16:00 = 960 min);
   2026-11-27 is a half-day (close 13:00 = 780 min). */
T("prior-day bar is a completed session", () => assert.equal(sessionComplete("2026-07-07", "2026-07-08", 600), true));
T("today's bar BEFORE the close is NOT complete (partial bar)", () => assert.equal(sessionComplete("2026-07-08", "2026-07-08", 600), false));
T("today's bar AT/AFTER the close IS complete", () => assert.equal(sessionComplete("2026-07-08", "2026-07-08", 960), true));
T("a future-dated bar is never trusted", () => assert.equal(sessionComplete("2026-07-09", "2026-07-08", 999), false));
T("half-day close (13:00) respected: 12:59 not complete, 13:00 complete", () => {
  assert.equal(sessionComplete("2026-11-27", "2026-11-27", 779), false);
  assert.equal(sessionComplete("2026-11-27", "2026-11-27", 780), true);
});
PROOF("partial-bar proof: an intraday tick on today's date must NOT count as a completed session", () => {
  // A mutant that ignored market hours (returned true for barDate===today) would
  // let the fold book on the in-progress partial bar — the look-ahead bug.
  assert.equal(sessionComplete("2026-07-08", "2026-07-08", 60 * 11), false); // 11:00 ET, mid-session
});

/* ---------- seed gating ---------- */
T("needsShortSeed: null/old version ⇒ true, current ⇒ false", () => {
  assert.equal(needsShortSeed(null), true);
  assert.equal(needsShortSeed({ seedVersion: SBT_SEED_VERSION }), false);
  assert.equal(needsShortSeed({ seedVersion: SBT_SEED_VERSION - 1 }), true);
});
T("emptyShortLog shape", () => {
  const e = emptyShortLog();
  assert.deepEqual(e, { open: null, closed: [] });
});

console.log(`\n${pass} engine tests passed · ${proofs} negative-control proofs passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
