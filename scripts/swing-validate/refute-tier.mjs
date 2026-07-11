import {
  loadSurvivorCache, labelUniverse, aggregateShortRule, swingExitGrid,
  fwdReturnPct, mean, winRate, round, median,
} from "./lib.mjs";
import { readFileSync } from "node:fs";

const U500 = new URL("../../scratchpad/swing-validate/universe500-cache.json", import.meta.url);
const cache500 = JSON.parse(readFileSync(U500, "utf8"));
const survivor = loadSurvivorCache();
const hold63 = swingExitGrid().find(r => r.label === "hold63");

// per-name median daily dollar volume, FULL history
function nameDollarVol(hist) {
  const dv = hist.map(b => (b.close || 0) * (b.volume || 0)).filter(x => x > 0);
  dv.sort((a, b) => a - b);
  return dv.length ? dv[Math.floor(dv.length / 2)] : 0;
}
// also a recent-60-bar version (what ineligible() uses)
function nameDollarVol60(hist) {
  const dv = hist.slice(0, 60).map(b => (b.close || 0) * (b.volume || 0)).filter(x => x > 0);
  dv.sort((a, b) => a - b);
  return dv.length ? dv[Math.floor(dv.length / 2)] : 0;
}

function tierReport(cache, dvFn, label) {
  const { records } = labelUniverse(cache, { bidirectional: false });
  // stamp each record with its name's median dollar vol
  const dvBySym = {};
  for (const sym of Object.keys(cache.histBySym)) dvBySym[sym] = dvFn(cache.histBySym[sym]);
  const eligibleSyms = new Set(records.map(r => r.sym)); // names that actually produced entries
  const nameDV = [...eligibleSyms].map(s => dvBySym[s]).sort((a, b) => a - b);

  const thresholds = [0, 50e6, 100e6, 200e6, 300e6, 500e6, 1000e6];
  console.log(`\n=== ${label} : hold63 edge vs SPY by liquidity floor (per-name median $/day, FULL hist) ===`);
  console.log(`eligible names producing entries: ${eligibleSyms.size}, total entries ${records.length}`);
  console.log(`floor       #names  #entries   hold63Exp   avgSPY    edge     rawFwd21   win`);
  for (const th of thresholds) {
    const recs = records.filter(r => dvBySym[r.sym] >= th);
    const names = new Set(recs.map(r => r.sym)).size;
    if (!recs.length) continue;
    const agg = aggregateShortRule(recs, hold63, cache.spyHist);
    const raw = recs.map(r => fwdReturnPct(r, 21)).filter(x => x != null);
    console.log(
      `>=$${(th/1e6).toString().padStart(5)}M ${String(names).padStart(6)} ${String(recs.length).padStart(9)}   ${String(round(agg.expectancy)).padStart(7)}   ${String(round(agg.avgSpy)).padStart(6)}  ${String(round(agg.edge)).padStart(6)}   ${String(round(mean(raw))).padStart(7)}   ${round(winRate(raw),3)}`
    );
  }
  return { records, dvBySym };
}

tierReport(cache500, nameDollarVol, "BROAD-488 (full-hist median DV)");

// recent-60 version to check sensitivity of name counts
(function(){
  const { records } = labelUniverse(cache500, { bidirectional: false });
  const dvBySym = {};
  for (const sym of Object.keys(cache500.histBySym)) dvBySym[sym] = nameDollarVol60(cache500.histBySym[sym]);
  const eligibleSyms = new Set(records.map(r => r.sym));
  console.log(`\n=== BROAD-488 : hold63 edge by liquidity floor (recent-60-bar median $/day) ===`);
  console.log(`floor       #names  #entries   hold63Exp   avgSPY    edge`);
  for (const th of [0,100e6,200e6,300e6,500e6]) {
    const recs = records.filter(r => dvBySym[r.sym] >= th);
    const names = new Set(recs.map(r => r.sym)).size;
    if(!recs.length) continue;
    const agg = aggregateShortRule(recs, hold63, cache500.spyHist);
    console.log(`>=$${(th/1e6).toString().padStart(5)}M ${String(names).padStart(6)} ${String(recs.length).padStart(9)}   ${String(round(agg.expectancy)).padStart(7)}   ${String(round(agg.avgSpy)).padStart(6)}  ${String(round(agg.edge)).padStart(6)}`);
  }
})();

// survivor headline for reference
const sAgg = aggregateShortRule(labelUniverse(survivor,{bidirectional:false}).records, hold63, survivor.spyHist);
console.log(`\nSURVIVOR-90 hold63: exp ${round(sAgg.expectancy)} avgSpy ${round(sAgg.avgSpy)} edge ${round(sAgg.edge)} n ${sAgg.n}`);
