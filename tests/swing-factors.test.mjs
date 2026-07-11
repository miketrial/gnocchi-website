/* Swing scoring — the 11 factor ladders (short-pipeline.mjs), tested at their
   rung boundaries. Convention mirrors tests/qs-invariants.test.mjs:
     T(name, fn)      — real function returns the expected points.
     PROOF(name, fn)  — a deliberately-buggy mutant is REJECTED by the same
                        assertion, proving the boundary test isn't a no-op.
   Run: node tests/swing-factors.test.mjs */
import assert from "node:assert/strict";
import {
  checkTrend, check3MMomentum, checkNearHigh, checkLiquidity, checkAnalystRevisions,
  checkValuation, checkQuality, checkLeverage, checkCatalyst, checkVolumeSurge, checkSectorStrength,
} from "../netlify/lib/short-pipeline.mjs";
import { mkHist, seg, trendHist, isoMinus } from "./swing-helpers.mjs";

let pass = 0, proofs = 0, fail = 0;
const T = (name, fn) => { try { fn(); pass++; } catch (e) { fail++; console.log("❌ FAIL:", name, "\n   ", e.message); } };
const PROOF = (name, fn) => { try { fn(); proofs++; } catch (e) { fail++; console.log("❌ PROOF BROKEN:", name, "\n   ", e.message); } };
const pts = (r) => r.points;

/* ---------- 1. Trend (px vs 50/200 DMA, +8% strong band) ---------- */
T("Trend 3: px>50>200 & ≥8% above 50", () => assert.equal(pts(checkTrend(trendHist(120, 110, 90))), 3));
T("Trend 2: clean uptrend but <8% above 50", () => assert.equal(pts(checkTrend(trendHist(115, 110, 90))), 2));
T("Trend 1: above 50 but 50<200", () => assert.equal(pts(checkTrend(trendHist(115, 110, 130))), 1));
T("Trend 0: below 50DMA", () => assert.equal(pts(checkTrend(trendHist(100, 110, 90))), 0));
T("Trend na: <200 bars", () => assert.equal(checkTrend(mkHist(seg([[150, 100]]))).points, null));
PROOF("Trend proof: dropping the 8% gate would over-award 3 to the <8% case", () => {
  // buggy ladder without the pctAbove50>=0.08 clause calls the 4.45%-above case a 3.
  assert.equal(pts(checkTrend(trendHist(115, 110, 90))), 2); // real: correctly a 2
});

/* ---------- 2. 3M Momentum (63-day return) ---------- */
const momHist = (now) => mkHist(seg([[1, now], [70, 100]])); // index0=now, index62=100
T("Mom 3: +16%", () => assert.equal(pts(check3MMomentum(momHist(116))), 3));
T("Mom 2: +6%", () => assert.equal(pts(check3MMomentum(momHist(106))), 2));
T("Mom 1: +3% (≥0)", () => assert.equal(pts(check3MMomentum(momHist(103))), 1));
T("Mom 0: −5%", () => assert.equal(pts(check3MMomentum(momHist(95))), 0));
T("Mom na: return beyond +1000% sanity gate", () => assert.equal(check3MMomentum(momHist(1300)).points, null));
PROOF("Mom proof: a +16% move must NOT read as a 2", () => assert.notEqual(pts(check3MMomentum(momHist(116))), 2));

/* ---------- 3. Near High (re-tuned: pullback 5–18% off high is the sweet spot) ---------- */
// high placed at an interior bar; index0 = now.
const nearHist = (now, high) => mkHist(seg([[1, now], [99, 90], [1, high], [160, 90]]));
T("NearHigh 3: 9% off high (pullback zone)", () => assert.equal(pts(checkNearHigh(nearHist(100, 110))), 3));
T("NearHigh 2: pinned at high (≤5% off)", () => assert.equal(pts(checkNearHigh(nearHist(96, 100))), 2));
T("NearHigh 1: well off high (≤30%)", () => assert.equal(pts(checkNearHigh(nearHist(80, 110))), 1));
T("NearHigh 0: far from high (>30%)", () => assert.equal(pts(checkNearHigh(nearHist(70, 110))), 0));
PROOF("NearHigh proof: the OLD ladder scored 'at the high' a 3 — re-tune makes it a 2", () => {
  // OLD: offHigh<=0.05 => 3. NEW: pinned-at-high => 2, pullback => 3.
  assert.equal(pts(checkNearHigh(nearHist(96, 100))), 2);        // at-high is now a 2
  assert.equal(pts(checkNearHigh(nearHist(100, 110))), 3);       // pullback is the 3
});

/* ---------- 4. Liquidity (20-day avg $-volume) ---------- */
const liqHist = (vol) => mkHist(seg([[25, 100]]), { vol });
T("Liq 3: ≥$100M/day", () => assert.equal(pts(checkLiquidity(liqHist(1_500_000))), 3)); // 100*1.5M=$150M
T("Liq 2: ≥$20M/day", () => assert.equal(pts(checkLiquidity(liqHist(300_000))), 2));   // $30M
T("Liq 1: ≥$10M/day", () => assert.equal(pts(checkLiquidity(liqHist(120_000))), 1));   // $12M
T("Liq 0: <$10M/day", () => assert.equal(pts(checkLiquidity(liqHist(50_000))), 0));    // $5M
PROOF("Liq proof: $12M must not clear the $20M rung", () => assert.notEqual(pts(checkLiquidity(liqHist(120_000))), 2));

/* ---------- 5. Analyst Revisions (PT drift + rating drift composite) ---------- */
const ptRow = (then, now) => [[{ lastMonthCount: 5, lastMonthAvgPriceTarget: now, lastQuarterAvgPriceTarget: then }], []];
T("Analyst 3: PT +10%", () => assert.equal(pts(checkAnalystRevisions(...ptRow(100, 110))), 3));
T("Analyst 2: PT +2%", () => assert.equal(pts(checkAnalystRevisions(...ptRow(100, 102))), 2));
T("Analyst 1: PT −3%", () => assert.equal(pts(checkAnalystRevisions(...ptRow(100, 97))), 1));
T("Analyst 0: PT −10%", () => assert.equal(pts(checkAnalystRevisions(...ptRow(100, 90))), 0));
T("Analyst na: no PT and no rating history", () => assert.equal(checkAnalystRevisions([], []).points, null));
PROOF("Analyst proof: a −10% cut must not read as ≥1", () => assert.equal(pts(checkAnalystRevisions(...ptRow(100, 90))), 0));

/* ---------- 6. Valuation (fwd P/E vs sector 75th pct; null industry ⇒ 30) ---------- */
T("Val 3: PE 20 (≤22.5)", () => assert.equal(pts(checkValuation(100, 5, null)), 3));
T("Val 2: PE 28 (≤30)", () => assert.equal(pts(checkValuation(140, 5, null)), 2));
T("Val 1: PE 40 (≤45)", () => assert.equal(pts(checkValuation(200, 5, null)), 1));
T("Val 0: PE 50 (>45)", () => assert.equal(pts(checkValuation(250, 5, null)), 0));
T("Val na: non-positive fwd EPS", () => assert.equal(checkValuation(100, 0, null).points, null));
T("Val na: PE beyond sanity (2000x)", () => assert.equal(checkValuation(100, 0.05, null).points, null));

/* ---------- 7. Quality (FCF sign + ROE vs sector median; null industry ⇒ 0.12) ---------- */
const cf = (fcf) => [{ freeCashFlow: fcf }];
const km = (roe) => [{ returnOnEquity: roe }];
T("Quality 3: +FCF & ROE 20% (>1.5×median)", () => assert.equal(pts(checkQuality(cf(1e8), km(0.20), null)), 3));
T("Quality 2: +FCF & ROE 15% (>median)", () => assert.equal(pts(checkQuality(cf(1e8), km(0.15), null)), 2));
T("Quality 1: −FCF but ROE 15% (one passes)", () => assert.equal(pts(checkQuality(cf(-1e8), km(0.15), null)), 1));
T("Quality 0: −FCF & ROE 5%", () => assert.equal(pts(checkQuality(cf(-1e8), km(0.05), null)), 0));
T("Quality na: ROE missing", () => assert.equal(checkQuality(cf(1e8), [{}], null).points, null));

/* ---------- 8. Leverage (Net Debt / EBITDA) ---------- */
const incQ = (op, da) => [0, 1, 2, 3].map(() => ({ operatingIncome: op / 4, depreciationAndAmortization: da / 4 }));
const bsRow = (debt, cash) => [{ totalDebt: debt, cashAndShortTermInvestments: cash }];
T("Lev 3: ratio <1 (net cash)", () => assert.equal(pts(checkLeverage(bsRow(0, 1e9), incQ(500e6, 100e6))), 3));
T("Lev 2: ratio 2.0", () => assert.equal(pts(checkLeverage(bsRow(1.8e9, 0.6e9), incQ(500e6, 100e6))), 2)); // net 1.2B / 0.6B
T("Lev 1: ratio 4.0", () => assert.equal(pts(checkLeverage(bsRow(3.0e9, 0.6e9), incQ(500e6, 100e6))), 1)); // net 2.4B / 0.6B
T("Lev 0: ratio 6.0", () => assert.equal(pts(checkLeverage(bsRow(4.2e9, 0.6e9), incQ(500e6, 100e6))), 0)); // net 3.6B / 0.6B
T("Lev 0: negative EBITDA with net debt", () => assert.equal(pts(checkLeverage(bsRow(2e9, 0), incQ(-500e6, 0))), 0));
T("Lev 3: negative EBITDA but net cash", () => assert.equal(pts(checkLeverage(bsRow(0, 1e9), incQ(-500e6, 0))), 3));
T("Lev na: no balance sheet", () => assert.equal(checkLeverage([], incQ(500e6, 100e6)).points, null));

/* ---------- 9. Catalyst (earnings 7–90d out + beat streak) ---------- */
const earn = (opts) => {
  const rows = [];
  for (const q of opts.past || []) rows.push({ date: q.date, epsActual: q.a, epsEstimated: q.e });
  if (opts.next != null) rows.push({ date: isoMinus("2026-07-10", -opts.next), epsActual: null, epsEstimated: null });
  return rows;
};
const past4 = (beats) => Array.from({ length: 4 }, (_, i) => ({ date: isoMinus("2026-07-10", 30 * (i + 1)), a: beats > i ? 2 : 1, e: 1.5 }));
T("Catalyst 3: earnings 30d out, beat 3/4", () => assert.equal(pts(checkCatalyst(earn({ next: 30, past: past4(3) }))), 3));
T("Catalyst 2: earnings 30d out, beat 1/4", () => assert.equal(pts(checkCatalyst(earn({ next: 30, past: past4(1) }))), 2));
T("Catalyst 0: earnings 3d out (too soon)", () => assert.equal(pts(checkCatalyst(earn({ next: 3, past: past4(3) }))), 0));
T("Catalyst 0: earnings 120d out (outside window)", () => assert.equal(pts(checkCatalyst(earn({ next: 120, past: past4(3) }))), 0));
T("Catalyst na: no upcoming earnings", () => assert.equal(checkCatalyst(earn({ past: past4(3) })).points, null));
PROOF("Catalyst proof: 3-days-out must be 0, not a beat-streak 3", () =>
  assert.equal(pts(checkCatalyst(earn({ next: 3, past: past4(3) }))), 0));

/* ---------- 10. Volume Surge (recent surge + 10-day money flow) ---------- */
// helper: 22 bars; newest bar direction + rv controlled via volumes.
function volHist({ dir = "up", rvMult = 1, flow = "up" }) {
  // base 20 prior bars volume=1M; closes ascending(up)/descending(down) for flow
  const closes = [];
  const step = flow === "up" ? -1 : 1; // newest-first: up-flow => older are lower
  for (let i = 0; i < 22; i++) closes.push(100 + step * i * (flow === "flat" ? 0 : 1));
  const over = {};
  // newest bar (index0) direction vs index1
  over[0] = { close: dir === "up" ? closes[1] + 1 : closes[1] - 1, volume: 1_000_000 * rvMult };
  for (let i = 1; i < 22; i++) over[i] = { volume: 1_000_000 };
  return mkHist(closes, { over });
}
T("Vol 0: heavy down day (rv≥1.5, isDown) ⇒ distribution", () => assert.equal(pts(checkVolumeSurge(null, volHist({ dir: "down", rvMult: 2, flow: "down" }))), 0));
T("Vol 3: rv≥2.5, up day, sustained buying", () => assert.equal(pts(checkVolumeSurge(null, volHist({ dir: "up", rvMult: 3, flow: "up" }))), 3));
T("Vol na: <21 bars", () => assert.equal(checkVolumeSurge(null, mkHist(seg([[15, 100]]))).points, null));
PROOF("Vol proof: a 2× down day is distribution (0), never accumulation", () =>
  assert.notEqual(pts(checkVolumeSurge(null, volHist({ dir: "down", rvMult: 2, flow: "down" }))), 3));

/* ---------- 11. Sector Relative Strength (sector strengthFactor − SPY's) ---------- */
// 70-bar histories ⇒ strengthFactor uses only the r63 leg = close[0]/close[63]−1.
const rsHist = (top) => mkHist(seg([[1, top], [62, 110], [7, 100]])); // close[0]=top, close[63]=100
T("SecRS 3: sector +21% vs SPY +5% (delta +16pp)", () =>
  assert.equal(pts(checkSectorStrength(rsHist(121), rsHist(105))), 3));
T("SecRS 2: delta +8pp", () => assert.equal(pts(checkSectorStrength(rsHist(108), rsHist(100))), 2));
T("SecRS 1: delta 0 (in line)", () => assert.equal(pts(checkSectorStrength(rsHist(110), rsHist(110))), 1));
T("SecRS 0: sector −0% vs SPY +10% (delta −10pp)", () =>
  assert.equal(pts(checkSectorStrength(rsHist(100), rsHist(110))), 0));
T("SecRS na: history too short", () => assert.equal(checkSectorStrength(mkHist(seg([[40, 100]])), rsHist(110)).points, null));

console.log(`\n${pass} factor-ladder tests passed · ${proofs} negative-control proofs passed · ${fail} failed`);
process.exit(fail ? 1 : 0);
