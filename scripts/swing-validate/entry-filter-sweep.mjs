/* "Best of the best" entry-filter calibration — DONE HONESTLY.
   Two parts:
   A) Why is avg edge ~0 when one trade is +194%? -> return distribution &
      P/L concentration (the mean is dragged by thousands of ordinary trades).
   B) Can a POINT-IN-TIME entry filter (only entry-bar-observable factor tiers)
      separate trades that go on to beat SPY from those that don't — and does it
      SURVIVE out-of-sample? Any filter that only shines in-sample is hindsight
      winner-picking, not a rule. Acceptance metric = edge vs SPY (raw return just
      buys beta), reported IS (entry<2024-07) vs OOS (entry>=2024-07).

   Faithful to the live engine: gate = shipped computeShortSignal.entryStrong;
   per-factor tiers from shortDetailAt (same slice, same strength inputs). Exit =
   40% hard stop + TIME cap. Long-only. Off-cache, deterministic. */

import { readFileSync, writeFileSync } from "node:fs";
import { computeShortSignal, strengthSeriesFor } from "../../netlify/lib/short-backtest.mjs";
import { shortDetailAt } from "../../netlify/lib/short-study.mjs";

const CACHE = new URL("../../scratchpad/swing-validate/universe500-cache.json", import.meta.url);
const HARD_STOP_PCT = 0.40, FULL_RUNWAY = 252, OOS_CUT = "2024-07-01";
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
const winRate = a => (a.length ? a.filter(x => x > 0).length / a.length : null);
const r2 = x => (x == null ? null : Math.round(x * 100) / 100);
const strengthAsOf = (s, d) => { for (const x of s) if (x.date <= d) return x.strength; return null; };
const spyAsOf = (h, d) => { for (const b of h) if (b.date <= d) return b.close ?? b.price; return null; };
const spyRet = (h, e, x) => { const a = spyAsOf(h, e), b = spyAsOf(h, x); return (a > 0 && b > 0) ? ((b - a) / a) * 100 : null; };

console.error("loading cache…");
const c = JSON.parse(readFileSync(CACHE, "utf8"));
const { spyHist, etfBySym, etfHistBySym, histBySym } = c;
const spyStr = strengthSeriesFor(spyHist);
const etfStr = {}; for (const [e, h] of Object.entries(etfHistBySym || {})) etfStr[e] = strengthSeriesFor(h);

const recs = [];
let done = 0;
for (const sym of Object.keys(histBySym)) {
  const hist = histBySym[sym] || []; if (hist.length < 205) { done++; continue; }
  const secStr = etfBySym?.[sym] ? (etfStr[etfBySym[sym]] || []) : [];
  const len = hist.length, last = len - 200;
  const strong = new Array(len).fill(false), sigAt = new Array(len).fill(null);
  for (let i = 0; i <= last; i++) {
    const sig = computeShortSignal(hist.slice(i), { spyStrength: strengthAsOf(spyStr, hist[i].date), sectorStrength: strengthAsOf(secStr, hist[i].date) });
    sigAt[i] = sig; strong[i] = !!(sig && sig.entryStrong);
  }
  for (let i = 0; i <= last; i++) {
    if (!strong[i] || (i + 1 <= last && strong[i + 1])) continue;
    if (!(hist[i].close > 0)) continue;
    const det = shortDetailAt(hist.slice(i), strengthAsOf(spyStr, hist[i].date), strengthAsOf(secStr, hist[i].date));
    const f = {}; for (const ff of (det?.factors || [])) f[ff.key] = ff.buy;
    const fwd = [];
    for (let j = i - 1; j >= 0 && (i - j) <= FULL_RUNWAY; j--) { const b = hist[j]; fwd.push({ date: b.date, open: b.open ?? b.close, high: b.high ?? b.close, low: b.low ?? b.close, close: b.close }); }
    if (!fwd.length) continue;
    recs.push({ sym, entryDate: hist[i].date, entryClose: hist[i].close, techScore: sigAt[i].techScore, avgDollarVol: sigAt[i].avgDollarVol, f, fwd });
  }
  if (++done % 100 === 0) console.error(`  ${done} names, ${recs.length} entries`);
}
console.error(`entries: ${recs.length}`);

function sim(rec, H) {
  const entry = rec.entryClose, stop = entry * (1 - HARD_STOP_PCT);
  for (let k = 0; k < rec.fwd.length; k++) {
    const bar = rec.fwd[k], day = k + 1, low = bar.low > 0 ? bar.low : bar.close;
    if (low <= stop) { const fill = (bar.open > 0 && bar.open <= stop) ? bar.open : stop; return { pnl: ((fill - entry) / entry) * 100, exitDate: bar.date }; }
    if (day >= H) return { pnl: ((bar.close - entry) / entry) * 100, exitDate: bar.date };
  }
  const l = rec.fwd[rec.fwd.length - 1]; return { pnl: ((l.close - entry) / entry) * 100, exitDate: l.date };
}
// annotate each rec with pnl+edge at H=63 and H=126 once
for (const rec of recs) {
  for (const H of [63, 126]) {
    const r = sim(rec, H); const s = spyRet(spyHist, rec.entryDate, r.exitDate);
    rec[`p${H}`] = r.pnl; rec[`e${H}`] = s == null ? null : r.pnl - s; rec[`s${H}`] = s;
  }
}

/* ---------- PART A: distribution & concentration (why mean edge ~0) ---------- */
const p126 = recs.map(r => r.p126);
const e126 = recs.map(r => r.e126).filter(x => x != null);
const sorted = [...p126].sort((a, b) => b - a);
const totalPnl = p126.reduce((s, x) => s + x, 0);
const topShare = k => r2(100 * sorted.slice(0, Math.ceil(recs.length * k)).reduce((s, x) => s + x, 0) / totalPnl);
console.log("\n===== PART A — return distribution (6mo hold, all", recs.length, "trades) =====");
console.log("mean P/L:", r2(mean(p126)) + "%", " median P/L:", r2(median(p126)) + "%");
console.log("mean edge vs SPY:", r2(mean(e126)) + "%", " median edge:", r2(median(e126)) + "%");
console.log("% of trades that BEAT SPY:", r2(100 * e126.filter(x => x > 0).length / e126.length) + "%");
console.log("best:", r2(sorted[0]) + "%", " #2:", r2(sorted[1]) + "%", " #10:", r2(sorted[9]) + "%");
console.log("P/L share of top 1% of trades:", topShare(0.01) + "%", " top 5%:", topShare(0.05) + "%", " top 10%:", topShare(0.10) + "%");

/* ---------- PART B: point-in-time entry filters ---------- */
const FILTERS = [
  ["baseline (shipped gate)", () => true],
  ["techScore>=14", r => r.techScore >= 14],
  ["techScore>=15", r => r.techScore >= 15],
  ["techScore>=16", r => r.techScore >= 16],
  ["MOM=3 (3m ret>=15%)", r => r.f.MOM === 3],
  ["TREND=3 (>8% over 50DMA)", r => r.f.TREND === 3],
  ["SECRS>=2 (sector leads SPY)", r => r.f.SECRS >= 2],
  ["SECRS=3 (sector leads big)", r => r.f.SECRS === 3],
  ["EXTREME=3 (5-18% pullback)", r => r.f.EXTREME === 3],
  ["VOL>=2 (accumulation)", r => r.f.VOL >= 2],
  ["$vol>=$1B/day", r => r.avgDollarVol >= 1e9],
  ["$vol>=$3B/day", r => r.avgDollarVol >= 3e9],
  ["BoB: ts>=15 & SECRS>=2 & MOM=3", r => r.techScore >= 15 && r.f.SECRS >= 2 && r.f.MOM === 3],
  ["leader: TREND=3 & SECRS>=2 & MOM>=2", r => r.f.TREND === 3 && r.f.SECRS >= 2 && r.f.MOM >= 2],
  ["pullback: EXT=3 & TREND>=2 & MOM>=2", r => r.f.EXTREME === 3 && r.f.TREND >= 2 && r.f.MOM >= 2],
];
function stat(sub, H) {
  const e = sub.map(r => r[`e${H}`]).filter(x => x != null);
  const p = sub.map(r => r[`p${H}`]);
  return { n: sub.length, edge: r2(mean(e)), avgP: r2(mean(p)), win: r2(100 * winRate(p)) };
}
const rows = [];
for (const [name, fn] of FILTERS) {
  const sub = recs.filter(fn);
  const IS = sub.filter(r => r.entryDate < OOS_CUT), OOS = sub.filter(r => r.entryDate >= OOS_CUT);
  rows.push({ name,
    all63: stat(sub, 63), all126: stat(sub, 126),
    isEdge: r2(mean(IS.map(r => r.e126).filter(x => x != null))),
    oosEdge: r2(mean(OOS.map(r => r.e126).filter(x => x != null))),
    isN: IS.length, oosN: OOS.length });
}
console.log("\n===== PART B — entry filters, edge vs SPY (raw return just buys beta) =====");
console.log("filter\tn\tedge63\tedge126\tavgP126\twin126\tIS_edge126\tOOS_edge126");
for (const r of rows) console.log([r.name, r.all126.n, r.all63.edge, r.all126.edge, r.all126.avgP, r.all126.win, r.isEdge, r.oosEdge].join("\t"));

console.log("\n(IS = entry<" + OOS_CUT + ", OOS = entry>=" + OOS_CUT + ". A filter is only a 'rule' if OOS_edge stays positive.)");
writeFileSync(new URL("../../scratchpad/swing-validate/entry-filter-sweep.json", import.meta.url),
  JSON.stringify({ meta: { entries: recs.length, oosCut: OOS_CUT }, distribution: { meanP: r2(mean(p126)), medianP: r2(median(p126)), meanEdge: r2(mean(e126)), pctBeatSpy: r2(100 * e126.filter(x => x > 0).length / e126.length), top1: topShare(0.01), top5: topShare(0.05), top10: topShare(0.10) }, filters: rows }, null, 2));
console.error("wrote entry-filter-sweep.json");
