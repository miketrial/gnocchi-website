/* Swing backtest engine — recordShortTransition (the LONG-ONLY as-if state
   machine), the rolling-window prune, the seed merge, and the SPY benchmark
   math (short-backtest.mjs). These are the functions the live rescan and the
   lazy seed fold every scored bar through, so a regression here silently
   corrupts every trade in the popover. Run: node tests/swing-engine.test.mjs */
import assert from "node:assert/strict";
import {
  recordShortTransition, pruneShortWindow, mergeShortSeed, emptyShortLog, needsShortSeed,
  shortSpyReturnBetween, annotateShortBenchmarks, sessionComplete, dailySignalLog,
  SBT_HARD_STOP_PCT, SBT_TIME_STOP_DAYS, SBT_SEED_VERSION, SBT_ENTRY_MIN,
} from "../netlify/lib/short-backtest.mjs";
import { simulateShortExit } from "../netlify/lib/short-study.mjs";
import { cleanHist, adjustSplits } from "../netlify/lib/quickswing-pipeline.mjs";
import { mkHist } from "./swing-helpers.mjs";

let pass = 0, proofs = 0, fail = 0;
const T = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.log("❌ FAIL:", name, "\n   ", e.message); } };
const PROOF = (name, fn) => { try { fn(); proofs++; } catch (e) { fail++; console.log("❌ PROOF BROKEN:", name, "\n   ", e.message); } };

// Minimal signal shape the state machine reads. (v6: deathCross is the PRIMARY
// exit again — re-added off the long-runway study; conviction is the $3B/day +
// 3mo-mom≥40% tier stamped on positions at entry.)
const sig = (o) => ({
  bar: { date: o.date, open: o.open ?? o.close, high: o.high ?? o.close, low: o.low ?? o.close, close: o.close },
  atr14: o.atr14 ?? 2,
  entryStrong: o.entryStrong ?? false,
  deathCross: o.deathCross ?? false,
  conviction: o.conviction ?? false,
});
const enter = (date = "2026-01-05", close = 100, atr14 = 2) =>
  recordShortTransition("X", sig({ date, close, atr14, entryStrong: true }), null);
const STOP_LINE = (entry) => Math.round(entry * (1 - SBT_HARD_STOP_PCT) * 100) / 100; // v4 40% hard cap

/* ---------- ENTRY ---------- */
T("entry opens a long at close with a 40% hard catastrophe stop", () => {
  const log = enter("2026-01-05", 100, 2);
  assert.equal(log.open.side, "long");
  assert.equal(log.open.entryPrice, 100);
  assert.equal(log.open.stopPrice, STOP_LINE(100)); // 60 = 100 × (1 − 0.40)
  assert.equal(log.open.barsHeld, 0);
  assert.equal(log.closed.length, 0);
});
T("no entry when the bar is not entryStrong", () => {
  const log = recordShortTransition("X", sig({ date: "2026-01-05", close: 100, entryStrong: false }), null);
  assert.equal(log.open, null);
});
T("stop is a fixed % of entry, independent of ATR (v4)", () => {
  const log = recordShortTransition("X", sig({ date: "2026-01-05", close: 100, atr14: 0, entryStrong: true }), null);
  assert.equal(log.open.stopPrice, STOP_LINE(100)); // ATR unavailable no longer nulls the stop
});

/* ---------- STOP fills (now the 40% catastrophe line at 60 for a 100 entry) ---------- */
T("STOP: intraday touch fills at the stop line", () => {
  const open = enter(); // entry 100, stop 60
  const log = recordShortTransition("X", sig({ date: "2026-01-06", close: 62, open: 63, high: 64, low: 58 }), open);
  assert.equal(log.open, null);
  assert.equal(log.closed[0].exitReason, "STOP");
  assert.equal(log.closed[0].exitPrice, 60);       // low 58 ≤ stop 60, open 63 > stop ⇒ fill at stop
  assert.equal(log.closed[0].pnlPct, -40);
});
T("STOP: gap-through-open fills at the (worse) open", () => {
  const open = enter();
  const log = recordShortTransition("X", sig({ date: "2026-01-06", close: 53, open: 55, high: 56, low: 52 }), open);
  assert.equal(log.closed[0].exitReason, "STOP");
  assert.equal(log.closed[0].exitPrice, 55);       // gap: open 55 ≤ stop 60 ⇒ fill at open
  assert.equal(log.closed[0].pnlPct, -45);
});
T("STOP: snapshot with no intraday low fills at min(close, stop)", () => {
  const open = enter();
  const log = recordShortTransition("X", sig({ date: "2026-01-06", close: 58, open: 0, high: 0, low: 0 }), open);
  assert.equal(log.closed[0].exitReason, "STOP");
  assert.equal(log.closed[0].exitPrice, 58);       // no low ⇒ min(close 58, stop 60)
});
PROOF("STOP proof: a gap-down open must NOT be flattered to the stop price", () => {
  const open = enter();
  const log = recordShortTransition("X", sig({ date: "2026-01-06", close: 53, open: 55, high: 56, low: 52 }), open);
  assert.notEqual(log.closed[0].exitPrice, 60);    // buggy "always fill at stop" would book −40% not −45%
});

/* ---------- v6 exit-rule change: death-cross is the PRIMARY exit (re-added) ---------- */
T("CROSS: a 50/200 death-cross exits at the close (v6 primary exit)", () => {
  const open = enter();
  const log = recordShortTransition("X", sig({ date: "2026-01-06", close: 105, low: 104, deathCross: true }), open);
  assert.equal(log.open, null);
  assert.equal(log.closed[0].exitReason, "CROSS");
  assert.equal(log.closed[0].exitPrice, 105);      // at the close, not intrabar
  assert.equal(log.closed[0].pnlPct, 5);
});
PROOF("CROSS proof: the 40% STOP fires FIRST when both trip on the same bar", () => {
  // Day's low pierces the catastrophe line AND the bar carries a death-cross:
  // the risk event must win (STOP fill at the line, not a CROSS fill at the close).
  const open = enter(); // entry 100, stop 60
  const log = recordShortTransition("X", sig({ date: "2026-01-06", close: 62, open: 63, high: 64, low: 58, deathCross: true }), open);
  assert.equal(log.closed[0].exitReason, "STOP");
  assert.equal(log.closed[0].exitPrice, 60);
});
T("conviction: stamped on the position at entry and carried to the closed trade", () => {
  let log = recordShortTransition("X", sig({ date: "2026-01-05", close: 100, entryStrong: true, conviction: true }), null);
  assert.equal(log.open.conviction, true);
  log = recordShortTransition("X", sig({ date: "2026-01-06", close: 105, low: 104, deathCross: true, conviction: false }), log);
  assert.equal(log.closed[0].conviction, true);    // ENTRY-time tier, sticky for the trade's life
});
PROOF("hard-cap PROOF: a −67% ride-down is impossible once the 40% cap is on", () => {
  // A hyper-volatile name bleeding down day after day. Under the OLD wide 4×ATR stop it
  // could ride to a −67% TIME exit; the 40% catastrophe line must cut it at −40% first.
  let log = enter("2026-01-05", 100, 20);          // atr14 huge — a 4×ATR stop would sit at 20
  const worst = () => Math.min(...log.closed.map(t => t.pnlPct), log.open ? 0 : 0);
  for (let d = 1; d <= 63 && log.open; d++) {
    const close = 100 - d;                          // 99, 98, … slow bleed
    log = recordShortTransition("X", sig({ date: `2026-03-${String(d).padStart(2, "0")}`, close, open: close + 0.5, high: close + 1, low: close - 1 }), log);
  }
  assert.equal(log.closed[0].exitReason, "STOP");   // the cap fired, not a −60% TIME ride
  assert.ok(log.closed[0].pnlPct >= -40.001);       // bounded at −40%, never −60/−67
});
PROOF("hard-cap PROOF: the ONLY way past −40% is a gap-through-open, never an intrabar bleed", () => {
  // Intrabar: low pierces the line but open is above it → fill AT the line (−40%), not worse.
  let log = enter();
  log = recordShortTransition("X", sig({ date: "2026-01-06", close: 61, open: 62, high: 63, low: 55 }), log);
  assert.equal(log.closed[0].pnlPct, -40);          // intrabar can't book worse than the cap
  // Gap: open below the line → the (worse) open fill is the ONLY sub-cap outcome (the exempt gap case).
  let log2 = enter();
  log2 = recordShortTransition("X", sig({ date: "2026-01-06", close: 50, open: 52, high: 53, low: 49 }), log2);
  assert.ok(log2.closed[0].pnlPct < -40);           // −48%: a genuine overnight gap, unstoppable
});

/* ---------- engine ↔ study PARITY (the deployed engine == the offline reconstruction) ----------
   The offline harness (short-study.mjs::simulateShortExit) is a hand-synced twin of the
   live engine. Drive identical forward bars through both for the SHIPPED rule and assert
   the same exit reason + price (±1¢, since the engine round2s and the study does not). */
{
  // v6 shipped rule in study terms: maCross target (the death-cross exit) + the
  // 189-session backstop + the 40% hard cap. The study reads the cross off the fwd
  // bars' sma50/sma200; the engine reads sig.deathCross — the parity cases drive
  // both from the same per-bar deathCross flag.
  const shipped = { target: "maCross", timeStop: SBT_TIME_STOP_DAYS, hardStopPct: SBT_HARD_STOP_PCT };
  const runEngine = (entry, bars) => {
    let log = recordShortTransition("X", sig({ date: "2026-01-01", close: entry, entryStrong: true }), null);
    for (const b of bars) { if (!log.open) break; log = recordShortTransition("X", sig(b), log); }
    if (log.open) return { reason: "OPEN", price: null };
    return { reason: log.closed[0].exitReason, price: log.closed[0].exitPrice };
  };
  const runStudy = (entry, bars) => {
    const rec = { side: "long", entryClose: entry, entryAtr14: 2, entryDate: "2026-01-01",
      fwd: bars.map(b => ({ date: b.date, open: b.open ?? b.close, high: b.high ?? b.close, low: b.low ?? b.close, close: b.close,
        sma50: b.deathCross ? 90 : 110, sma200: 100, atr14: 2 })) }; // sma50<sma200 exactly on deathCross bars
    const r = simulateShortExit(rec, shipped);
    // study reasons map onto engine reasons: EOD→TIME (bars ran out at the cap),
    // TARGET (the maCross target) → CROSS. TRAIL/FLIP are impossible for this rule.
    const map = { EOD: "TIME", TARGET: "CROSS" };
    return { reason: map[r.reason] || r.reason, price: rec.entryClose * (1 + r.pnl / 100) };
  };
  // Valid ascending ISO dates for long runs (a naive "2026-04-<n>" template breaks
  // lexicographic ordering past two digits, which would freeze barsHeld).
  const dateAt = (i) => new Date(Date.parse("2026-01-02T00:00:00Z") + i * 86400000).toISOString().slice(0, 10);
  const flatBars = (n) => Array.from({ length: n }, (_, i) => ({
    date: dateAt(i), close: 100 + i * 0.1, open: 100 + i * 0.1, high: 101 + i * 0.1, low: 99 + i * 0.1 }));
  const cases = [
    { name: "clean 40% intrabar cap", entry: 100, bars: [{ date: "2026-01-02", close: 62, open: 63, high: 64, low: 58 }] },
    { name: "gap-through-open", entry: 100, bars: [{ date: "2026-01-02", close: 50, open: 52, high: 53, low: 49 }] },
    { name: `TIME backstop at exactly ${SBT_TIME_STOP_DAYS}`, entry: 100, bars: flatBars(SBT_TIME_STOP_DAYS) },
    { name: "death-cross exits at the close", entry: 100,
      bars: [...flatBars(5), { date: dateAt(5), close: 104, open: 104, high: 105, low: 103, deathCross: true }] },
  ];
  for (const c of cases) {
    T(`parity: engine == study for "${c.name}"`, () => {
      const e = runEngine(c.entry, c.bars), s = runStudy(c.entry, c.bars);
      assert.equal(e.reason, s.reason, `reason ${e.reason} vs ${s.reason}`);
      assert.ok(Math.abs(e.price - s.price) <= 0.01, `price ${e.price} vs ${s.price}`);
    });
  }
  PROOF("parity PROOF: a study twin WITHOUT the hard cap diverges from the engine", () => {
    // Mutant study rule (no hardStopPct) rides the 40% intrabar case to EOD instead of STOP —
    // proving the parity test actually binds the cap in both implementations.
    const entry = 100, bars = [{ date: "2026-01-02", close: 62, open: 63, high: 64, low: 58 }];
    const rec = { side: "long", entryClose: entry, entryAtr14: 2, entryDate: "2026-01-01",
      fwd: bars.map(b => ({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, sma50: null, sma200: null, atr14: 2 })) };
    const mutant = simulateShortExit(rec, { target: "none", timeStop: 63 }); // no cap
    const engine = runEngine(entry, bars);
    assert.notEqual(mutant.reason === "EOD" ? "TIME" : mutant.reason, engine.reason); // study EOD vs engine STOP
  });
}

/* ---------- split back-adjustment (the phantom −47% HON root-cause fix) ---------- */
{
  const HON_SPLIT = [{ date: "2026-06-29", numerator: 1, denominator: 2, splitType: "stock-split" }];
  const raw = cleanHist([
    { date: "2026-06-29", open: 241, close: 227.8, high: 252, low: 227, volume: 7_700_000 },
    { date: "2026-06-26", open: 459, close: 464.42, high: 467, low: 452, volume: 8_900_000 },
    { date: "2026-06-25", open: 455, close: 462.48, high: 474, low: 455, volume: 2_900_000 },
  ]);
  const adj = adjustSplits(raw, HON_SPLIT);
  const at = (arr, d) => arr.find(b => b.date === d);
  T("split: pre-split bars are back-adjusted by the ratio (464.42 → 232.21)", () => {
    assert.ok(Math.abs(at(adj, "2026-06-26").close - 232.21) < 0.01); // × (1/2)
    assert.ok(Math.abs(at(adj, "2026-06-25").close - 231.24) < 0.01);
  });
  T("split: the post-split bar (on/after the ex-date) is untouched", () => {
    assert.equal(at(adj, "2026-06-29").close, 227.8);
  });
  T("split: volume moves inversely (pre-split volume doubled)", () => {
    assert.equal(at(adj, "2026-06-26").volume, Math.round(8_900_000 / 0.5));
  });
  PROOF("split PROOF: back-adjustment ELIMINATES the phantom overnight gap", () => {
    const gap = (at(adj, "2026-06-29").open - at(adj, "2026-06-26").close) / at(adj, "2026-06-26").close * 100;
    assert.ok(gap > -10); // raw −48% phantom gap → a real, small move once adjusted
  });
  T("split: no-op when there are no splits, and for real (non-split) gaps", () => {
    assert.deepEqual(adjustSplits(raw, []), raw);
    assert.deepEqual(adjustSplits(raw, [{ date: "2020-01-01", numerator: 1, denominator: 1 }]), raw); // ratio 1 = no-op
  });
}

/* ---------- TIME backstop ---------- */
T("TIME: exits after the 189-session backstop", () => {
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
T("prune + fold preserve the notifier dailyLog + sym (a rescan must not strip them)", () => {
  const seeded = { sym: "X", open: null, closed: [], seeded: true, seedVersion: SBT_SEED_VERSION,
    dailyLog: [{ date: "2026-07-09", action: "BUY", price: 100 }] };
  const pruned = pruneShortWindow(seeded);
  assert.deepEqual(pruned.dailyLog, seeded.dailyLog);
  assert.equal(pruned.sym, "X");
  // and through a live fold (recordShortTransition on the seeded log)
  const folded = recordShortTransition("X", sig({ date: "2026-07-10", close: 100, entryStrong: false }), seeded);
  assert.deepEqual(folded.dailyLog, seeded.dailyLog);
  assert.equal(folded.sym, "X");
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

/* ---------- dailySignalLog (the 15-day BUY/SELL/HOLD notifier) ---------- */
{
  // clean, liquid, monotonic uptrend → a fresh BUY on the first replayed session, then HOLDs.
  const rise = Array.from({ length: 260 }, (_, i) => Math.round((70 + 50 * ((259 - i) / 259)) * 100) / 100);
  const hist = mkHist(rise, { vol: 10_000_000 }); // ~$1.2B/day — clears the v5 $1B floor
  const spyStr = hist.map(b => ({ date: b.date, strength: 0 }));
  const secStr = hist.map(b => ({ date: b.date, strength: 0.3 })); // sector leads SPY → SECRS≥2
  const dl = dailySignalLog("X", hist, spyStr, secStr, { sessions: 6, replaySessions: 6 });
  T("dailySignalLog: fresh BUY on entry then HOLD in a sustained uptrend", () => {
    assert.equal(dl.days.length, 6);
    assert.equal(dl.days[0].action, "BUY");
    assert.ok(dl.days.slice(1).every(d => d.action === "HOLD"));
    assert.ok(dl.open); // still in the position at window end
  });
  T("dailySignalLog: every fired day carries the guardrail-pass + score", () => {
    assert.ok(dl.days.every(d => d.guardrailPass === true && d.techScore >= SBT_ENTRY_MIN));
  });
  PROOF("dailySignalLog proof: a sub-guardrail name must NOT emit a BUY", () => {
    const thin = mkHist(rise, { vol: 5_000_000 }); // ~$0.6B/day < $1B floor
    const dlThin = dailySignalLog("X", thin, spyStr, secStr, { sessions: 6, replaySessions: 6 });
    assert.ok(!dlThin.days.some(d => d.action === "BUY")); // guardrail blocks the entry
    assert.ok(dlThin.days.some(d => d.action === "WATCH")); // shown as strong-but-blocked
  });
}

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
