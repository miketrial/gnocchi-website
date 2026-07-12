/* Entry-conviction cut — "which buys are the GOOD buys?" Among v5-gate entries,
   do higher-conviction sub-tiers (stronger techScore, sector lead, liquidity,
   momentum) actually out-edge the base gate — enough to justify a conviction
   RANK / position-sizing tilt? Measured under BOTH the shipped 63d exit and the
   maCross exit, on the deep 2006-2026 cohort, OOS(>=2017) + bear cuts.

   Faithful entry via the live computeShortSignal (v5 entryStrong). */

import { readFileSync } from "node:fs";
import { computeShortSignal, strengthSeriesFor, SBT_HARD_STOP_PCT } from "../../netlify/lib/short-backtest.mjs";

const CACHE = new URL("../../scratchpad/swing-validate/deep-cache.json", import.meta.url);
const RUNWAY = 252;
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const winRate = a => (a.length ? a.filter(x => x > 0).length / a.length : null);
const r2 = x => (x == null ? null : Math.round(x * 100) / 100);
const strengthAsOf = (series, date) => { for (const s of series) if (s.date <= date) return s.strength; return null; };
const spyCloseAsOf = (h, d) => { for (const b of h) if (b.date <= d) return b.close; return null; };
const spyRet = (h, e, x) => { const a = spyCloseAsOf(h, e), b = spyCloseAsOf(h, x); return (a > 0 && b > 0) ? ((b - a) / a) * 100 : null; };

console.error("loading deep cache…");
const c = JSON.parse(readFileSync(CACHE, "utf8"));
const { spyHist, etfBySym, etfHistBySym, histBySym } = c;
const spyStr = strengthSeriesFor(spyHist);
const etfStr = {}; for (const [e, h] of Object.entries(etfHistBySym || {})) etfStr[e] = strengthSeriesFor(h);
const spyAsc = [...spyHist].reverse(); const spy200 = {}; { let s = 0; for (let i = 0; i < spyAsc.length; i++) { s += spyAsc[i].close; if (i >= 200) s -= spyAsc[i - 200].close; if (i >= 199) spy200[spyAsc[i].date] = s / 200; } }
const spyDatesDesc = spyHist.map(b => b.date);
const regime = d => { const sp = spyCloseAsOf(spyHist, d); let sma = null; for (const dd of spyDatesDesc) if (dd <= d && spy200[dd] != null) { sma = spy200[dd]; break; } return (sp != null && sma != null) ? (sp >= sma ? "bull" : "bear") : "na"; };

function ascendingTA(descHist) {
  const bars = [...descHist].reverse(); const n = bars.length;
  const sma50 = Array(n).fill(null), sma200 = Array(n).fill(null), atr14 = Array(n).fill(null);
  let s50 = 0, s200 = 0;
  for (let i = 0; i < n; i++) { s50 += bars[i].close; if (i >= 50) s50 -= bars[i - 50].close; if (i >= 49) sma50[i] = s50 / 50; s200 += bars[i].close; if (i >= 200) s200 -= bars[i - 200].close; if (i >= 199) sma200[i] = s200 / 200; }
  const tr = Array(n).fill(null); for (let i = 1; i < n; i++) { const h = bars[i].high ?? bars[i].close, l = bars[i].low ?? bars[i].close, pc = bars[i - 1].close; tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)); }
  let prev = null; for (let i = 14; i < n; i++) { if (prev == null) { let s = 0; for (let k = i - 13; k <= i; k++) s += tr[k]; prev = s / 14; } else prev = (prev * 13 + tr[i]) / 14; atr14[i] = prev; }
  return { bars, sma50, sma200, atr14 };
}
function exitAt(ta, ei, rule) {
  const { bars, sma50, sma200 } = ta; const entry = bars[ei].close; const hardStop = entry * (1 - SBT_HARD_STOP_PCT);
  const end = Math.min(bars.length - 1, ei + RUNWAY);
  for (let k = ei + 1; k <= end; k++) {
    const bar = bars[k], day = k - ei, low = bar.low ?? bar.close, close = bar.close, open = bar.open ?? bar.close;
    if (low <= hardStop) { const fill = open <= hardStop ? open : hardStop; return { pnl: ((fill - entry) / entry) * 100, exitDate: bar.date }; }
    if (rule.maCross && sma50[k] != null && sma200[k] != null && sma50[k] < sma200[k]) return { pnl: ((close - entry) / entry) * 100, exitDate: bar.date };
    if (rule.timeStop && day >= rule.timeStop) return { pnl: ((close - entry) / entry) * 100, exitDate: bar.date };
  }
  return { pnl: ((bars[end].close - entry) / entry) * 100, exitDate: bars[end].date };
}

console.error("labeling…");
const entries = [];
const names = Object.keys(histBySym); let done = 0;
for (const sym of names) {
  const hist = histBySym[sym]; if (!hist || hist.length < 260) { done++; continue; }
  const etf = etfBySym?.[sym] || null; const secStr = etf ? (etfStr[etf] || []) : [];
  const len = hist.length, lastScorable = len - 200;
  const sigs = new Array(lastScorable + 1).fill(null);
  for (let i = 0; i <= lastScorable; i++) { const date = hist[i].date; sigs[i] = computeShortSignal(hist.slice(i, i + 260), { spyStrength: strengthAsOf(spyStr, date), sectorStrength: strengthAsOf(secStr, date) }); }
  const ta = ascendingTA(hist); const ascN = ta.bars.length;
  for (let i = 0; i <= lastScorable; i++) {
    const sig = sigs[i]; if (!sig || !sig.entryStrong) continue;
    if (i + 1 <= lastScorable && sigs[i + 1] && sigs[i + 1].entryStrong) continue;
    const ei = ascN - 1 - i; const runway = ascN - 1 - ei; if (runway < RUNWAY) continue;
    const mom63 = (ta.bars[ei - 63] && ta.bars[ei - 63].close > 0) ? ta.bars[ei].close / ta.bars[ei - 63].close - 1 : null;
    entries.push({ sym, date: hist[i].date, ei, ta, techScore: sig.techScore, secPts: sig.secPts, dvol: sig.avgDollarVol, mom63, year: +hist[i].date.slice(0, 4), regime: regime(hist[i].date) });
  }
  if (++done % 60 === 0) console.error(`  ${done}/${names.length} entries=${entries.length}`);
}
console.error(`cohort252 entries=${entries.length}`);

function report(title, subset) {
  console.log(`\n${"=".repeat(78)}\n${title}  (n=${subset.length})`);
  console.log(`bucket            n     shipped63             maCross`);
  console.log(`                        avgP/L  edge   win%    avgP/L  edge   win%`);
  const row = (label, recs) => {
    if (!recs.length) { console.log(`${label.padEnd(16)} ${String(0).padStart(4)}`); return; }
    const stat = rule => { const ps = [], es = []; for (const e of recs) { const r = exitAt(e.ta, e.ei, rule); ps.push(r.pnl); const s = spyRet(spyHist, e.date, r.exitDate); if (s != null) es.push(r.pnl - s); } return { avg: r2(mean(ps)), edge: r2(mean(es)), win: r2(winRate(ps) * 100) }; };
    const a = stat({ timeStop: 63 }), b = stat({ maCross: true, timeStop: 252 });
    const f = (v, suf = "%") => ((v >= 0 ? "+" : "") + v + suf);
    console.log(`${label.padEnd(16)} ${String(recs.length).padStart(4)}   ${f(a.avg).padStart(7)} ${f(a.edge).padStart(6)} ${(a.win + "%").padStart(5)}   ${f(b.avg).padStart(7)} ${f(b.edge).padStart(6)} ${(b.win + "%").padStart(5)}`);
  };
  row("techScore=14", subset.filter(e => e.techScore === 14));
  row("techScore=15", subset.filter(e => e.techScore === 15));
  row("techScore>=16", subset.filter(e => e.techScore >= 16));
  row("secPts=2", subset.filter(e => e.secPts === 2));
  row("secPts=3", subset.filter(e => e.secPts === 3));
  row("$vol 1-3B", subset.filter(e => e.dvol < 3e9));
  row("$vol>=3B", subset.filter(e => e.dvol >= 3e9));
  row("mom63<15%", subset.filter(e => e.mom63 != null && e.mom63 < 0.15));
  row("mom63 15-40%", subset.filter(e => e.mom63 != null && e.mom63 >= 0.15 && e.mom63 < 0.40));
  row("mom63>=40%", subset.filter(e => e.mom63 != null && e.mom63 >= 0.40));
  row("ALL (base gate)", subset);
}

report("OOS >=2017", entries.filter(e => e.year >= 2017));
report("BEAR entry", entries.filter(e => e.regime === "bear"));
