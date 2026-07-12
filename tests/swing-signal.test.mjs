/* Swing backtest signal — computeShortSignal (short-backtest.mjs): the 6 EOD-
   computable factors (0–18), the entry gate, and — critically — PARITY with the
   live scorer's technical core, proving the seed replay and the forward fold key
   off the same numbers the site shows (the "byte-identical" claim in the code).
   Run: node tests/swing-signal.test.mjs */
import assert from "node:assert/strict";
import { computeShortSignal, SBT_ENTRY_MIN, SBT_HARD_STOP_PCT, SBT_LIQ_FLOOR, SBT_SECRS_MIN, SBT_RS_MIN } from "../netlify/lib/short-backtest.mjs";

// v6.2 relative-strength gate needs SPY's 126d return. The synthetic uptrends below run
// name-126d ≈ +25%, so SPY_DOWN (−10%) makes rs ≈ +35pp (clears the +30pp floor) and
// SPY_UP (+10%) makes rs ≈ +15pp (fails it) — letting each test isolate one gate.
const SPY_DOWN = -0.10, SPY_UP = 0.10;
import {
  checkTrend, check3MMomentum, checkNearHigh, checkLiquidity, checkVolumeSurge, checkSectorStrength,
} from "../netlify/lib/short-pipeline.mjs";
import { strengthFactor, cleanHist } from "../netlify/lib/quickswing-pipeline.mjs";
import { mkHist, seg, trendHist } from "./swing-helpers.mjs";

let pass = 0, proofs = 0, fail = 0;
const T = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.log("❌ FAIL:", name, "\n   ", e.message); } };
const PROOF = (name, fn) => { try { fn(); proofs++; } catch (e) { fail++; console.log("❌ PROOF BROKEN:", name, "\n   ", e.message); } };

/* ---------- guards ---------- */
T("null below 200 bars", () => assert.equal(computeShortSignal(mkHist(seg([[150, 100]]))), null));
T("techScore in 0..18 range", () => {
  const s = computeShortSignal(trendHist(120, 110, 90), { spyStrength: 0, sectorStrength: 0.2 });
  assert.ok(s.techScore >= 0 && s.techScore <= 18);
});

/* ---------- trend/deathCross/atr context ---------- */
T("uptrend true & deathCross false in a clean uptrend", () => {
  const s = computeShortSignal(trendHist(120, 110, 90));
  assert.equal(s.uptrend, true);
  assert.equal(s.deathCross, false);
});
T("deathCross true when 50DMA<200DMA", () => {
  const s = computeShortSignal(trendHist(90, 95, 120)); // sma50≈94.9 < sma200≈113.7
  assert.equal(s.deathCross, true);
  assert.equal(s.uptrend, false);
});
T("atr14 is positive & finite", () => {
  const s = computeShortSignal(trendHist(120, 110, 90));
  assert.ok(s.atr14 > 0 && isFinite(s.atr14));
});

/* ---------- v5 entry gate: techScore≥14 AND uptrend AND $-vol≥$1B AND Sector-RS≥2 ---------- */
T("entryStrong FALSE in a downtrend (uptrend gate)", () => {
  const s = computeShortSignal(trendHist(90, 95, 120), { spyStrength: 0, sectorStrength: 0.3 });
  assert.equal(s.entryStrong, false);
});
// A clean, liquid, monotonic uptrend (newest-first 120→70, close ~$120) that clears
// the v5 gate — techScore≥14, uptrend, ≥$1B/day at vol 10M (~$1.2B), sector leads SPY.
const riseCloses = Array.from({ length: 260 }, (_, i) => Math.round((70 + 50 * ((259 - i) / 259)) * 100) / 100);
T("entryStrong implies all five gate conditions (score, uptrend, $1B floor, sector-RS, rel-strength)", () => {
  const s = computeShortSignal(mkHist(riseCloses, { vol: 10_000_000 }), { spyStrength: 0, sectorStrength: 0.3, spyRet126: SPY_DOWN });
  assert.equal(s.entryStrong, true);
  assert.ok(s.techScore >= SBT_ENTRY_MIN);
  assert.equal(s.uptrend, true);
  assert.ok(s.avgDollarVol >= SBT_LIQ_FLOOR);
  assert.ok(s.secPts >= SBT_SECRS_MIN);
  assert.ok(s.rs126 >= SBT_RS_MIN);
});
PROOF("entry gate proof: a downtrend can never be entryStrong even with max sector RS", () =>
  assert.equal(computeShortSignal(trendHist(90, 95, 120), { spyStrength: -1, sectorStrength: 1 }).entryStrong, false));

/* ---------- liquidity guardrail (v5: ≥$1B/day) — the deep-study defensive filter ---------- */
T("guardrail: entryStrong FALSE below $1B/day even when strong + uptrend + sector-leading", () => {
  const opts = { spyStrength: 0, sectorStrength: 0.3, spyRet126: SPY_DOWN };
  const hi = computeShortSignal(mkHist(riseCloses, { vol: 10_000_000 }), opts); // ~$1.2B/day
  const lo = computeShortSignal(mkHist(riseCloses, { vol: 5_000_000 }), opts);  // ~$0.6B/day
  assert.ok(hi.avgDollarVol >= SBT_LIQ_FLOOR && lo.avgDollarVol < SBT_LIQ_FLOOR);
  assert.equal(hi.techScore, lo.techScore);   // the guardrail must NOT change the score
  assert.equal(hi.entryStrong, true);
  assert.equal(lo.entryStrong, false);         // only the liquidity floor flipped it
});
PROOF("guardrail proof: it is the $-volume floor (not the score) that blocks the sub-tier name", () => {
  const lo = computeShortSignal(mkHist(riseCloses, { vol: 5_000_000 }), { spyStrength: 0, sectorStrength: 0.3, spyRet126: SPY_DOWN });
  assert.ok(lo.techScore >= SBT_ENTRY_MIN && lo.uptrend && lo.secPts >= SBT_SECRS_MIN && lo.rs126 >= SBT_RS_MIN); // strong + uptrend + sector-leading + rel-strong...
  assert.equal(lo.entryStrong, false);                    // ...yet blocked, purely by the guardrail
});

/* ---------- v5 sector-leadership gate (Sector-RS ≥ 2) ---------- */
T("v5 gate: a lagging sector (SECRS<2) blocks entryStrong even when liquid + uptrend", () => {
  const lead = computeShortSignal(mkHist(riseCloses, { vol: 10_000_000 }), { spyStrength: 0, sectorStrength: 0.3, spyRet126: SPY_DOWN });   // sector leads SPY
  const lag = computeShortSignal(mkHist(riseCloses, { vol: 10_000_000 }), { spyStrength: 0.3, sectorStrength: -0.2, spyRet126: SPY_DOWN }); // sector lags SPY
  assert.ok(lead.secPts >= SBT_SECRS_MIN && lead.entryStrong === true);   // sector leads → can fire
  assert.ok(lag.secPts < SBT_SECRS_MIN && lag.entryStrong === false);     // sector lags → blocked
});

/* ---------- v6.2 name relative-strength gate: (name 126d return − SPY 126d return) ≥ +30pp ---------- */
// riseCloses runs name-126d ≈ +25%. So vs a SPY that FELL 10% (SPY_DOWN) rs ≈ +35pp
// (clears +30) and vs a SPY that ROSE 10% (SPY_UP) rs ≈ +15pp (fails), isolating the RS leg.
T("rs126 gate FIRES when the name beats SPY by ≥30pp (all other conditions met)", () => {
  const s = computeShortSignal(mkHist(riseCloses, { vol: 10_000_000 }), { spyStrength: 0, sectorStrength: 0.3, spyRet126: SPY_DOWN });
  assert.ok(s.rs126 >= SBT_RS_MIN);          // name +25% − SPY −10% ≈ +35pp
  assert.equal(s.entryStrong, true);
});
T("rs126 gate BLOCKS entryStrong when the name doesn't beat SPY by 30pp (everything else passes)", () => {
  const s = computeShortSignal(mkHist(riseCloses, { vol: 10_000_000 }), { spyStrength: 0, sectorStrength: 0.3, spyRet126: SPY_UP });
  assert.ok(s.techScore >= SBT_ENTRY_MIN && s.uptrend && s.avgDollarVol >= SBT_LIQ_FLOOR && s.secPts >= SBT_SECRS_MIN); // v5 core all passes…
  assert.ok(s.rs126 < SBT_RS_MIN);           // name +25% − SPY +10% ≈ +15pp < +30pp
  assert.equal(s.entryStrong, false);        // …blocked purely by the relative-strength floor
});
PROOF("rs126 proof: it is the RS floor (not the v5 core) that flips this name off", () => {
  const opts = { spyStrength: 0, sectorStrength: 0.3 };
  const on = computeShortSignal(mkHist(riseCloses, { vol: 10_000_000 }), { ...opts, spyRet126: SPY_DOWN });
  const off = computeShortSignal(mkHist(riseCloses, { vol: 10_000_000 }), { ...opts, spyRet126: SPY_UP });
  assert.equal(on.techScore, off.techScore); // identical v5 core — only the SPY-126d input differs
  assert.equal(on.entryStrong, true);
  assert.equal(off.entryStrong, false);
});
T("rs126 gate BLOCKS when SPY-126d is unavailable (can't measure relative strength)", () => {
  const s = computeShortSignal(mkHist(riseCloses, { vol: 10_000_000 }), { spyStrength: 0, sectorStrength: 0.3 }); // no spyRet126
  assert.equal(s.rs126, null);
  assert.equal(s.entryStrong, false);        // a name we can't rank vs SPY is not "best of the best"
});

/* ---------- PARITY: techScore == sum of the live scorer's 6 technical factors ----------
   The whole backtest rests on this: the reconstructed signal must equal what the
   live 33-pt scorer would have computed for the same 6 factors on the same bar. */
function sumLive6(hist, sectorHist, spyHist) { // sum the pipeline's 6 reconstructable ladders
  const p = (r) => r.points ?? 0;
  return p(checkTrend(hist)) + p(check3MMomentum(hist)) + p(checkNearHigh(hist))
       + p(checkLiquidity(hist)) + p(checkVolumeSurge(null, hist))
       + p(checkSectorStrength(sectorHist, spyHist));
}
for (const [name, closes] of [
  ["clean uptrend", seg([[1, 118], [49, 112], [210, 90]])],
  ["pullback zone", seg([[1, 108], [49, 112], [1, 125], [209, 88]])],
  ["choppy flat", seg([[260, 100]])],
  ["downtrend", seg([[1, 88], [49, 95], [210, 120]])],
]) {
  T(`parity (${name}): computeShortSignal.techScore == live 6-factor sum`, () => {
    const hist = cleanHist(mkHist(closes, { vol: 1_500_000 }));
    const sectorHist = mkHist(seg([[1, 120], [62, 110], [7, 100]]), { vol: 1e6 }); // strengthFactor r63 leg
    const spyHist = mkHist(seg([[1, 105], [62, 102], [7, 100]]), { vol: 1e6 });
    const sig = computeShortSignal(hist, {
      spyStrength: strengthFactor(spyHist), sectorStrength: strengthFactor(sectorHist),
    });
    assert.equal(sig.techScore, sumLive6(hist, sectorHist, spyHist));
  });
}
PROOF("parity proof: a bar that scores >0 must not silently read as techScore 0", () => {
  const hist = cleanHist(mkHist(seg([[1, 118], [49, 112], [210, 90]]), { vol: 1_500_000 }));
  const sig = computeShortSignal(hist, { spyStrength: 0, sectorStrength: 0.2 });
  assert.ok(sig.techScore > 0);
});

/* ---------- stop wiring (v4: a loose 40% hard catastrophe cap, not 4×ATR) ---------- */
T("catastrophe stop is a fixed 40% of entry (via the SBT const)", () => {
  assert.equal(SBT_HARD_STOP_PCT, 0.40); // guards the v4 calibration constant the log advertises
});

console.log(`\n${pass} signal tests passed · ${proofs} negative-control proofs passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
