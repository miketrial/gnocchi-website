/* Diagnose the residual worst trades: is the −47.88 that survives every cap a genuine
   overnight GAP-through (fills at bar.open below the cap line — unstoppable), or a bug?
   Also widen the cap sweep to loose levels {25,30,35%} — a 63-day swing hold normally
   draws down 15-20% and recovers, so a tight cap may bite normal trades; a loose cap
   that only catches true blowups may keep the portfolio path intact. */
import {
  loadSurvivorCache, labelUniverse, aggregateShortRule, simulateShortExit,
  splitByDate, portfolioSim, round,
} from "./lib.mjs";
import { readFileSync } from "node:fs";

const cache500 = JSON.parse(readFileSync(new URL("../../scratchpad/swing-validate/universe500-cache.json", import.meta.url), "utf8"));
const survivor = loadSurvivorCache();
const nameDollarVol = (h) => { const dv = h.map(b => (b.close||0)*(b.volume||0)).filter(x=>x>0).sort((a,b)=>a-b); return dv.length ? dv[Math.floor(dv.length/2)] : 0; };
const isUptrend = (r) => (r.factors.find(f => f.key === "TREND")?.buy ?? 0) >= 2;
function gated(cache, floor = 300e6) {
  const { records } = labelUniverse(cache, { bidirectional: false });
  const dv = {}; for (const s of Object.keys(cache.histBySym)) dv[s] = nameDollarVol(cache.histBySym[s]);
  return records.filter(r => isUptrend(r) && dv[r.sym] >= floor);
}

// classify a trade's exit under a rule: was the STOP fill a gap-through-open?
function classify(rec, rule) {
  const r = simulateShortExit(rec, rule);
  if (r.reason !== "STOP" && r.reason !== "TRAIL") return { ...r, kind: r.reason };
  const bar = rec.fwd[r.hold - 1];
  const capLine = rule.hardStopPct ? rec.entryClose * (1 - rule.hardStopPct) : null;
  // gap-through: the bar OPENED at/below the stop line → filled at the (worse) open
  const gap = capLine != null && bar.open > 0 && bar.open <= capLine;
  const gapPct = bar.open > 0 ? round((bar.open - rec.entryClose) / rec.entryClose * 100) : null;
  return { ...r, kind: gap ? "GAP-THRU" : "intrabar", sym: rec.sym, entryDate: rec.entryDate, exitDate: bar.date, openPct: gapPct };
}

const recs = gated(cache500);
const HOLD_CAP15 = { target: "none", timeStop: 63, hardStopPct: 0.15 };
console.log("=== universe-488 gated · hold63_cap15 · worst 8 trades ===");
const diag = recs.map(r => classify(r, HOLD_CAP15)).sort((a, b) => a.pnl - b.pnl).slice(0, 8);
for (const d of diag) console.log(`  ${round(d.pnl).toString().padStart(7)}%  ${d.kind.padEnd(9)} ${(d.sym||"").padEnd(6)} entry ${d.entryDate} → ${d.exitDate}  open-gap ${d.openPct}%  (day ${d.hold}, ${d.reason})`);

// Wider cap sweep on hold63 and the incumbent — where does the portfolio path survive?
const nameSet = (arr) => new Set(arr.map(r => r.sym)).size;
console.log(`\n=== universe-488 gated (n=${recs.length}, names ${nameSet(recs)}) · WIDE cap sweep ===`);
console.log("rule            cap    exp   worst  tail25  tail35   CAGR  Sortino  maxDD  taken");
for (const [label, base] of [["hold63", { target: "none", timeStop: 63 }], ["maCross_atr40", { target: "maCross", timeStop: 63, initStopAtr: 4.0 }]]) {
  for (const cap of [0, 15, 20, 25, 30, 35]) {
    const rule = cap ? { ...base, hardStopPct: cap / 100 } : base;
    const agg = aggregateShortRule(recs, rule, cache500.spyHist);
    const rets = recs.map(r => simulateShortExit(r, rule).pnl);
    const t25 = round(rets.filter(x => x < -25).length / rets.length * 100);
    const t35 = round(rets.filter(x => x < -35).length / rets.length * 100);
    const p = portfolioSim(recs, rule, {});
    const pad = (s, n) => String(s).padStart(n);
    console.log(`${label.padEnd(15)} ${pad(cap,3)}  ${pad(round(agg.expectancy),6)} ${pad(round(agg.worst),6)} ${pad(t25,6)}  ${pad(t35,6)}  ${pad(round(p.cagr),5)}  ${pad(round(p.sortinoPerTrade,3),6)} ${pad(round(p.maxDDpct),6)}  ${pad(p.taken,4)}`);
  }
  console.log("");
}
