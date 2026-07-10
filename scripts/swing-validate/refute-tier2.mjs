import {
  labelUniverse, aggregateShortRule, swingExitGrid, mean, round,
} from "./lib.mjs";
import { readFileSync } from "node:fs";

const cache = JSON.parse(readFileSync(new URL("../../scratchpad/swing-validate/universe500-cache.json", import.meta.url), "utf8"));
const hold63 = swingExitGrid().find(r => r.label === "hold63");

// recent-60-bar median $/day (matches the claim's name counts)
function dv60(hist){const dv=hist.slice(0,60).map(b=>(b.close||0)*(b.volume||0)).filter(x=>x>0);dv.sort((a,b)=>a-b);return dv.length?dv[Math.floor(dv.length/2)]:0;}

// SPY 63d fwd return keyed by date (newest-first hist)
const spy = cache.spyHist;
const spyIdx = {}; spy.forEach((b,i)=>spyIdx[b.date]=i);
function spyFwd63(date){const i=spyIdx[date]; if(i==null) return null; const j=i-63; if(j<0) return null; return (spy[j].close-spy[i].close)/spy[i].close*100;}

// UNCONDITIONAL: for each name, average stock 63d fwd return and stock-minus-SPY edge over ALL bars
function unconditional(hist){
  const rets=[], edges=[];
  for(let i=63;i<hist.length;i++){ // i is older bar; i-63 newer = 63 sessions later
    const j=i-63; const e=hist[i].close, x=hist[j].close;
    if(!(e>0)||!(x>0)) continue;
    const r=(x-e)/e*100; rets.push(r);
    const s=spyFwd63(hist[i].date); if(s!=null) edges.push(r-s);
  }
  return { meanRet: rets.length?mean(rets):null, meanEdge: edges.length?mean(edges):null, n: edges.length };
}

const { records } = labelUniverse(cache, { bidirectional:false });
const dvBySym={}; for(const s of Object.keys(cache.histBySym)) dvBySym[s]=dv60(cache.histBySym[s]);

console.log("TIMING-vs-BETA test: signal-conditional hold63 edge  vs  UNCONDITIONAL buy-&-hold-anytime edge (same names)\n");
console.log("tier        #names  sigEntries  sigEdge   uncondEdge   sigStkRet  uncondStkRet   timingDelta");
for(const th of [0,100e6,300e6,500e6,1000e6]){
  const recs=records.filter(r=>dvBySym[r.sym]>=th);
  const names=[...new Set(recs.map(r=>r.sym))];
  if(!recs.length) continue;
  const agg=aggregateShortRule(recs,hold63,cache.spyHist);
  // unconditional over the SAME set of names, entry-weighted to match signal mix
  // weight each name by its signal-entry count so the comparison isn't dominated by low-signal names
  let wRet=0,wEdge=0,wN=0;
  const cntBySym={}; for(const r of recs) cntBySym[r.sym]=(cntBySym[r.sym]||0)+1;
  for(const nm of names){ const u=unconditional(cache.histBySym[nm]); if(u.meanEdge==null) continue; const w=cntBySym[nm]; wRet+=u.meanRet*w; wEdge+=u.meanEdge*w; wN+=w; }
  const uEdge=wEdge/wN, uRet=wRet/wN;
  console.log(`>=$${(th/1e6).toString().padStart(5)}M ${String(names.length).padStart(6)} ${String(recs.length).padStart(10)}   ${String(round(agg.edge)).padStart(6)}     ${String(round(uEdge)).padStart(6)}     ${String(round(agg.expectancy)).padStart(6)}      ${String(round(uRet)).padStart(6)}       ${round(agg.edge-uEdge)}`);
}
