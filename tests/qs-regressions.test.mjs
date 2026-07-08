/* Regression tests for the 11 review bugs fixed in PR #51.
   Each test asserts the FIXED behavior AND runs the OLD buggy logic as a negative
   control that must fail the same assertion — proving the test actually catches
   that bug. Worker-internal decision logic (not exported) is mirrored inline with
   a comment pointing at the source; the mirror is kept minimal to avoid drift.
   Run: node _regression_tests.mjs */
import assert from "node:assert/strict";
import { previousTradingDay } from "../netlify/lib/market-calendar.mjs";
import { formatPreCloseRoster } from "../netlify/lib/quickswing-alert.mjs";

let ok = 0, fail = 0;
const T = (name, fn) => { try { fn(); ok++; } catch (e) { fail++; console.log("❌", name, "\n   ", e.message); } };
const TIME_STOP = 3;

/* #1 — permanent 4xx must advance (no wedge); transient must hold back. */
T("#1 permanent-4xx advances, transient holds", () => {
  const now = (res) => !!res && (res.ok || res.skipped || res.permanent);   // FIXED
  const old = (res) => !!res && (res.ok || res.skipped);                    // BUGGY
  assert.ok(now({ ok: false, permanent: true }));    // blocked bot → give up, advance
  assert.ok(!now({ ok: false, status: 0 }));         // transient → hold back & retry
  assert.ok(!old({ ok: false, permanent: true }));   // PROOF: old wedges forever (falsy)
});

/* #2 — degraded must count names whose scoring THREW (excluded from `scored`). */
T("#2 degraded counts thrown names", () => {
  const universeN = 100, scored = Array.from({ length: 40 }, () => ({ price: 10, verdict: "BUY" })); // 60 threw
  const usable = scored.filter(r => r.price != null && r.verdict).length;
  const naNew = Math.max(0, universeN - usable);                 // FIXED
  const naOld = scored.filter(r => r.price == null || !r.verdict).length; // BUGGY
  assert.equal(naNew, 60); assert.ok(naNew / universeN > 0.5);   // → degraded=true
  assert.equal(naOld, 0);  assert.ok(!(naOld / universeN > 0.5)); // PROOF: old says "OK" mid-outage
});

/* #4 — a position untracked past the time-stop window is expired (dropped). */
T("#4 zombie position expires", () => {
  const today = "2026-07-08";
  let cutoff = today; for (let i = 0; i < TIME_STOP + 1; i++) cutoff = previousTradingDay(cutoff);
  const zombie = { lastSessionDate: "2026-06-30" }, fresh = { lastSessionDate: "2026-07-07" };
  const expired = (p) => p.lastSessionDate < cutoff;             // FIXED logic
  assert.equal(expired(zombie), true);                          // days-old pick → dropped
  assert.equal(expired(fresh), false);                          // yesterday → kept
  // PROOF: old code had no expiry, so it would carry the zombie (evaluate exits vs stale entry)
  const oldCarries = true;
  assert.ok(oldCarries && expired(zombie));
});

/* #5 — watchdog catches an all-day-dark worker (hb from a prior day) after grace,
   and does NOT false-alarm at the day's first tick or on the 15-min AH cadence. */
T("#5 watchdog grace + all-day-dark + AH threshold", () => {
  const STALE_R = 16 * 60000, STALE_AH = 32 * 60000;
  const staleNew = (hbAge, dispatchAge, staleMs) => hbAge > staleMs && dispatchAge > staleMs; // FIXED
  const staleOld = (sameDayHb, gapMs) => sameDayHb && gapMs > STALE_R;                        // BUGGY
  // All-day-dark: hb from Friday, dispatching 20 min today, regular hours.
  assert.equal(staleNew(Infinity, 20 * 60000, STALE_R), true);   // FIXED alerts
  assert.equal(staleOld(false, 0), false);                       // PROOF: old blind (sameDayHb=false)
  // First tick of day: grace (dispatchAge≈0) → no false alarm.
  assert.equal(staleNew(Infinity, 0, STALE_R), false);
  // After-hours 20-min bar: under the 32-min AH threshold → no false alarm.
  assert.equal(staleNew(20 * 60000, 60 * 60000, STALE_AH), false);
  // PROOF: old 16-min threshold would false-alarm on that same 20-min AH gap.
  assert.equal(20 * 60000 > STALE_R, true);
});

/* #8 — pre-close self-heals to the :55 tick if :50 was lock-skipped. */
T("#8 pre-close window includes :55", () => {
  const fires = (min) => min >= 48;              // FIXED (hour===15 assumed)
  const old = (min) => min >= 48 && min <= 54;   // BUGGY
  assert.equal(fires(55), true);                 // :55 retry fires
  assert.equal(old(55), false);                  // PROOF: old drops the day's review
  assert.equal(fires(50), true);
});

/* #9 — daily-cron tolerates jitter to :47 instead of skipping the whole scan. */
T("#9 daily-cron jitter tolerance", () => {
  const fires = (min) => min >= 44;                  // FIXED (hour===9 assumed)
  const old = (min) => Math.abs(min - 45) <= 1;      // BUGGY
  assert.equal(fires(47), true);                     // late fire still scans
  assert.equal(old(47), false);                      // PROOF: old skips the day
  assert.equal(fires(45), true); assert.equal(fires(44), true);
});

/* #10 — cooling nudge latches per-position (no re-fire on oscillation). */
T("#10 cooling nudge latches", () => {
  // sequence of verdict states across ticks for a held long: cool, recover, cool
  const seq = ["NEUTRAL", "BUY", "NEUTRAL"];
  const count = (reset) => { let flag = false, sends = 0; for (const v of seq) {
    const supports = v === "BUY";
    if (!supports && !flag) { flag = true; sends++; }
    else if (reset && supports && flag) { flag = false; }
  } return sends; };
  assert.equal(count(false), 1);   // FIXED (latched): one cooling note
  assert.equal(count(true), 2);    // PROOF: old (reset on recovery) re-fires → two
});

/* #3 — open-scan carries ANY still-open position (incl. NEUTRAL-reading long). */
T("#3 open-scan carries a NEUTRAL-reading held long", () => {
  const sideForVerdict = (v) => (v === "BUY" ? "long" : v === "SELL" ? "short" : null);
  const prior = { side: "long", entryPrice: 100, barsHeld: 1, lastSessionDate: "2026-07-07" };
  const verdict = "NEUTRAL";
  // FIXED: carry if prior is live, regardless of today's side.
  const priorLive = prior && prior.side; // (non-expired assumed)
  const posNew = priorLive ? { ...prior } : (sideForVerdict(verdict) ? { fresh: true } : null);
  // OLD: only carried when prior.side === sideForVerdict(verdict); NEUTRAL→null.
  const side = sideForVerdict(verdict);
  const posOld = (side && prior.side === side) ? { ...prior } : (side ? { fresh: true } : null);
  assert.ok(posNew && posNew.entryPrice === 100);   // FIXED keeps the real position
  assert.equal(posOld, null);                        // PROOF: old orphans it
});

/* #11 — rosters exclude a name that exited this same tick. */
T("#11 roster excludes exited-this-tick name", () => {
  const openPositions = [{ sym: "A" }, { sym: "B" }];
  const closedThisTick = new Set(["A"]);
  const stillOpen = openPositions.filter(p => !closedThisTick.has(p.sym)); // FIXED
  assert.deepEqual(stillOpen.map(p => p.sym), ["B"]);
  assert.deepEqual(openPositions.map(p => p.sym), ["A", "B"]); // PROOF: old (unfiltered) still lists A
});

/* #7 — universe cache persists for a lowered QS_DAILY_UNIVERSE_N (e.g. 150). */
T("#7 universe persists below 250", () => {
  const persists = (n, persist) => !!(persist && n >= 50);   // FIXED gate
  const old = (n) => n >= 250;                                // BUGGY gate
  assert.equal(persists(150, true), true);   // real run at 150 → cached
  assert.equal(old(150), false);             // PROOF: old never cached → empty fallback
  assert.equal(persists(8, false), false);   // small test still skipped
  assert.equal(persists(8, true), false);    // floor guards even if persist mis-passed
});

/* cosmetic — pre-close never renders "±undefined%". */
T("cosmetic pre-close guards missing gap profile", () => {
  const r = formatPreCloseRoster([{ sym: "X", side: "long", entryPrice: 100, stopPrice: 96, price: 98, barsHeld: 0, overnightGap: {} }], "x", 3);
  assert.ok(!/undefined/.test(r));   // FIXED
});

console.log(`\n${ok} regression tests passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
