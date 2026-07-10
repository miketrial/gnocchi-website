/* ===== #2 — re-backtest reweighted composites END-TO-END vs equal-weight ========
   For each candidate weighting, re-label the universe on the WEIGHTED core score,
   sweep the entry threshold, and report raw fwd-21d + incumbent-exit expectancy +
   IS/OOS + edge + worst. Matched-entry-count comparison so it's apples-to-apples.
   Ship a reweighting only if it beats equal-weight on OOS at comparable n AND
   survives the multiple-testing haircut; else the honest verdict is "not beaten".
   Usage: node scripts/swing-validate/p7-composite.mjs [survivor|500] */
import {
  loadSurvivorCache, loadPitCache, labelUniverseWeighted, splitByDate,
  aggregateShortRule, swingExitGrid, fwdReturnPct, mean, winRate, round,
} from "./lib.mjs";
import { readFileSync, existsSync, writeFileSync } from "node:fs";

const which = process.argv[2] || "survivor";
function loadCache() {
  if (which === "500") {
    const u = new URL("../../scratchpad/swing-validate/universe500-cache.json", import.meta.url);
    if (!existsSync(u)) { console.error("universe500-cache.json not built yet"); process.exit(1); }
    return JSON.parse(readFileSync(u, "utf8"));
  }
  return loadSurvivorCache();
}

// Candidate weightings over FACTOR_KEYS [TREND, MOM, EXTREME, LIQ, VOL, SECRS].
const CANDIDATES = [
  { name: "equal",   weights: {},                                              bars: [10, 11, 12, 13, 14] },
  { name: "dropVOL", weights: { VOL: 0 },                                       bars: [8, 9, 10, 11, 12] },
  { name: "lean",    weights: { EXTREME: 2, SECRS: 2, TREND: 0.5, MOM: 0.5, VOL: 0 }, bars: [9, 10, 11, 12, 13] },
  { name: "icw",     weights: { TREND: 0, MOM: 0, LIQ: 0, VOL: 0, EXTREME: 1, SECRS: 1 }, bars: [2, 3, 4, 5] }, // liq still gates via liqGate≥1
];
const INC = swingExitGrid().find(r => r.label === "maCross_atr40");

function evalAt(cache, weights, threshold) {
  const recs = labelUniverseWeighted(cache, { weights, threshold });
  if (!recs.length) return { threshold, n: 0 };
  const raw = recs.map(r => fwdReturnPct(r, 21)).filter(x => x != null);
  const { OOS } = splitByDate(recs);
  const a = aggregateShortRule(recs, INC, cache.spyHist);
  const o = aggregateShortRule(OOS, INC, cache.spyHist);
  return {
    threshold, n: recs.length,
    rawFwd21: round(mean(raw)), rawWin: round(winRate(raw), 3),
    incExp: round(a.expectancy), incEdge: round(a.edge), incWorst: round(a.worst), incOOS: round(o.expectancy),
  };
}

function main() {
  const cache = loadCache();
  const nNames = Object.keys(cache.histBySym).length;
  console.log(`\n#2 composite re-backtest — ${which} universe (${nNames} names), incumbent exit maCross_atr40, fwd-21d\n`);

  const result = { universe: which, nNames, candidates: {} };
  for (const c of CANDIDATES) {
    console.log(`── ${c.name} ${JSON.stringify(c.weights)} ──`);
    console.log("  thr    n     rawFwd  rawWin  incExp  incEdge incWorst incOOS");
    const rows = c.bars.map(th => evalAt(cache, c.weights, th));
    result.candidates[c.name] = { weights: c.weights, sweep: rows };
    for (const r of rows) {
      if (!r.n) { console.log(`  ${String(r.threshold).padStart(3)}   (no entries)`); continue; }
      console.log(`  ${String(r.threshold).padStart(3)}  ${String(r.n).padStart(5)}  ${String(r.rawFwd21).padStart(6)}  ${String(r.rawWin).padStart(5)}  ${String(r.incExp).padStart(6)}  ${String(r.incEdge).padStart(6)}  ${String(r.incWorst).padStart(7)}  ${String(r.incOOS).padStart(6)}`);
    }
    console.log("");
  }

  // Matched-n comparison: anchor to a target n REACHABLE by every candidate (the
  // reweightings top out ~2500 entries), and compare each at its nearest-n row to
  // equal-weight at the same n — so any win is selectivity-controlled, not just
  // "fewer trades ⇒ higher expectancy".
  const targetN = 2450;
  const eqMid = result.candidates.equal.sweep.filter(r => r.n).reduce((b, r) => Math.abs(r.n - targetN) < Math.abs(b.n - targetN) ? r : b, result.candidates.equal.sweep.find(r => r.n));
  console.log(`── matched-n comparison (target n≈${targetN}, equal@bar12: rawFwd ${eqMid.rawFwd21}%, incOOS ${eqMid.incOOS}%) ──`);
  const nearest = (rows) => rows.filter(r => r.n).reduce((best, r) => (Math.abs(r.n - targetN) < Math.abs(best.n - targetN) ? r : best), rows.find(r => r.n) || {});
  const comp = {};
  for (const c of CANDIDATES) {
    const r = nearest(result.candidates[c.name].sweep);
    comp[c.name] = r;
    const beats = (r.rawFwd21 > eqMid.rawFwd21) && (r.incOOS > eqMid.incOOS);
    console.log(`  ${c.name.padEnd(8)} n=${String(r.n).padStart(5)}  rawFwd ${String(r.rawFwd21).padStart(6)}%  incOOS ${String(r.incOOS).padStart(6)}%  incEdge ${String(r.incEdge).padStart(5)}  ${c.name !== "equal" ? (beats ? "◀ beats equal on BOTH" : "— no clear win") : ""}`);
  }
  result.matchedN = { targetN, eqMid, comp };
  writeFileSync(new URL(`../../scratchpad/swing-validate/p7-composite-${which}.json`, import.meta.url), JSON.stringify(result, null, 2));
  console.log(`\n→ scratchpad/swing-validate/p7-composite-${which}.json`);
}
main();
