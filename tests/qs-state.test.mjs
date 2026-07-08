/* Table tests for the REAL position state-machine brains — positionExitDecision
   and alertTransition (the exported functions the alert worker drives). Covers
   the STOP>TARGET>FLIP>TIME priority, the strict/inclusive price boundaries, the
   short mirror, and every entry/exit transition.
   Run: node tests/qs-state.test.mjs */
import assert from "node:assert/strict";
import { positionExitDecision, alertTransition } from "../netlify/lib/quickswing-alert.mjs";

let ok = 0, fail = 0;
const T = (name, fn) => { try { fn(); ok++; } catch (e) { fail++; console.log("❌", name, "\n   ", e.message); } };

const L = { side: "long", entryPrice: 100, stopPrice: 96, barsHeld: 1 };
const S = { side: "short", entryPrice: 100, stopPrice: 104, barsHeld: 1 };
const dec = (pos, price, verdict, bars = 1, tsd = 3) =>
  positionExitDecision({ ...pos, barsHeld: bars }, { price, verdict }, tsd).reason;

/* ---- positionExitDecision: long ---- */
T("long STOP at the stop (inclusive)", () => assert.equal(dec(L, 96, "BUY"), "STOP"));
T("long STOP below the stop", () => assert.equal(dec(L, 95, "BUY"), "STOP"));
T("long TARGET above entry", () => assert.equal(dec(L, 101, "BUY"), "TARGET"));
T("long entry exactly = no TARGET (strict >), holds", () => assert.equal(dec(L, 100, "NEUTRAL", 1), null));
T("long FLIP when verdict SELL between stop and entry", () => assert.equal(dec(L, 98, "SELL"), "FLIP"));
T("long TIME when held >= time-stop", () => assert.equal(dec(L, 98, "NEUTRAL", 3), "TIME"));
T("long HOLD when held < time-stop, no other trigger", () => assert.equal(dec(L, 98, "NEUTRAL", 2), null));
T("STOP outranks FLIP (price at stop AND verdict SELL)", () => assert.equal(dec(L, 96, "SELL"), "STOP"));
T("TARGET outranks FLIP", () => assert.equal(dec(L, 101, "SELL"), "TARGET"));
T("FLIP outranks TIME", () => assert.equal(dec(L, 98, "SELL", 3), "FLIP"));

/* ---- positionExitDecision: short mirror ---- */
T("short STOP at the stop (inclusive)", () => assert.equal(dec(S, 104, "SELL"), "STOP"));
T("short TARGET below entry", () => assert.equal(dec(S, 99, "SELL"), "TARGET"));
T("short entry exactly = no TARGET, holds", () => assert.equal(dec(S, 100, "NEUTRAL", 1), null));
T("short FLIP when verdict BUY between entry and stop", () => assert.equal(dec(S, 102, "BUY"), "FLIP"));

/* ---- guards ---- */
T("no position → no exit", () => assert.equal(positionExitDecision(null, { price: 50 }).reason, null));
T("non-positive price → no exit (stale/missing quote)", () => assert.equal(dec(L, 0, "BUY"), null));
T("undefined price → no exit", () => assert.equal(positionExitDecision(L, {}).reason, null));

/* ---- alertTransition: entries + exits ---- */
const fires = (prev, now) => alertTransition(prev, now);
T("NEUTRAL→BUY fires BUY", () => assert.deepEqual(fires("NEUTRAL", "BUY"), { fire: true, kind: "BUY", changed: true }));
T("null→BUY fires BUY (first sight)", () => assert.equal(fires(null, "BUY").kind, "BUY"));
T("BUY→BUY does NOT re-fire (dedup)", () => assert.equal(fires("BUY", "BUY").fire, false));
T("NEUTRAL→SELL fires SELL", () => assert.equal(fires("NEUTRAL", "SELL").kind, "SELL"));
T("BUY→NEUTRAL fires EXIT", () => assert.equal(fires("BUY", "NEUTRAL").kind, "EXIT"));
T("SELL→BLOCKED fires EXIT", () => assert.equal(fires("SELL", "BLOCKED").kind, "EXIT"));
T("NEUTRAL→NEUTRAL no fire", () => assert.equal(fires("NEUTRAL", "NEUTRAL").fire, false));
T("NEUTRAL→BLOCKED no fire (both flat)", () => assert.equal(fires("NEUTRAL", "BLOCKED").fire, false));
T("BUY→SELL fires SELL (opposite entry)", () => assert.equal(fires("BUY", "SELL").kind, "SELL"));

console.log(`\n${ok} state-machine real-code tests passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
