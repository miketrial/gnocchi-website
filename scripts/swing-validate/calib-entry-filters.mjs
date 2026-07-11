/* Risk-first calibration — ENTRY FILTERS, measured on top of the emerging shippable
   exit (hold63 + loose 35% cap), gated (uptrend + $300M/day). Each filter is judged on
   risk reduction (worst, tail%<−25, portfolio maxDD) vs the entries/expectancy it costs.
     · earnings-avoidance gate {5,7,10 calendar days} — survivors only (fundamentals-cache
       has earnings). Reports whether it catches the HON −47% gap (it does NOT — HON was a
       news gap, next earnings ~4wk out).
     · ATR% ceiling {6,7,8%} — skip hyper-volatile names.
     · distance-above-200DMA ceiling {15,25,40%} — skip the most-extended names.
     · liquidity floor {300M vs 500M}.
     · entry-bar sweep {10..16} plateau check.
   Run: node scripts/swing-validate/calib-entry-filters.mjs */
import {
  loadSurvivorCache, labelUniverse, aggregateShortRule, simulateShortExit,
  portfolioSim, splitByDate, round, mean, winRate,
} from "./lib.mjs";
import { readFileSync, writeFileSync } from "node:fs";

const cache500 = JSON.parse(readFileSync(new URL("../../scratchpad/swing-validate/universe500-cache.json", import.meta.url), "utf8"));
const survivor = loadSurvivorCache();
const fund = JSON.parse(readFileSync(new URL("../../scratchpad/swing-validate/fundamentals-cache.json", import.meta.url), "utf8"));

const nameDollarVol = (h) => { const dv = h.map(b => (b.close||0)*(b.volume||0)).filter(x=>x>0).sort((a,b)=>a-b); return dv.length ? dv[Math.floor(dv.length/2)] : 0; };
const isUptrend = (r) => (r.factors.find(f => f.key === "TREND")?.buy ?? 0) >= 2;
function gated(cache, { floor = 300e6, longTh = 12 } = {}) {
  const { records } = labelUniverse(cache, { bidirectional: false, longTh });
  const dv = {}; for (const s of Object.keys(cache.histBySym)) dv[s] = nameDollarVol(cache.histBySym[s]);
  const recs = records.filter(r => isUptrend(r) && dv[r.sym] >= floor);
  for (const r of recs) r.atrPctEntry = (r.entryAtr14 > 0 && r.entryClose > 0) ? r.entryAtr14 / r.entryClose * 100 : null;
  return recs;
}
const CAP35 = { target: "none", timeStop: 63, hardStopPct: 0.35 };

function summarize(recs, spyHist, label) {
  const agg = aggregateShortRule(recs, CAP35, spyHist);
  const rets = recs.map(r => simulateShortExit(r, CAP35).pnl);
  const tail = rets.length ? round(rets.filter(x => x < -25).length / rets.length * 100) : null;
  const { IS, OOS } = splitByDate(recs);
  const p = portfolioSim(recs, CAP35, {});
  return {
    label, n: agg.n, names: new Set(recs.map(r => r.sym)).size,
    exp: round(agg.expectancy), worst: round(agg.worst), tailPct: tail,
    isExp: round(aggregateShortRule(IS, CAP35, spyHist).expectancy),
    oosExp: round(aggregateShortRule(OOS, CAP35, spyHist).expectancy),
    cagr: round(p.cagr), maxDD: round(p.maxDDpct), sortino: round(p.sortinoPerTrade, 3),
  };
}
const show = (rows) => {
  console.log("filter                    n    names   exp   worst  tail%  isExp oosExp  CAGR  maxDD  Sortino");
  for (const r of rows) console.log(
    `${r.label.padEnd(24)} ${String(r.n).padStart(4)} ${String(r.names).padStart(5)} ${String(r.exp).padStart(6)} ${String(r.worst).padStart(6)} ${String(r.tailPct).padStart(5)} ${String(r.isExp).padStart(6)} ${String(r.oosExp).padStart(6)} ${String(r.cagr).padStart(5)} ${String(r.maxDD).padStart(6)} ${String(r.sortino).padStart(7)}`
  );
};

const out = { generated: "phase2-entry-filters" };

// ---------- Earnings gate (survivors only) ----------
const earningsBySym = {};
for (const s of Object.keys(fund)) earningsBySym[s] = (fund[s].earnings || []).map(e => e.date).filter(Boolean).sort();
function nextEarnings(rows, D) { for (const d of rows) if (d > D) return d; return null; }
function blockedByEarnings(sym, D, N) {
  const nxt = nextEarnings(earningsBySym[sym] || [], D);
  if (!nxt) return false;  // na → do NOT block
  const days = Math.round((Date.parse(nxt) - Date.parse(D)) / 86400000);
  return days > 0 && days <= N;
}
const sRecs = gated(survivor);
console.log(`\n═══ EARNINGS-AVOIDANCE GATE · survivor-90 gated · base hold63_cap35 (n=${sRecs.length}) ═══`);
const eRows = [summarize(sRecs, survivor.spyHist, "no gate (base)")];
for (const N of [5, 7, 10]) {
  const kept = sRecs.filter(r => !blockedByEarnings(r.sym, r.entryDate, N));
  eRows.push(summarize(kept, survivor.spyHist, `earnings-gate N=${N}d`));
}
show(eRows);
// HON check: was the −47% HON entry (2026-06-25) blocked by any N?
const honEntries = sRecs.filter(r => r.sym === "HON").map(r => ({ entry: r.entryDate, next: nextEarnings(earningsBySym.HON || [], r.entryDate), blocked7: blockedByEarnings("HON", r.entryDate, 7), blocked10: blockedByEarnings("HON", r.entryDate, 10) }));
console.log("HON entries & earnings proximity:", JSON.stringify(honEntries));
out.earnings = { rows: eRows, honEntries };

// ---------- ATR% ceiling, dist-200 ceiling, liquidity, entry-bar (universe-488) ----------
function distAbove200(cache, sym, entryDate, entryClose) {
  const h = cache.histBySym[sym]; if (!h) return null;
  const idx = h.findIndex(b => b.date === entryDate);
  if (idx < 0 || idx + 200 > h.length) return null;
  let s = 0; for (let k = idx; k < idx + 200; k++) s += h[k].close;
  return (entryClose - s / 200) / (s / 200) * 100;
}
const uRecs = gated(cache500);
for (const r of uRecs) r.dist200 = distAbove200(cache500, r.sym, r.entryDate, r.entryClose);

console.log(`\n═══ ATR% CEILING · universe-488 gated · base hold63_cap35 (n=${uRecs.length}) ═══`);
const aRows = [summarize(uRecs, cache500.spyHist, "no ceiling (base)")];
for (const c of [8, 7, 6]) aRows.push(summarize(uRecs.filter(r => r.atrPctEntry != null && r.atrPctEntry <= c), cache500.spyHist, `ATR% ≤ ${c}`));
show(aRows);
out.atrCeiling = aRows;

console.log(`\n═══ DISTANCE-ABOVE-200DMA CEILING · universe-488 gated ═══`);
const dRows = [summarize(uRecs, cache500.spyHist, "no ceiling (base)")];
for (const c of [40, 25, 15]) dRows.push(summarize(uRecs.filter(r => r.dist200 != null && r.dist200 <= c), cache500.spyHist, `dist200 ≤ ${c}%`));
show(dRows);
out.dist200Ceiling = dRows;

console.log(`\n═══ LIQUIDITY FLOOR · universe-488 · base hold63_cap35 ═══`);
const lRows = [];
for (const floor of [300e6, 500e6, 1000e6]) lRows.push(summarize(gated(cache500, { floor }), cache500.spyHist, `≥ $${floor/1e6}M/day`));
show(lRows);
out.liquidity = lRows;

console.log(`\n═══ ENTRY-BAR SWEEP · universe-488 · base hold63_cap35 (plateau check) ═══`);
const bRows = [];
for (const th of [10, 11, 12, 13, 14, 15, 16]) bRows.push(summarize(gated(cache500, { longTh: th }), cache500.spyHist, `longTh=${th}`));
show(bRows);
out.entryBar = bRows;

writeFileSync(new URL("../../scratchpad/swing-validate/calib-entry-filters.json", import.meta.url), JSON.stringify(out, null, 2));
console.log("\n→ wrote scratchpad/swing-validate/calib-entry-filters.json");
