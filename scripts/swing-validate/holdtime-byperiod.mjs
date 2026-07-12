/* Companion to holdtime-sweep: is the panel's headline "+15.51% edge vs SPY" a
   real population edge, or a recent-window artifact? Cut the SAME shipped-gate
   entries by entry YEAR and report edge-vs-SPY at the current 63d hold and a 126d
   (6mo) hold. If edge is ~0 across most years and only balloons in the recent
   semi-rip window, the headline is regime/selection, not timing skill. */
import { readFileSync } from "node:fs";
import { computeShortSignal, strengthSeriesFor } from "../../netlify/lib/short-backtest.mjs";

const CACHE = new URL("../../scratchpad/swing-validate/universe500-cache.json", import.meta.url);
const HARD_STOP_PCT = 0.40;
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const winRate = a => (a.length ? a.filter(x => x > 0).length / a.length : null);
const r2 = x => (x == null ? null : Math.round(x * 100) / 100);
const strengthAsOf = (s, d) => { for (const x of s) if (x.date <= d) return x.strength; return null; };
const spyAsOf = (h, d) => { for (const b of h) if (b.date <= d) return b.close ?? b.price; return null; };
const spyRet = (h, e, x) => { const a = spyAsOf(h, e), b = spyAsOf(h, x); return (a > 0 && b > 0) ? ((b - a) / a) * 100 : null; };

const c = JSON.parse(readFileSync(CACHE, "utf8"));
const { spyHist, etfBySym, etfHistBySym, histBySym } = c;
const spyStr = strengthSeriesFor(spyHist);
const etfStr = {}; for (const [e, h] of Object.entries(etfHistBySym || {})) etfStr[e] = strengthSeriesFor(h);

const recs = [];
for (const sym of Object.keys(histBySym)) {
  const hist = histBySym[sym] || []; if (hist.length < 205) continue;
  const secStr = etfBySym?.[sym] ? (etfStr[etfBySym[sym]] || []) : [];
  const len = hist.length, last = len - 200, strong = new Array(len).fill(false);
  for (let i = 0; i <= last; i++) {
    const sig = computeShortSignal(hist.slice(i), { spyStrength: strengthAsOf(spyStr, hist[i].date), sectorStrength: strengthAsOf(secStr, hist[i].date) });
    strong[i] = !!(sig && sig.entryStrong);
  }
  for (let i = 0; i <= last; i++) {
    if (!strong[i] || (i + 1 <= last && strong[i + 1])) continue;
    if (!(hist[i].close > 0)) continue;
    const fwd = [];
    for (let j = i - 1; j >= 0 && (i - j) <= 252; j--) { const b = hist[j]; fwd.push({ date: b.date, open: b.open ?? b.close, high: b.high ?? b.close, low: b.low ?? b.close, close: b.close }); }
    if (fwd.length) recs.push({ sym, entryDate: hist[i].date, entryClose: hist[i].close, fwd });
  }
}
function sim(rec, H) {
  const entry = rec.entryClose, stop = entry * (1 - HARD_STOP_PCT);
  for (let k = 0; k < rec.fwd.length; k++) {
    const bar = rec.fwd[k], day = k + 1, low = bar.low > 0 ? bar.low : bar.close;
    if (low <= stop) { const fill = (bar.open > 0 && bar.open <= stop) ? bar.open : stop; return { pnl: ((fill - entry) / entry) * 100, exitDate: bar.date }; }
    if (day >= H) return { pnl: ((bar.close - entry) / entry) * 100, exitDate: bar.date };
  }
  const l = rec.fwd[rec.fwd.length - 1]; return { pnl: ((l.close - entry) / entry) * 100, exitDate: l.date };
}
function byYear(H) {
  const groups = {};
  for (const rec of recs) {
    const y = rec.entryDate.slice(0, 4);
    (groups[y] ||= []).push(rec);
  }
  console.log(`\n=== hold ${H}d (${Math.round(H/21)}mo) — edge vs SPY by ENTRY YEAR ===`);
  console.log("year\tn\tavgPnl\tavgSpy\tedge\twin%");
  for (const y of Object.keys(groups).sort()) {
    const g = groups[y], rets = [], spys = [], edges = [];
    for (const rec of g) { const r = sim(rec, H); rets.push(r.pnl); const s = spyRet(spyHist, rec.entryDate, r.exitDate); if (s != null) { spys.push(s); edges.push(r.pnl - s); } }
    console.log([y, rets.length, r2(mean(rets)), r2(mean(spys)), r2(mean(edges)), r2(winRate(rets) * 100)].join("\t"));
  }
}
byYear(63);
byYear(126);
