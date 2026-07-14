/* Is the "best of the best" (techScore>=15 etc.) edge real skill or just BETA?
   The IS/OOS split doesn't settle it because BOTH windows are mostly bull. Two
   decisive tests here:
     1) edge vs SPY BY ENTRY YEAR — if it's beta, high-conviction names crush SPY
        in bull years and get crushed in the 2022 bear. If it's skill, it persists.
     2) BETA-ADJUSTED edge — subtract (trailing 120d beta x SPY return) instead of
        raw SPY. If beta-adjusted edge collapses to ~0, the "edge" was leverage. */
import { readFileSync } from "node:fs";
import { computeShortSignal, strengthSeriesFor } from "../../netlify/lib/short-backtest.mjs";

const CACHE = new URL("../../scratchpad/swing-validate/universe500-cache.json", import.meta.url);
const HARD_STOP_PCT = 0.40, FULL_RUNWAY = 252, H = 126, BETA_LOOKBACK = 120;
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const r2 = x => (x == null ? null : Math.round(x * 100) / 100);
const strengthAsOf = (s, d) => { for (const x of s) if (x.date <= d) return x.strength; return null; };
const spyAsOf = (h, d) => { for (const b of h) if (b.date <= d) return b.close ?? b.price; return null; };
const spyRet = (h, e, x) => { const a = spyAsOf(h, e), b = spyAsOf(h, x); return (a > 0 && b > 0) ? ((b - a) / a) * 100 : null; };

const c = JSON.parse(readFileSync(CACHE, "utf8"));
const { spyHist, etfBySym, etfHistBySym, histBySym } = c;
const spyStr = strengthSeriesFor(spyHist);
const etfStr = {}; for (const [e, h] of Object.entries(etfHistBySym || {})) etfStr[e] = strengthSeriesFor(h);
// SPY log-return by date for beta
const spyLR = {}; for (let i = 0; i < spyHist.length - 1; i++) { const a = spyHist[i].close, b = spyHist[i + 1].close; if (a > 0 && b > 0) spyLR[spyHist[i].date] = Math.log(a / b); }

const recs = [];
for (const sym of Object.keys(histBySym)) {
  const hist = histBySym[sym] || []; if (hist.length < 205) continue;
  const secStr = etfBySym?.[sym] ? (etfStr[etfBySym[sym]] || []) : [];
  const len = hist.length, last = len - 200;
  const strong = new Array(len).fill(false), sc = new Array(len).fill(0);
  for (let i = 0; i <= last; i++) { const sig = computeShortSignal(hist.slice(i), { spyStrength: strengthAsOf(spyStr, hist[i].date), sectorStrength: strengthAsOf(secStr, hist[i].date) }); sc[i] = sig ? sig.techScore : 0; strong[i] = !!(sig && sig.entryStrong); }
  for (let i = 0; i <= last; i++) {
    if (!strong[i] || (i + 1 <= last && strong[i + 1]) || !(hist[i].close > 0)) continue;
    // trailing beta: name log-ret vs SPY log-ret over prior BETA_LOOKBACK sessions
    let sxy = 0, sxx = 0, nb = 0;
    for (let k = i; k < i + BETA_LOOKBACK && k < len - 1; k++) {
      const a = hist[k].close, b = hist[k + 1].close; const sr = spyLR[hist[k].date];
      if (a > 0 && b > 0 && sr != null) { const nr = Math.log(a / b); sxy += nr * sr; sxx += sr * sr; nb++; }
    }
    const beta = (nb > 30 && sxx > 0) ? sxy / sxx : null;
    const fwd = [];
    for (let j = i - 1; j >= 0 && (i - j) <= FULL_RUNWAY; j--) { const bb = hist[j]; fwd.push({ date: bb.date, open: bb.open ?? bb.close, high: bb.high ?? bb.close, low: bb.low ?? bb.close, close: bb.close }); }
    if (!fwd.length) continue;
    recs.push({ sym, entryDate: hist[i].date, entryClose: hist[i].close, techScore: sc[i], beta, fwd });
  }
}
function sim(rec) {
  const entry = rec.entryClose, stop = entry * (1 - HARD_STOP_PCT);
  for (let k = 0; k < rec.fwd.length; k++) { const bar = rec.fwd[k], day = k + 1, low = bar.low > 0 ? bar.low : bar.close;
    if (low <= stop) { const fill = (bar.open > 0 && bar.open <= stop) ? bar.open : stop; return { pnl: ((fill - entry) / entry) * 100, exitDate: bar.date }; }
    if (day >= H) return { pnl: ((bar.close - entry) / entry) * 100, exitDate: bar.date }; }
  const l = rec.fwd[rec.fwd.length - 1]; return { pnl: ((l.close - entry) / entry) * 100, exitDate: l.date };
}
for (const rec of recs) { const r = sim(rec); const s = spyRet(spyHist, rec.entryDate, r.exitDate); rec.pnl = r.pnl; rec.spy = s; rec.edge = s == null ? null : r.pnl - s; rec.betaEdge = (s == null || rec.beta == null) ? null : r.pnl - rec.beta * s; }

const SETS = [
  ["baseline", r => true],
  ["techScore>=15", r => r.techScore >= 15],
  ["techScore>=16", r => r.techScore >= 16],
];
for (const [name, fn] of SETS) {
  const sub = recs.filter(fn);
  console.log(`\n===== ${name}  (n=${sub.length}, 6mo hold) =====`);
  console.log("year\tn\tavgBeta\tavgPnl\tavgSpy\tedge_vsSPY\tedge_BETA-ADJ");
  const years = [...new Set(sub.map(r => r.entryDate.slice(0, 4)))].sort();
  for (const y of years) {
    const g = sub.filter(r => r.entryDate.slice(0, 4) === y);
    console.log([y, g.length, r2(mean(g.map(r => r.beta).filter(x => x != null))), r2(mean(g.map(r => r.pnl))), r2(mean(g.map(r => r.spy).filter(x => x != null))), r2(mean(g.map(r => r.edge).filter(x => x != null))), r2(mean(g.map(r => r.betaEdge).filter(x => x != null)))].join("\t"));
  }
  console.log(["ALL", sub.length, r2(mean(sub.map(r => r.beta).filter(x => x != null))), r2(mean(sub.map(r => r.pnl))), r2(mean(sub.map(r => r.spy).filter(x => x != null))), r2(mean(sub.map(r => r.edge).filter(x => x != null))), r2(mean(sub.map(r => r.betaEdge).filter(x => x != null)))].join("\t"));
}
