/* Swing backtest signal — computeShortSignal (short-backtest.mjs): the 6 EOD-
   computable factors (0–18), the entry gate, and — critically — PARITY with the
   live scorer's technical core, proving the seed replay and the forward fold key
   off the same numbers the site shows (the "byte-identical" claim in the code).
   Run: node tests/swing-signal.test.mjs */
import assert from "node:assert/strict";
import { computeShortSignal, SBT_ENTRY_MIN, SBT_HARD_STOP_PCT, SBT_LIQ_FLOOR, SBT_SECRS_MIN, SBT_CONV_DVOL, SBT_CONV_MOM } from "../netlify/lib/short-backtest.mjs";
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
T("entryStrong implies all four gate conditions (score, uptrend, $1B floor, sector-RS)", () => {
  const s = computeShortSignal(mkHist(riseCloses, { vol: 10_000_000 }), { spyStrength: 0, sectorStrength: 0.3 });
  assert.equal(s.entryStrong, true);
  assert.ok(s.techScore >= SBT_ENTRY_MIN);
  assert.equal(s.uptrend, true);
  assert.ok(s.avgDollarVol >= SBT_LIQ_FLOOR);
  assert.ok(s.secPts >= SBT_SECRS_MIN);
});
PROOF("entry gate proof: a downtrend can never be entryStrong even with max sector RS", () =>
  assert.equal(computeShortSignal(trendHist(90, 95, 120), { spyStrength: -1, sectorStrength: 1 }).entryStrong, false));

/* ---------- liquidity guardrail (v5: ≥$1B/day) — the deep-study defensive filter ---------- */
T("guardrail: entryStrong FALSE below $1B/day even when strong + uptrend + sector-leading", () => {
  const opts = { spyStrength: 0, sectorStrength: 0.3 };
  const hi = computeShortSignal(mkHist(riseCloses, { vol: 10_000_000 }), opts); // ~$1.2B/day
  const lo = computeShortSignal(mkHist(riseCloses, { vol: 5_000_000 }), opts);  // ~$0.6B/day
  assert.ok(hi.avgDollarVol >= SBT_LIQ_FLOOR && lo.avgDollarVol < SBT_LIQ_FLOOR);
  assert.equal(hi.techScore, lo.techScore);   // the guardrail must NOT change the score
  assert.equal(hi.entryStrong, true);
  assert.equal(lo.entryStrong, false);         // only the liquidity floor flipped it
});
PROOF("guardrail proof: it is the $-volume floor (not the score) that blocks the sub-tier name", () => {
  const lo = computeShortSignal(mkHist(riseCloses, { vol: 5_000_000 }), { spyStrength: 0, sectorStrength: 0.3 });
  assert.ok(lo.techScore >= SBT_ENTRY_MIN && lo.uptrend && lo.secPts >= SBT_SECRS_MIN); // strong + uptrend + sector-leading...
  assert.equal(lo.entryStrong, false);                    // ...yet blocked, purely by the guardrail
});

/* ---------- v5 sector-leadership gate (Sector-RS ≥ 2) ---------- */
T("v5 gate: a lagging sector (SECRS<2) blocks entryStrong even when liquid + uptrend", () => {
  const lead = computeShortSignal(mkHist(riseCloses, { vol: 10_000_000 }), { spyStrength: 0, sectorStrength: 0.3 });   // sector leads SPY
  const lag = computeShortSignal(mkHist(riseCloses, { vol: 10_000_000 }), { spyStrength: 0.3, sectorStrength: -0.2 }); // sector lags SPY
  assert.ok(lead.secPts >= SBT_SECRS_MIN && lead.entryStrong === true);   // sector leads → can fire
  assert.ok(lag.secPts < SBT_SECRS_MIN && lag.entryStrong === false);     // sector lags → blocked
});

/* ---------- v6 conviction tier: entryStrong AND $-vol≥$3B/day AND 3mo-mom≥40% ---------- */
// A steep, liquid runner: the newest 63 bars rise 95→140 (mom63 = 140/95−1 ≈ +47%),
// the older 197 rise 60→95 (keeps a clean px>50DMA>200DMA uptrend). At vol 25M/day
// (~$3.3B) it clears the $3B conviction floor; at 10M (~$1.3B) it's entryStrong-only.
const steepCloses = Array.from({ length: 260 }, (_, i) =>
  Math.round((i <= 62 ? 140 - i * (45 / 62) : 95 - (i - 62) * (35 / 197)) * 100) / 100);
T("conviction TRUE: strong entry + ≥$3B/day + 3mo momentum ≥40%", () => {
  const s = computeShortSignal(mkHist(steepCloses, { vol: 25_000_000 }), { spyStrength: 0, sectorStrength: 0.3 });
  assert.equal(s.entryStrong, true);
  assert.ok(s.avgDollarVol >= SBT_CONV_DVOL);
  assert.ok(s.mom63 >= SBT_CONV_MOM);
  assert.equal(s.conviction, true);
});
T("conviction FALSE on the $1–3B liquidity tier (entryStrong still true)", () => {
  const s = computeShortSignal(mkHist(steepCloses, { vol: 10_000_000 }), { spyStrength: 0, sectorStrength: 0.3 });
  assert.equal(s.entryStrong, true);                        // clears the $1B entry floor…
  assert.ok(s.avgDollarVol < SBT_CONV_DVOL);                // …but not the $3B conviction floor
  assert.equal(s.conviction, false);
});
T("conviction FALSE when 3mo momentum < 40% (entryStrong still true)", () => {
  const s = computeShortSignal(mkHist(riseCloses, { vol: 30_000_000 }), { spyStrength: 0, sectorStrength: 0.3 }); // ~$3.5B/day, mom ≈ +11%
  assert.equal(s.entryStrong, true);
  assert.ok(s.avgDollarVol >= SBT_CONV_DVOL);
  assert.ok(s.mom63 < SBT_CONV_MOM);
  assert.equal(s.conviction, false);
});
PROOF("conviction proof: a blocked entry can NEVER be conviction, even with $3B + 47% momentum", () => {
  // Same steep liquid runner, but the sector LAGS SPY → entryStrong false → the
  // tier must not fire (conviction is a sub-tier of valid entries, not a bypass).
  const s = computeShortSignal(mkHist(steepCloses, { vol: 25_000_000 }), { spyStrength: 0.3, sectorStrength: -0.2 });
  assert.ok(s.avgDollarVol >= SBT_CONV_DVOL && s.mom63 >= SBT_CONV_MOM); // tier inputs pass…
  assert.equal(s.entryStrong, false);                                    // …but the gate doesn't
  assert.equal(s.conviction, false);
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
