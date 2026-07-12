/* DEEP entry-timing study: score the swing entry across 2006-2026 (2008 GFC, 2011,
   2015-16, 2018-Q4, 2020-COVID, 2022) and find the metric combination that decides
   WHEN to buy with edge that survives OUT-OF-SAMPLE and OUT-OF-REGIME (real bears).

   Design (anti-overfit):
   - Entry base = fresh transition into techScore>=12 & uptrend (px>50>200). The hard
     $-volume floor is DECOUPLED from the gate and swept as a metric (user: "decrease
     volume threshold if needed"). All other metrics recorded at the entry bar.
   - Exit fixed = 40% catastrophe stop + 126-session (6mo) TIME cap, long-only — so
     only the ENTRY decision varies.
   - Splits: IS = entryDate<2017-01-01, OOS = >=2017. Each half contains real bears.
   - Regime = SPY vs its 200DMA at entry; crisis-window tags for the named bears.
   - Acceptance for a rule: positive edge vs SPY in OOS AND in bear-regime entries,
     not just in-sample. Raw return alone just buys beta; we also report beta-adjusted.

   Metrics per entry (all point-in-time): techScore(12-18), the 6 factor points,
   avgDollarVol, trailing 120d beta, ATR%, off-52w-high, VIX level. */
import { readFileSync, writeFileSync } from "node:fs";
import { computeShortSignal, strengthSeriesFor } from "../../netlify/lib/short-backtest.mjs";
import { shortDetailAt } from "../../netlify/lib/short-study.mjs";
import { atrFrom } from "../../netlify/lib/ta-helpers.mjs";

const CACHE = new URL("../../scratchpad/swing-validate/deep-cache.json", import.meta.url);
const HARD_STOP_PCT = 0.40, H = 126, BETA_LB = 120, OOS_CUT = "2017-01-01";
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const r2 = x => (x == null ? null : Math.round(x * 100) / 100);
const strengthAsOf = (s, d) => { for (const x of s) if (x.date <= d) return x.strength; return null; };

console.error("loading deep cache…");
const c = JSON.parse(readFileSync(CACHE, "utf8"));
const { spyHist, vixHist, etfBySym, etfHistBySym, histBySym } = c;
const spyStr = strengthSeriesFor(spyHist);
const etfStr = {}; for (const [e, h] of Object.entries(etfHistBySym || {})) etfStr[e] = strengthSeriesFor(h);
// SPY maps
const spyClose = {}, spyLR = {};
for (const b of spyHist) spyClose[b.date] = b.close;
for (let i = 0; i < spyHist.length - 1; i++) { const a = spyHist[i].close, b = spyHist[i + 1].close; if (a > 0 && b > 0) spyLR[spyHist[i].date] = Math.log(a / b); }
const spyAsc = [...spyHist].reverse(); const sma200 = {};
for (let i = 199; i < spyAsc.length; i++) { let s = 0; for (let k = i - 199; k <= i; k++) s += spyAsc[k].close; sma200[spyAsc[i].date] = s / 200; }
const spyDates = spyHist.map(b => b.date);
const asOf = (map, d) => { for (const dd of spyDates) if (dd <= d) return map[dd]; return null; };
const vixAt = {}; for (const b of (vixHist || [])) vixAt[b.date] = b.close;
const vixDates = (vixHist || []).map(b => b.date);
const vixAsOf = d => { for (const dd of vixDates) if (dd <= d) return vixAt[dd]; return null; };
const spyCloseAsOf = d => asOf(spyClose, d);
const spyRet = (e, x) => { const a = spyCloseAsOf(e), b = spyCloseAsOf(x); return (a > 0 && b > 0) ? ((b - a) / a) * 100 : null; };

const CRISES = [
  ["GFC", "2007-10-01", "2009-06-30"], ["euro11", "2011-07-01", "2011-12-31"],
  ["sino16", "2015-08-01", "2016-02-29"], ["q4-18", "2018-10-01", "2018-12-31"],
  ["covid", "2020-02-15", "2020-04-30"], ["bear22", "2022-01-01", "2022-10-31"],
];
const crisisOf = d => { for (const [nm, a, b] of CRISES) if (d >= a && d <= b) return nm; return null; };

function simFwd(hist, i) {
  const entry = hist[i].close, stop = entry * (1 - HARD_STOP_PCT); let day = 0;
  for (let j = i - 1; j >= 0; j--) { const bar = hist[j]; day++; const low = bar.low > 0 ? bar.low : bar.close;
    if (low <= stop) { const fill = (bar.open > 0 && bar.open <= stop) ? bar.open : stop; return { pnl: ((fill - entry) / entry) * 100, exitDate: bar.date }; }
    if (day >= H) return { pnl: ((bar.close - entry) / entry) * 100, exitDate: bar.date }; }
  const l = hist[0]; return { pnl: ((l.close - entry) / entry) * 100, exitDate: l.date };
}

const E = [];  // entries
let done = 0;
for (const sym of Object.keys(histBySym)) {
  const hist = histBySym[sym] || []; if (hist.length < 210) { done++; continue; }
  const secStr = etfBySym?.[sym] ? (etfStr[etfBySym[sym]] || []) : [];
  const len = hist.length, last = len - 200;
  const setup = new Array(len).fill(false), sc = new Array(len).fill(0);
  for (let i = 0; i <= last; i++) {
    const sig = computeShortSignal(hist.slice(i, i + 280), { spyStrength: strengthAsOf(spyStr, hist[i].date), sectorStrength: strengthAsOf(secStr, hist[i].date) });
    if (sig) { sc[i] = sig.techScore; setup[i] = sig.techScore >= 12 && sig.uptrend; }
  }
  for (let i = 0; i <= last; i++) {
    if (!setup[i] || (i + 1 <= last && setup[i + 1]) || !(hist[i].close > 0)) continue;
    const d = hist[i].date, win = hist.slice(i, i + 280);
    const det = shortDetailAt(win, strengthAsOf(spyStr, d), strengthAsOf(secStr, d));
    const f = {}; for (const ff of (det?.factors || [])) f[ff.key] = ff.buy;
    const dv = hist.slice(i, i + 20).map(b => (b.close || 0) * (b.volume || 0)).filter(x => x > 0);
    const avgDV = dv.length ? dv.reduce((s, x) => s + x, 0) / dv.length : 0;
    const closes = win.map(b => b.close), hi = Math.max(...closes.slice(0, 260)), offHigh = (hi - hist[i].close) / hi;
    const atr = atrFrom(win, 0, 14), atrPct = atr > 0 && hist[i].close > 0 ? atr / hist[i].close : null;
    let sxy = 0, sxx = 0, nb = 0;
    for (let k = i; k < i + BETA_LB && k < len - 1; k++) { const a = hist[k].close, b = hist[k + 1].close, sr = spyLR[hist[k].date]; if (a > 0 && b > 0 && sr != null) { const nr = Math.log(a / b); sxy += nr * sr; sxx += sr * sr; nb++; } }
    const beta = (nb > 30 && sxx > 0) ? sxy / sxx : null;
    const r = simFwd(hist, i); const s = spyRet(d, r.exitDate); if (s == null) continue;
    const px = asOf(spyClose, d), sm = asOf(sma200, d);
    E.push({ sym, d, ts: sc[i], TREND: f.TREND ?? 0, MOM: f.MOM ?? 0, EXT: f.EXTREME ?? 0, VOL: f.VOL ?? 0, SECRS: f.SECRS ?? 0,
      dv: avgDV, beta, atrPct, offHigh, vix: vixAsOf(d),
      pnl: r.pnl, edge: r.pnl - s, betaEdge: beta != null ? r.pnl - beta * s : null,
      regime: (px != null && sm != null) ? (px >= sm ? "bull" : "bear") : "na",
      crisis: crisisOf(d), oos: d >= OOS_CUT });
  }
  if (++done % 100 === 0) console.error(`  ${done} names, ${E.length} entries`);
}
console.error(`TOTAL entries 2006-2026: ${E.length}`);

const g = (arr) => ({ n: arr.length, edge: r2(mean(arr.map(x => x.edge))), be: r2(mean(arr.map(x => x.betaEdge).filter(v => v != null))), pnl: r2(mean(arr.map(x => x.pnl))), win: r2(100 * arr.filter(x => x.edge > 0).length / (arr.length || 1)), worst: arr.length ? r2(Math.min(...arr.map(x => x.pnl))) : null });
const IS = E.filter(e => !e.oos), OOS = E.filter(e => e.oos), BEAR = E.filter(e => e.regime === "bear");

console.log("\n===== 1. Where do the entries fall? =====");
console.log("total", E.length, " IS(<2017)", IS.length, " OOS(>=2017)", OOS.length, " bull", E.filter(e=>e.regime==="bull").length, " bear", BEAR.length);
console.log("by crisis window:", CRISES.map(([nm]) => `${nm}:${E.filter(e => e.crisis === nm).length}`).join("  "));

console.log("\n===== 2. Univariate: techScore tier =====");
console.log("tier\tn\tedge\tbetaAdj\tIS_edge\tOOS_edge\tBEAR_edge\tBEAR_pnl\tworst");
for (const t of [12, 13, 14, 15, 16]) {
  const s = E.filter(e => e.ts >= t);
  console.log([`ts>=${t}`, s.length, g(s).edge, g(s).be, g(s.filter(e => !e.oos)).edge, g(s.filter(e => e.oos)).edge, g(s.filter(e => e.regime === "bear")).edge, g(s.filter(e => e.regime === "bear")).pnl, g(s).worst].join("\t"));
}

console.log("\n===== 3. Liquidity floor sweep (decouple / decrease the $-vol threshold) =====");
console.log("floor\tn\tedge\tbetaAdj\tOOS_edge\tBEAR_edge\tworst");
for (const [lbl, fl] of [["$25M", 25e6], ["$50M", 50e6], ["$100M", 100e6], ["$300M", 300e6], ["$1B", 1e9], ["$3B", 3e9]]) {
  const s = E.filter(e => e.dv >= fl);
  console.log([lbl, s.length, g(s).edge, g(s).be, g(s.filter(e => e.oos)).edge, g(s.filter(e => e.regime === "bear")).edge, g(s).worst].join("\t"));
}

console.log("\n===== 4. Univariate: other factors & beta =====");
const uni = [
  ["MOM=3", e => e.MOM === 3], ["TREND=3", e => e.TREND === 3], ["SECRS>=2", e => e.SECRS >= 2], ["SECRS=3", e => e.SECRS === 3],
  ["EXT=3", e => e.EXT === 3], ["VOL>=2", e => e.VOL >= 2],
  ["beta<1.0", e => e.beta != null && e.beta < 1.0], ["beta 1.0-1.5", e => e.beta != null && e.beta >= 1.0 && e.beta < 1.5], ["beta>=1.5", e => e.beta != null && e.beta >= 1.5],
  ["VIX<20", e => e.vix != null && e.vix < 20], ["VIX>=30", e => e.vix != null && e.vix >= 30],
];
console.log("filter\tn\tedge\tbetaAdj\tOOS_edge\tBEAR_edge\tworst");
for (const [lbl, fn] of uni) { const s = E.filter(fn); console.log([lbl, s.length, g(s).edge, g(s).be, g(s.filter(e => e.oos)).edge, g(s.filter(e => e.regime === "bear")).edge, g(s).worst].join("\t")); }

console.log("\n===== 5. Combo search — ranked by min(OOS_edge, BEAR_edge) robustness =====");
const combos = [
  ["baseline ts>=12", e => true],
  ["ts>=15", e => e.ts >= 15],
  ["ts>=15 & $1B", e => e.ts >= 15 && e.dv >= 1e9],
  ["ts>=15 & $3B", e => e.ts >= 15 && e.dv >= 3e9],
  ["ts>=15 & SECRS>=2", e => e.ts >= 15 && e.SECRS >= 2],
  ["ts>=15 & MOM=3", e => e.ts >= 15 && e.MOM === 3],
  ["ts>=15 & beta<1.5", e => e.ts >= 15 && e.beta != null && e.beta < 1.5],
  ["ts>=14 & SECRS>=2 & MOM>=2", e => e.ts >= 14 && e.SECRS >= 2 && e.MOM >= 2],
  ["ts>=14 & $1B & SECRS>=2", e => e.ts >= 14 && e.dv >= 1e9 && e.SECRS >= 2],
  ["ts>=15 & $1B & SECRS>=2", e => e.ts >= 15 && e.dv >= 1e9 && e.SECRS >= 2],
  ["ts>=16", e => e.ts >= 16],
  ["ts>=15 & $300M & TREND=3", e => e.ts >= 15 && e.dv >= 300e6 && e.TREND === 3],
  ["ts>=15 & $1B & MOM>=2 & SECRS>=2", e => e.ts >= 15 && e.dv >= 1e9 && e.MOM >= 2 && e.SECRS >= 2],
];
const rows = combos.map(([lbl, fn]) => {
  const s = E.filter(fn), oe = g(s.filter(e => e.oos)).edge, be = g(s.filter(e => e.regime === "bear")).edge;
  return { lbl, n: s.length, edge: g(s).edge, betaAdj: g(s).be, IS: g(s.filter(e => !e.oos)).edge, OOS: oe, BEAR: be, bearN: s.filter(e => e.regime === "bear").length, worst: g(s).worst, robust: Math.min(oe ?? -99, be ?? -99) };
}).sort((a, b) => b.robust - a.robust);
console.log("combo\tn\tedge\tbetaAdj\tIS\tOOS\tBEAR(n)\tworst\trobust=min(OOS,BEAR)");
for (const r of rows) console.log([r.lbl, r.n, r.edge, r.betaAdj, r.IS, r.OOS, `${r.BEAR}(${r.bearN})`, r.worst, r.robust].join("\t"));

console.log("\n===== 6. Per-crisis breakdown — buying DURING each named bear =====");
const keyFilters = [["baseline", e => true], ["$1B floor", e => e.dv >= 1e9], ["$3B floor", e => e.dv >= 3e9],
  ["ts>=15", e => e.ts >= 15], ["ts>=14&$1B&SECRS>=2", e => e.ts >= 14 && e.dv >= 1e9 && e.SECRS >= 2]];
console.log("filter\t" + CRISES.map(([nm]) => nm).join("\t"));
for (const [lbl, fn] of keyFilters) {
  const s = E.filter(fn);
  const cells = CRISES.map(([nm]) => { const cg = s.filter(e => e.crisis === nm); return cg.length ? `${g(cg).edge}(${cg.length})` : "-"; });
  console.log(lbl + "\t" + cells.join("\t"));
}
console.log("(cell = edge vs SPY (n) for entries fired inside that crisis window)");

console.log("\n===== 7. STRICT robust combos — require n>=300 AND IS>0 AND OOS>0 AND BEAR>0 =====");
const strict = rows.filter(r => r.n >= 300 && r.IS > 0 && r.OOS > 0 && r.BEAR > 0).sort((a, b) => b.robust - a.robust);
if (!strict.length) console.log("(none pass all four — every high-edge combo fails IS or bear or n)");
console.log("combo\tn\tedge\tbetaAdj\tIS\tOOS\tBEAR(n)\tworst\trobust");
for (const r of strict) console.log([r.lbl, r.n, r.edge, r.betaAdj, r.IS, r.OOS, `${r.BEAR}(${r.bearN})`, r.worst, r.robust].join("\t"));

writeFileSync(new URL("../../scratchpad/swing-validate/deep-entry-study.json", import.meta.url),
  JSON.stringify({ meta: { entries: E.length, IS: IS.length, OOS: OOS.length, bear: BEAR.length, oosCut: OOS_CUT, hold: H }, combos: rows, strict }, null, 2));
// compact dump of raw entries for fast follow-ups
writeFileSync(new URL("../../scratchpad/swing-validate/deep-entries.json", import.meta.url),
  JSON.stringify(E.map(e => [e.sym, e.d, e.ts, e.TREND, e.MOM, e.EXT, e.VOL, e.SECRS, Math.round(e.dv), e.beta == null ? null : r2(e.beta), e.atrPct == null ? null : r2(e.atrPct * 100), r2(e.offHigh * 100), e.vix == null ? null : r2(e.vix), r2(e.pnl), r2(e.edge), e.betaEdge == null ? null : r2(e.betaEdge), e.regime, e.crisis, e.oos ? 1 : 0])));
console.error("wrote deep-entry-study.json + deep-entries.json");
