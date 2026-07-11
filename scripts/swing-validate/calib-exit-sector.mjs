/* Risk-first calibration — EXIT PLATEAU + SECTOR verdict, universe-488 gated (uptrend +
   $300M/day). Finalizes the exit params around the emerging hold63 + loose-cap winner and
   tests the one defensible sector move (exclude structurally-flat sectors) OOS + by regime.
   Run: node scripts/swing-validate/calib-exit-sector.mjs */
import {
  loadSurvivorCache, labelUniverse, aggregateShortRule, simulateShortExit, portfolioSim,
  bootstrapPortfolio, splitByDate, buildRegimeContext, regimeOf, round,
} from "./lib.mjs";
import { readFileSync, writeFileSync } from "node:fs";

const cache500 = JSON.parse(readFileSync(new URL("../../scratchpad/swing-validate/universe500-cache.json", import.meta.url), "utf8"));
const nameDollarVol = (h) => { const dv = h.map(b => (b.close||0)*(b.volume||0)).filter(x=>x>0).sort((a,b)=>a-b); return dv.length ? dv[Math.floor(dv.length/2)] : 0; };
const isUptrend = (r) => (r.factors.find(f => f.key === "TREND")?.buy ?? 0) >= 2;
function gated(cache, floor = 300e6) {
  const { records } = labelUniverse(cache, { bidirectional: false });
  const dv = {}; for (const s of Object.keys(cache.histBySym)) dv[s] = nameDollarVol(cache.histBySym[s]);
  const recs = records.filter(r => isUptrend(r) && dv[r.sym] >= floor);
  for (const r of recs) r.sector = cache.meta?.[r.sym]?.sector || "?";
  return recs;
}
const recs = gated(cache500);
const spy = cache500.spyHist;
const line = (label, rule, recSet = recs) => {
  const agg = aggregateShortRule(recSet, rule, spy);
  const rets = recSet.map(r => simulateShortExit(r, rule).pnl);
  const tail = round(rets.filter(x => x < -25).length / rets.length * 100);
  const { IS, OOS } = splitByDate(recSet);
  const p = portfolioSim(recSet, rule, {});
  return { label, n: agg.n, exp: round(agg.expectancy), worst: round(agg.worst), tailPct: tail,
    isExp: round(aggregateShortRule(IS, rule, spy).expectancy), oosExp: round(aggregateShortRule(OOS, rule, spy).expectancy),
    cagr: round(p.cagr), maxDD: round(p.maxDDpct), sortino: round(p.sortinoPerTrade, 3) };
};
const show = (rows) => { console.log("variant                       n    exp   worst  tail%  isExp oosExp  CAGR  maxDD  Sortino");
  for (const r of rows) console.log(`${r.label.padEnd(28)} ${String(r.n).padStart(4)} ${String(r.exp).padStart(5)} ${String(r.worst).padStart(6)} ${String(r.tailPct).padStart(5)} ${String(r.isExp).padStart(6)} ${String(r.oosExp).padStart(6)} ${String(r.cagr).padStart(5)} ${String(r.maxDD).padStart(6)} ${String(r.sortino).padStart(7)}`); };

const out = {};

// ---- A. Cap plateau on hold63 (25..45) ----
console.log("═══ A. CAP PLATEAU · hold63 · universe-488 gated ═══");
const capRows = [line("hold63 (no cap)", { target: "none", timeStop: 63 })];
for (const c of [25, 30, 35, 40, 45]) capRows.push(line(`hold63_cap${c}`, { target: "none", timeStop: 63, hardStopPct: c / 100 }));
show(capRows); out.capPlateau = capRows;

// ---- B. Exit variants around the winner ----
console.log("\n═══ B. EXIT VARIANTS (hold-period, ATR backstop, chandelier, death-cross) · cap35 ═══");
const varRows = [
  line("hold63_cap35 (candidate)",   { target: "none",   timeStop: 63, hardStopPct: 0.35 }),
  line("hold84_cap35",               { target: "none",   timeStop: 84, hardStopPct: 0.35 }),
  line("hold63_atr40_cap35",         { target: "none",   timeStop: 63, hardStopPct: 0.35, initStopAtr: 4.0 }),
  line("hold63_atr50_cap35",         { target: "none",   timeStop: 63, hardStopPct: 0.35, initStopAtr: 5.0 }),
  line("hold63_chand50_cap35",       { target: "none",   timeStop: 63, hardStopPct: 0.35, trailAtr: 5.0 }),
  line("maCross_cap35 (death-cross)",{ target: "maCross",timeStop: 63, hardStopPct: 0.35 }),
  line("incumbent maCross_atr40",    { target: "maCross",timeStop: 63, initStopAtr: 4.0 }),
];
show(varRows); out.exitVariants = varRows;

// ---- C. Bootstrap CIs on the 3 finalists ----
console.log("\n═══ C. NAME-CLUSTERED BOOTSTRAP CIs (400 draws) ═══");
const finalists = [
  ["hold63_cap35", { target: "none", timeStop: 63, hardStopPct: 0.35 }],
  ["hold63 (no cap)", { target: "none", timeStop: 63 }],
  ["incumbent maCross_atr40", { target: "maCross", timeStop: 63, initStopAtr: 4.0 }],
];
out.bootstrap = [];
for (const [label, rule] of finalists) {
  const b = bootstrapPortfolio(recs, rule, {}, { iters: 400 });
  const f = (o) => `${round(o.lo)}–${round(o.median)}–${round(o.hi)}`;
  console.log(`${label.padEnd(28)} CAGR ${f(b.cagr).padStart(20)}  maxDD ${f(b.maxDD).padStart(20)}  Sortino ${round(b.sortino.median,3)}`);
  out.bootstrap.push({ label, cagr: b.cagr, maxDD: b.maxDD, sortino: b.sortino });
}

// ---- D. Sector verdict: per-sector under hold63_cap35 + structural-flat exclusion ----
console.log("\n═══ D. PER-SECTOR · hold63_cap35 · universe-488 gated ═══");
const CAP35 = { target: "none", timeStop: 63, hardStopPct: 0.35 };
const bySector = {};
for (const r of recs) (bySector[r.sector] ||= []).push(r);
const secRows = [];
for (const [sec, rs] of Object.entries(bySector).sort((a, b) => b[1].length - a[1].length)) {
  if (rs.length < 60) continue;
  const agg = aggregateShortRule(rs, CAP35, spy);
  const { IS, OOS } = splitByDate(rs);
  secRows.push({ sector: sec, n: rs.length, exp: round(agg.expectancy), worst: round(agg.worst),
    isExp: round(aggregateShortRule(IS, CAP35, spy).expectancy), oosExp: round(aggregateShortRule(OOS, CAP35, spy).expectancy), edge: round(agg.edge) });
}
console.log("sector                    n    exp   worst  isExp oosExp  edgeVsSPY");
for (const r of secRows.sort((a,b)=>b.exp-a.exp)) console.log(`${r.sector.padEnd(24)} ${String(r.n).padStart(4)} ${String(r.exp).padStart(5)} ${String(r.worst).padStart(6)} ${String(r.isExp).padStart(6)} ${String(r.oosExp).padStart(6)} ${String(r.edge).padStart(6)}`);
out.perSector = secRows;

// Structural-flat exclusion: drop Consumer Defensive / Utilities / Energy / Real Estate.
const FLAT = new Set(["Consumer Defensive", "Utilities", "Energy", "Real Estate"]);
const kept = recs.filter(r => !FLAT.has(r.sector));
console.log("\n═══ E. STRUCTURAL-FLAT-SECTOR EXCLUSION · hold63_cap35 (OOS + regime) ═══");
const exRows = [line("ALL sectors", CAP35, recs), line("EXCL flat 4 sectors", CAP35, kept)];
show(exRows);
// regime split (bull vs bear by SPY 200DMA)
const ctx = buildRegimeContext(spy, cache500.vixHist);
const regimeAgg = (recSet) => {
  const bull = recSet.filter(r => regimeOf(ctx, r.entryDate).trend === "bull");
  const bear = recSet.filter(r => regimeOf(ctx, r.entryDate).trend === "bear");
  return { bull: round(aggregateShortRule(bull, CAP35, spy).expectancy), bullN: bull.length,
           bear: round(aggregateShortRule(bear, CAP35, spy).expectancy), bearN: bear.length };
};
console.log("ALL  regime:", JSON.stringify(regimeAgg(recs)));
console.log("EXCL regime:", JSON.stringify(regimeAgg(kept)));
out.flatExclusion = { all: exRows[0], excl: exRows[1], regimeAll: regimeAgg(recs), regimeExcl: regimeAgg(kept) };

writeFileSync(new URL("../../scratchpad/swing-validate/calib-exit-sector.json", import.meta.url), JSON.stringify(out, null, 2));
console.log("\n→ wrote scratchpad/swing-validate/calib-exit-sector.json");
