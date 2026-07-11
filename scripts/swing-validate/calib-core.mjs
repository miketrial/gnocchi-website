/* ===== Risk-first calibration — CORE measurement (hard-% stop cap × exit family) =====
   The crux of the calibration. On BOTH the 90-survivor and the broad 488-universe
   caches, with the LIVE gates re-applied (uptrend px>50>200 via TREND.buy≥2, and the
   $300M/day per-name liquidity floor), sweep a fixed-% hard stop cap across three exit
   families and report the full risk-vs-reward picture:
     reward → expectancy, IS/OOS expectancy, portfolio CAGR/Sortino
     risk   → worst single trade, tail% (<−25%), portfolio maxDD
   Selection is on plateau + OOS + portfolio-maxDD, never per-trade worst alone.
   Deterministic off-cache reconstruction; writes scratchpad/swing-validate/calib-core.json.
   Run: node scripts/swing-validate/calib-core.mjs */
import {
  loadSurvivorCache, labelUniverse, aggregateShortRule, simulateShortExit,
  swingExitGrid, splitByDate, portfolioSim, round, mean, winRate,
} from "./lib.mjs";
import { readFileSync, writeFileSync } from "node:fs";

const U500 = new URL("../../scratchpad/swing-validate/universe500-cache.json", import.meta.url);
const cache500 = JSON.parse(readFileSync(U500, "utf8"));
const survivor = loadSurvivorCache();

// Per-name median daily $-volume over FULL history (the established Phase-2 method,
// refute-tier.mjs) — used to re-apply the live $300M floor the study omits ($10M).
const nameDollarVol = (hist) => {
  const dv = hist.map(b => (b.close || 0) * (b.volume || 0)).filter(x => x > 0).sort((a, b) => a - b);
  return dv.length ? dv[Math.floor(dv.length / 2)] : 0;
};
const isUptrend = (r) => (r.factors.find(f => f.key === "TREND")?.buy ?? 0) >= 2; // px>50>200, live entryStrong

// Live-gated record set: uptrend + $-vol floor (default $300M).
function gated(cache, floor = 300e6) {
  const { records } = labelUniverse(cache, { bidirectional: false });
  const dvBySym = {};
  for (const sym of Object.keys(cache.histBySym)) dvBySym[sym] = nameDollarVol(cache.histBySym[sym]);
  return records.filter(r => isUptrend(r) && dvBySym[r.sym] >= floor);
}

// Exit families to test the cap against.
const G = (l) => swingExitGrid().find(r => r.label === l);
const FAMILIES = [
  { key: "maCross_atr40", base: { target: "maCross", timeStop: 63, initStopAtr: 4.0 } }, // the shipped incumbent
  { key: "maCross",       base: { target: "maCross", timeStop: 63 } },                    // death-cross, no ATR stop
  { key: "hold63",        base: { target: "none",    timeStop: 63 } },                    // plain 63-day hold
];
const CAPS = [null, 0.12, 0.15, 0.18, 0.20];
const withCap = (base, cap) => cap ? { ...base, hardStopPct: cap } : { ...base };

function rowFor(recs, spyHist, fam, cap, universe) {
  const rule = withCap(fam.base, cap);
  const agg = aggregateShortRule(recs, rule, spyHist);
  const rets = recs.map(r => simulateShortExit(r, rule).pnl);
  const tail = rets.length ? rets.filter(x => x < -25).length / rets.length * 100 : null;
  const { IS, OOS } = splitByDate(recs);
  const isE = aggregateShortRule(IS, rule, spyHist).expectancy;
  const oosE = aggregateShortRule(OOS, rule, spyHist).expectancy;
  const p = portfolioSim(recs, rule, {}); // maxPositions 8, perSectorMax 3, 10bps
  return {
    universe, family: fam.key, cap: cap ? cap * 100 : 0, n: agg.n,
    exp: round(agg.expectancy), worst: round(agg.worst), tailPct: round(tail),
    win: round(agg.winRate, 3), pf: round(agg.profitFactor),
    isExp: round(isE), oosExp: round(oosE),
    cagr: round(p.cagr), sortino: round(p.sortinoPerTrade, 3), maxDD: round(p.maxDDpct), taken: p.taken,
  };
}

const universes = [
  { label: "survivor-90", recs: gated(survivor), spy: survivor.spyHist },
  { label: "universe-488", recs: gated(cache500), spy: cache500.spyHist },
];

const rows = [];
for (const u of universes) for (const fam of FAMILIES) for (const cap of CAPS) {
  rows.push(rowFor(u.recs, u.spy, fam, cap, u.label));
}

// ---- console report ----
const pad = (s, n) => String(s).padStart(n);
for (const u of universes) {
  console.log(`\n=== ${u.label} · gated (uptrend + $300M/day) · n=${u.recs.length} entries ===`);
  console.log("family          cap    n    exp   worst  tail%   win    pf   isExp  oosExp   CAGR  Sortino  maxDD  taken");
  for (const fam of FAMILIES) {
    for (const cap of CAPS) {
      const r = rows.find(x => x.universe === u.label && x.family === fam.key && x.cap === (cap ? cap * 100 : 0));
      console.log(
        `${fam.key.padEnd(15)} ${pad(r.cap, 3)}  ${pad(r.n, 4)} ${pad(r.exp, 6)} ${pad(r.worst, 6)} ${pad(r.tailPct, 5)}  ${pad(r.win, 5)} ${pad(r.pf, 5)} ${pad(r.isExp, 6)} ${pad(r.oosExp, 6)}  ${pad(r.cagr, 5)}  ${pad(r.sortino, 6)} ${pad(r.maxDD, 6)}  ${pad(r.taken, 4)}`
      );
    }
    console.log("");
  }
}

writeFileSync(new URL("../../scratchpad/swing-validate/calib-core.json", import.meta.url),
  JSON.stringify({ generated: "phase1-core", gates: "uptrend+300M", caps: CAPS, families: FAMILIES.map(f => f.key), rows }, null, 2));
console.log("→ wrote scratchpad/swing-validate/calib-core.json");
