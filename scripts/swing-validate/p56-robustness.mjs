/* ===== P5/P6 — robustness + benchmarks. Deterministic, off-cache. Emits
   p56-robustness.json. Regime buckets, Monte-Carlo CI + max-DD distribution,
   cost sweep, multiple-testing haircut, and honest benchmarks (SPY, equal-weight
   universe, and a naive top-decile-63d-momentum baseline — does the 11-factor
   score beat dumb momentum?). */
import {
  loadSurvivorCache, loadPitCache, labelUniverse, splitByDate,
  aggregateShortRule, aggregateNet, swingExitGrid, simulateShortExit,
  buildRegimeContext, regimeOf, fwdReturnPct, bootstrapMeanCI, bootstrapMaxDD,
  multipleTestingCheck, mean, winRate, round, COST_BAND_BPS,
} from "./lib.mjs";
import { writeFileSync } from "node:fs";

const RULES = ["hold63", "maCross", "maCross_atr40"];
const rule = (l) => swingExitGrid().find(r => r.label === l);

// Per-regime expectancy for a rule.
function regimeTable(records, ruleObj, ctx) {
  const groups = {};
  for (const rec of records) {
    const g = regimeOf(ctx, rec.entryDate);
    const key = `${g.trend}/${g.vol}`;
    (groups[key] ||= []).push(rec);
  }
  const out = {};
  for (const [key, recs] of Object.entries(groups)) {
    const a = aggregateShortRule(recs, ruleObj, null);
    out[key] = { n: recs.length, exp: round(a.expectancy), win: round(a.winRate, 3), worst: round(a.worst) };
  }
  return out;
}

// Monte-Carlo: bootstrap the per-trade pnl → CI on expectancy. (Portfolio max-DD
// is reported from the capital-constrained sim in p4-calibration.json — reshuffling
// raw per-trade returns and compounding them at full size is NOT a portfolio DD and
// would badly overstate it, so it is deliberately omitted here.)
function monteCarlo(records, ruleObj) {
  const rets = records.map(r => simulateShortExit(r, ruleObj).pnl);
  const ci = bootstrapMeanCI(rets, { iters: 3000, seed: 4242 });
  const mt = multipleTestingCheck(rets, 24); // 24 exit configs tried in the grid
  return {
    n: rets.length, expMean: round(ci.mean), ci95: [round(ci.lo), round(ci.hi)],
    tStat: round(mt.tStat, 2), pBonferroni: round(mt.pBonferroni, 4), survivesMultipleTesting: mt.survives,
  };
}

// Cost sweep for a rule.
function costSweep(records, ruleObj, spyHist) {
  return COST_BAND_BPS.map(bps => ({ bps, netExp: round(aggregateNet(records, ruleObj, spyHist, bps).netExpectancy) }));
}

// Benchmarks: equal-weight universe fwd-21d, and a naive top-decile-63d-momentum
// baseline vs the score-based entries. Built directly from the cache histories.
function benchmarks(cache, records) {
  const { histBySym } = cache;
  // Equal-weight universe: mean fwd-21d over EVERY eligible bar (not just entries).
  const allFwd = [], momSamples = [];
  for (const sym of Object.keys(histBySym)) {
    const hist = histBySym[sym];
    if (!hist || hist.length < 300) continue;
    for (let i = 21; i + 21 < hist.length && i < hist.length - 260; i++) {
      const closes = hist.slice(i, i + 260).map(d => d.close).filter(p => p > 0);
      if (closes.length < 200) continue;
      const price = closes[0];
      const fwd = hist[i - 21]?.close;              // 21 sessions forward (newest-first)
      if (!(fwd > 0)) continue;
      const ret = (fwd - price) / price * 100;
      allFwd.push(ret);
      const ref = closes[62];                        // 63-day momentum
      if (ref > 0) momSamples.push({ mom: price / ref - 1, ret });
    }
  }
  // top-decile momentum baseline
  momSamples.sort((a, b) => b.mom - a.mom);
  const topDecile = momSamples.slice(0, Math.floor(momSamples.length / 10));
  const scoreEntries = records.map(r => fwdReturnPct(r, 21)).filter(x => x != null);
  return {
    equalWeightUniverse: { n: allFwd.length, avgFwd21: round(mean(allFwd)), win: round(winRate(allFwd), 3) },
    naiveTopDecileMomentum: { n: topDecile.length, avgFwd21: round(mean(topDecile.map(x => x.ret))), win: round(winRate(topDecile.map(x => x.ret)), 3) },
    scoreEntries: { n: scoreEntries.length, avgFwd21: round(mean(scoreEntries)), win: round(winRate(scoreEntries), 3) },
  };
}

function main() {
  const survivor = loadSurvivorCache();
  const pit = loadPitCache();
  const { records } = labelUniverse(survivor, { bidirectional: false });
  const ctx = buildRegimeContext(survivor.spyHist, pit?.vixHist || null);

  const result = { rules: {}, benchmarks: benchmarks(survivor, records), vixUsed: !!pit?.vixHist };
  for (const l of RULES) {
    const ro = rule(l);
    result.rules[l] = {
      regime: regimeTable(records, ro, ctx),
      monteCarlo: monteCarlo(records, ro),
      costSweep: costSweep(records, ro, survivor.spyHist),
    };
  }
  writeFileSync(new URL("../../scratchpad/swing-validate/p56-robustness.json", import.meta.url), JSON.stringify(result, null, 2));

  // ---- console ----
  console.log(`\n── P5 regime table (regime axis: SPY vs 200DMA × ${result.vixUsed ? "VIX" : "SPY-realized-vol"} terciles) ──`);
  for (const l of RULES) {
    console.log(`  ${l}:`);
    const t = result.rules[l].regime;
    for (const k of Object.keys(t).sort()) console.log(`    ${k.padEnd(14)} n${String(t[k].n).padStart(5)}  exp ${String(t[k].exp).padStart(6)}%  win ${t[k].win}  worst ${t[k].worst}%`);
  }
  console.log(`\n── Monte-Carlo (3000 resamples) + multiple-testing ──`);
  for (const l of RULES) { const m = result.rules[l].monteCarlo; console.log(`  ${l.padEnd(14)} exp ${m.expMean}%  CI95 [${m.ci95}]  t=${m.tStat} pBonf=${m.pBonferroni} survives=${m.survivesMultipleTesting}  (portfolio maxDD → p4)`); }
  console.log(`\n── cost sweep (net expectancy %) ──`);
  for (const l of RULES) console.log(`  ${l.padEnd(14)} ` + result.rules[l].costSweep.map(c => `${c.bps}bps:${c.netExp}`).join("  "));
  console.log(`\n── P6 benchmarks (fwd-21d) ──`);
  const b = result.benchmarks;
  console.log(`  equal-weight universe   ${b.equalWeightUniverse.avgFwd21}% (n${b.equalWeightUniverse.n}, win ${b.equalWeightUniverse.win})`);
  console.log(`  naive top-decile 63d mom ${b.naiveTopDecileMomentum.avgFwd21}% (n${b.naiveTopDecileMomentum.n}, win ${b.naiveTopDecileMomentum.win})`);
  console.log(`  11-factor score entries  ${b.scoreEntries.avgFwd21}% (n${b.scoreEntries.n}, win ${b.scoreEntries.win})`);
  console.log(`\nP56 → scratchpad/swing-validate/p56-robustness.json`);
}
main();
