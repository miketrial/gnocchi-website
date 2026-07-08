/* Table-driven test for the REAL silent-loop watchdog decision (bugs #4/#5 +
   deep-#1), exercising the exported evaluateWatchdog the cron actually calls.
   Run: node tests/qs-watchdog.test.mjs */
import assert from "node:assert/strict";
import { evaluateWatchdog } from "../netlify/lib/quickswing-alert.mjs";

const MIN = 60000;
const R = 16 * MIN, AH = 32 * MIN;
const NOW = 1_800_000_000_000; // fixed clock
const TODAY = "2026-07-08";
const ev = (o) => evaluateWatchdog({ nowMs: NOW, session: "regular", today: TODAY, staleRegularMs: R, staleAhMs: AH, ...o });

let ok = 0, fail = 0;
const T = (name, fn) => { try { fn(); ok++; } catch (e) { fail++; console.log("❌", name, "\n   ", e.message); } };

T("healthy: fresh heartbeat → no alert", () => {
  const r = ev({ hbTs: NOW - 5 * MIN, wd: { day: TODAY, firstTickTs: NOW - 60 * MIN } });
  assert.equal(r.stale, false); assert.equal(r.shouldAlert, false);
});

T("first tick of day: grace period suppresses false alarm on a prior-day heartbeat", () => {
  // wd has no firstTickTs → grace anchor = now → dispatchAge 0.
  const r = ev({ hbTs: NOW - 3 * 24 * 60 * MIN, wd: {} });
  assert.equal(r.shouldAlert, false);   // no false alarm at day start
});

T("all-day-dark: worker dead since before today IS caught after grace (deep-#1)", () => {
  // Been dispatching 20 min today, heartbeat is 3 days old → must alert.
  const r = ev({ hbTs: NOW - 3 * 24 * 60 * MIN, wd: { day: TODAY, firstTickTs: NOW - 20 * MIN } });
  assert.equal(r.stale, true); assert.equal(r.shouldAlert, true);
});

T("regular-hours 17-min gap → stale (>16)", () => {
  const r = ev({ hbTs: NOW - 17 * MIN, wd: { day: TODAY, firstTickTs: NOW - 60 * MIN } });
  assert.equal(r.shouldAlert, true);
});

T("after-hours 20-min gap → NOT stale (under 32-min AH threshold) (bug #4)", () => {
  const r = ev({ session: "afterhours", hbTs: NOW - 20 * MIN, wd: { day: TODAY, firstTickTs: NOW - 90 * MIN } });
  assert.equal(r.stale, false); assert.equal(r.shouldAlert, false);
  // control: the SAME 20-min gap would have alarmed under the old fixed 16-min bar
  assert.equal(20 * MIN > R, true);
});

T("after-hours 35-min gap → stale", () => {
  const r = ev({ session: "afterhours", hbTs: NOW - 35 * MIN, wd: { day: TODAY, firstTickTs: NOW - 90 * MIN } });
  assert.equal(r.shouldAlert, true);
});

T("dedup: only one alert per stuck heartbeat", () => {
  const hbTs = NOW - 40 * MIN;
  const wd0 = { day: TODAY, firstTickTs: NOW - 40 * MIN };
  const r1 = ev({ hbTs, wd: wd0 });
  assert.equal(r1.shouldAlert, true);                 // first: alert
  const r2 = ev({ hbTs, wd: r1.nextState });          // feed forward state, same stuck hb
  assert.equal(r2.stale, true);
  assert.equal(r2.shouldAlert, false);                // second: suppressed
});

T("recovery: a fresh heartbeat clears the alerted flag", () => {
  const wdAlerted = { day: TODAY, firstTickTs: NOW - 60 * MIN, staleAlertedForTs: NOW - 40 * MIN, worstGapMs: 40 * MIN };
  const r = ev({ hbTs: NOW - 2 * MIN, wd: wdAlerted });  // worker recovered
  assert.equal(r.stale, false);
  assert.equal(r.nextState.staleAlertedForTs, null);    // re-armed for a future outage
});

T("never-stamped heartbeat (hbTs undefined) alarms once after grace", () => {
  const r1 = ev({ hbTs: undefined, wd: { day: TODAY, firstTickTs: NOW - 30 * MIN } });
  assert.equal(r1.shouldAlert, true);
  const r2 = ev({ hbTs: undefined, wd: r1.nextState });
  assert.equal(r2.shouldAlert, false);   // dedup on hbKey=0
});

console.log(`\n${ok} watchdog real-code tests passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
