/* ===== "Figure out the prior" — does the swing calibration need to be
   SECTOR-BY-SECTOR, or is one universal config right? Also quantifies the tail
   (gap-through-stop) risk the HON -47% trade exposed. Off the 488-name cache
   (has per-name sector in .meta). Deterministic. */
import {
  labelUniverse, aggregateShortRule, shortExitGridReport, swingExitGrid,
  simulateShortExit, fwdReturnPct, mean, median, winRate, round,
} from "./lib.mjs";
import { readFileSync } from "node:fs";

const cache = JSON.parse(readFileSync(new URL("../../scratchpad/swing-validate/universe500-cache.json", import.meta.url), "utf8"));
const sectorOf = (sym) => cache.meta?.[sym]?.sector || "?";
const { records } = labelUniverse(cache, { bidirectional: false });
for (const r of records) r.sector = sectorOf(r.sym);

const INC = swingExitGrid().find(r => r.label === "maCross_atr40");
const bySector = {};
for (const r of records) (bySector[r.sector] ||= []).push(r);

// entry ATR% (volatility proxy) per record
const atrPct = (r) => (r.entryAtr14 > 0 && r.entryClose > 0) ? (r.entryAtr14 / r.entryClose) * 100 : null;

console.log(`\n=== Sector prior — incumbent rule (maCross_atr40), fwd/exit stats per sector ===`);
console.log("sector                    n     medATR%  incExp   worst   %<-25%  bestRule(exp)          bestRule_worst");
const priorRows = [];
for (const [sec, recs] of Object.entries(bySector).sort((a, b) => b[1].length - a[1].length)) {
  if (recs.length < 60) continue;
  const pnls = recs.map(r => simulateShortExit(r, INC).pnl);
  const tail = pnls.filter(p => p < -25).length / pnls.length;
  const grid = shortExitGridReport(recs, cache.spyHist);
  const best = grid[0];
  const bestByWorst = [...grid].sort((a, b) => (b.worst ?? -1e9) - (a.worst ?? -1e9))[0]; // least-bad worst trade
  const medAtr = median(recs.map(atrPct).filter(x => x != null));
  priorRows.push({ sec, n: recs.length, medAtr: round(medAtr, 2), incExp: round(mean(pnls)), worst: round(Math.min(...pnls)), tail: round(tail, 3), bestRule: best.rule, bestExp: round(best.expectancy), bestByWorstRule: bestByWorst.rule, bestByWorst: round(bestByWorst.worst) });
  console.log(`${sec.padEnd(24)} ${String(recs.length).padStart(5)}  ${String(round(medAtr,2)).padStart(6)}  ${String(round(mean(pnls))).padStart(6)}  ${String(round(Math.min(...pnls))).padStart(6)}  ${String(round(tail*100,1)).padStart(5)}  ${best.rule.padEnd(14)}(${round(best.expectancy)})   ${bestByWorst.rule}(${round(bestByWorst.worst)})`);
}

// Does the BEST exit rule actually differ by sector, or is it noise? Compare each
// sector's best rule to the universal best, and the expectancy gap.
const uniGrid = shortExitGridReport(records, cache.spyHist);
console.log(`\n── universal best rule: ${uniGrid[0].rule} (exp ${round(uniGrid[0].expectancy)}, worst ${round(uniGrid[0].worst)}) ──`);
const differing = priorRows.filter(r => r.bestRule !== uniGrid[0].rule);
console.log(`sectors whose best-by-expectancy rule ≠ universal: ${differing.length}/${priorRows.length}  [${differing.map(r => `${r.sec}:${r.bestRule}`).join(", ")}]`);

// Tail/gap analysis: how many trades gap THROUGH the stop (fill materially below it)?
let gapThrough = 0, stopFills = 0;
const bigLosers = [];
for (const r of records) {
  const res = simulateShortExit(r, INC);
  if (res.reason === "STOP") {
    stopFills++;
    const stop = r.entryAtr14 > 0 ? r.entryClose - 4 * r.entryAtr14 : null;
    if (stop && res.pnl < ((stop - r.entryClose) / r.entryClose * 100) - 5) gapThrough++; // filled >5pp below the stop line
  }
  if (res.pnl < -30) bigLosers.push({ sym: r.sym, sector: r.sector, pnl: round(res.pnl), reason: res.reason });
}
console.log(`\n── tail risk: ${gapThrough}/${stopFills} stop-exits gapped THROUGH the stop (>5pp below the line) ──`);
console.log(`trades worse than -30% (${bigLosers.length}): by sector →`, JSON.stringify(bigLosers.reduce((m, b) => { m[b.sector] = (m[b.sector] || 0) + 1; return m; }, {})));
console.log(`  worst 8:`, bigLosers.sort((a, b) => a.pnl - b.pnl).slice(0, 8).map(b => `${b.sym}(${b.sector.slice(0,4)}) ${b.pnl}% ${b.reason}`).join("  "));
