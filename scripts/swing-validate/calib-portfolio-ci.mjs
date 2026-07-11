/* Name-clustered bootstrap CIs on the portfolio metrics for the real shipping
   candidates. The single-path CAGR/maxDD/Sortino are too fragile to choose on; these
   90%-CIs show whether the differences survive resampling the name universe.
   Candidates: incumbent (maCross_atr40) · hold63 · hold63_cap35 (loose) · hold63_cap20
   (tight) — each under equal-$ and vol-inverse sizing. Run: node scripts/swing-validate/calib-portfolio-ci.mjs */
import {
  loadSurvivorCache, labelUniverse, portfolioSim, bootstrapPortfolio, aggregateShortRule,
  simulateShortExit, splitByDate, round,
} from "./lib.mjs";
import { readFileSync, writeFileSync } from "node:fs";

const cache500 = JSON.parse(readFileSync(new URL("../../scratchpad/swing-validate/universe500-cache.json", import.meta.url), "utf8"));
const survivor = loadSurvivorCache();
const nameDollarVol = (h) => { const dv = h.map(b => (b.close||0)*(b.volume||0)).filter(x=>x>0).sort((a,b)=>a-b); return dv.length ? dv[Math.floor(dv.length/2)] : 0; };
const isUptrend = (r) => (r.factors.find(f => f.key === "TREND")?.buy ?? 0) >= 2;
function gated(cache, floor = 300e6) {
  const { records } = labelUniverse(cache, { bidirectional: false });
  const dv = {}; for (const s of Object.keys(cache.histBySym)) dv[s] = nameDollarVol(cache.histBySym[s]);
  return records.filter(r => isUptrend(r) && dv[r.sym] >= floor);
}

const CANDS = [
  { key: "incumbent(maCross_atr40)", rule: { target: "maCross", timeStop: 63, initStopAtr: 4.0 } },
  { key: "hold63",                   rule: { target: "none",    timeStop: 63 } },
  { key: "hold63_cap35",             rule: { target: "none",    timeStop: 63, hardStopPct: 0.35 } },
  { key: "hold63_cap20",             rule: { target: "none",    timeStop: 63, hardStopPct: 0.20 } },
  { key: "maCross(no ATR)",          rule: { target: "maCross", timeStop: 63 } },
];

const out = { generated: "phase1-portfolio-ci", universes: {} };
for (const [label, cache] of [["survivor-90", survivor], ["universe-488", cache500]]) {
  const recs = gated(cache);
  console.log(`\n════ ${label} · gated · n=${recs.length} · ${new Set(recs.map(r=>r.sym)).size} names ════`);
  console.log("candidate                     sizing       exp   worst   CAGR[lo–med–hi]        maxDD[lo–med–hi]       Sortino[med]");
  out.universes[label] = [];
  for (const c of CANDS) {
    const agg = aggregateShortRule(recs, c.rule, cache.spyHist);
    for (const sizing of ["equal", "volInverse"]) {
      const boot = bootstrapPortfolio(recs, c.rule, { sizing }, { iters: 400 });
      const single = portfolioSim(recs, c.rule, { sizing });
      const row = {
        candidate: c.key, sizing, exp: round(agg.expectancy), worst: round(agg.worst),
        cagr: boot.cagr, maxDD: boot.maxDD, sortino: boot.sortino,
        singleCagr: round(single.cagr), singleMaxDD: round(single.maxDDpct), taken: single.taken,
      };
      out.universes[label].push(row);
      const f = (o) => `${round(o.lo)}–${round(o.median)}–${round(o.hi)}`;
      console.log(
        `${c.key.padEnd(28)}  ${sizing.padEnd(10)} ${String(round(agg.expectancy)).padStart(5)} ${String(round(agg.worst)).padStart(6)}   ${f(boot.cagr).padStart(20)}  ${f(boot.maxDD).padStart(20)}  ${String(round(boot.sortino.median,3)).padStart(6)}`
      );
    }
  }
}
writeFileSync(new URL("../../scratchpad/swing-validate/calib-portfolio-ci.json", import.meta.url), JSON.stringify(out, null, 2));
console.log("\n→ wrote scratchpad/swing-validate/calib-portfolio-ci.json");
