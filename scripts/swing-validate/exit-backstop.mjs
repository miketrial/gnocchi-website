/* Exit-backstop test — "does loosening the 189-day backstop capture bigger wins?"
   The discriminant study found 97.6% of >25% winners exit on the 189-session TIME
   backstop while STILL trending — the death-cross never fired, the clock did. So the
   backstop, not the entry, is what caps the fat tail. This sweeps the backstop length
   behind the shipped death-cross exit on a 2-YEAR-runway cohort (so long holds can
   actually complete), and reports big-win capture + edge + capital efficiency.

   Entry = v5 gate (byte-identical). Exit = 40% catastrophe stop → 50/200 death-cross
   → TIME backstop at H sessions (H swept). RUNWAY 504 so H up to ~2y is measurable;
   cohort = entries with ≥504 forward bars (constant set, every H on the same trades).
   Benchmark = SPY buy-and-hold over each trade's own entry→exit window.
   Splits: IS(<2017)/OOS(≥2017)/bear(SPY<200DMA at entry). */

import { readFileSync, writeFileSync } from "node:fs";
import { computeShortSignal, strengthSeriesFor, SBT_HARD_STOP_PCT } from "../../netlify/lib/short-backtest.mjs";

const CACHE = new URL("../../scratchpad/swing-validate/deep-cache.json", import.meta.url);
const RUNWAY = 504;
const BACKSTOPS = [63, 126, 189, 252, 378, 504]; // sessions; 504 ≈ "pure death-cross" (2y cap)
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
const r2 = x => (x == null ? null : Math.round(x * 100) / 100);
const share = (num, den) => (den ? r2(100 * num / den) : null);
const strengthAsOf = (series, date) => { for (const s of series) if (s.date <= date) return s.strength; return null; };
const spyCloseAsOf = (spyHist, date) => { for (const b of spyHist) if (b.date <= date) return b.close ?? b.price; return null; };
function spyRet(spyHist, e, x) { const a = spyCloseAsOf(spyHist, e), b = spyCloseAsOf(spyHist, x); return (a > 0 && b > 0) ? ((b - a) / a) * 100 : null; }

console.error("loading deep cache…");
const c = JSON.parse(readFileSync(CACHE, "utf8"));
const { spyHist, etfBySym, etfHistBySym, histBySym } = c;
const spyStr = strengthSeriesFor(spyHist);
const etfStr = {};
for (const [etf, h] of Object.entries(etfHistBySym || {})) etfStr[etf] = strengthSeriesFor(h);
const spyAsc = [...spyHist].reverse();
const spy200 = {}; { let s = 0; for (let i = 0; i < spyAsc.length; i++) { s += spyAsc[i].close; if (i >= 200) s -= spyAsc[i - 200].close; if (i >= 199) spy200[spyAsc[i].date] = s / 200; } }
const spyDatesDesc = spyHist.map(b => b.date);
const spy200AsOf = d => { for (const dt of spyDatesDesc) if (dt <= d) { if (spy200[dt] != null) return spy200[dt]; } return null; };

function ascendingTA(descHist) {
  const bars = [...descHist].reverse(); const n = bars.length;
  const sma50 = Array(n).fill(null), sma200 = Array(n).fill(null);
  let s50 = 0, s200 = 0;
  for (let i = 0; i < n; i++) { s50 += bars[i].close; if (i >= 50) s50 -= bars[i - 50].close; if (i >= 49) sma50[i] = s50 / 50; s200 += bars[i].close; if (i >= 200) s200 -= bars[i - 200].close; if (i >= 199) sma200[i] = s200 / 200; }
  return { bars, sma50, sma200 };
}
// death-cross exit with a TIME backstop at H
function exitAt(ta, ei, H) {
  const { bars, sma50, sma200 } = ta; const entry = bars[ei].close, hardStop = entry * (1 - SBT_HARD_STOP_PCT), end = Math.min(bars.length - 1, ei + RUNWAY);
  for (let k = ei + 1; k <= end; k++) {
    const bar = bars[k], day = k - ei, low = bar.low ?? bar.close, open = bar.open ?? bar.close;
    if (low <= hardStop) { const f = open <= hardStop ? open : hardStop; return { pnl: (f - entry) / entry * 100, exitK: k, reason: "STOP" }; }
    if (sma50[k] != null && sma200[k] != null && sma50[k] < sma200[k]) return { pnl: (bar.close - entry) / entry * 100, exitK: k, reason: "CROSS" };
    if (day >= H) return { pnl: (bar.close - entry) / entry * 100, exitK: k, reason: "TIME" };
  }
  return { pnl: (bars[end].close - entry) / entry * 100, exitK: end, reason: "EOD" };
}

console.error("labeling entries (v5 gate, 504-runway cohort)…");
const entries = []; const names = Object.keys(histBySym); let done = 0;
for (const sym of names) {
  const hist = histBySym[sym]; if (!hist || hist.length < 520) { done++; continue; }
  const etf = etfBySym?.[sym] || null; const secStr = etf ? (etfStr[etf] || []) : [];
  const lastScorable = hist.length - 200; const strong = new Array(lastScorable + 1).fill(false);
  for (let i = 0; i <= lastScorable; i++) { const sig = computeShortSignal(hist.slice(i, i + 260), { spyStrength: strengthAsOf(spyStr, hist[i].date), sectorStrength: strengthAsOf(secStr, hist[i].date) }); strong[i] = !!(sig && sig.entryStrong); }
  const ta = ascendingTA(hist); const ascN = ta.bars.length;
  for (let i = 0; i <= lastScorable; i++) {
    if (!strong[i]) continue; if (i + 1 <= lastScorable && strong[i + 1]) continue;
    const date = hist[i].date, ei = ascN - 1 - i; if (ascN - 1 - ei < RUNWAY) continue;
    const sc = spyCloseAsOf(spyHist, date), sm = spy200AsOf(date);
    entries.push({ sym, date, ei, ta, year: +date.slice(0, 4), bear: sc != null && sm != null ? sc < sm : null });
  }
  if (++done % 100 === 0) console.error(`  ${done}/${names.length} entries=${entries.length}`);
}
console.error(`cohort (≥504 runway) n=${entries.length}`);

function aggregate(subset, H) {
  const pnls = [], edges = [], holdsCal = [], wins = [], reasons = {};
  for (const e of subset) {
    const r = exitAt(e.ta, e.ei, H); const exitDate = e.ta.bars[r.exitK].date; const spy = spyRet(spyHist, e.date, exitDate);
    pnls.push(r.pnl); if (spy != null) edges.push(r.pnl - spy); holdsCal.push(Math.round((Date.parse(exitDate) - Date.parse(e.date)) / 86400000));
    if (r.pnl > 0) wins.push(r.pnl); reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  }
  const avg = mean(pnls), medHold = median(holdsCal);
  return { H, n: pnls.length, avg: r2(avg), edge: r2(mean(edges)), win: share(pnls.filter(x => x > 0).length, pnls.length),
    p25: share(pnls.filter(x => x > 25).length, pnls.length), p50: share(pnls.filter(x => x > 50).length, pnls.length), p100: share(pnls.filter(x => x > 100).length, pnls.length),
    avgWin: r2(mean(wins)), worst: r2(Math.min(...pnls)), medHoldCal: medHold, perYr: r2(avg != null && medHold ? avg / (medHold / 365) : null),
    crossPct: share(reasons.CROSS || 0, pnls.length), timePct: share(reasons.TIME || 0, pnls.length) };
}

const splits = { "ALL": entries, "IS <2017": entries.filter(e => e.year < 2017), "OOS ≥2017": entries.filter(e => e.year >= 2017), "BEAR entry": entries.filter(e => e.bear) };
const out = { meta: { newest: spyHist[0].date, cohort: entries.length, runway: RUNWAY }, splits: {} };
for (const [label, subset] of Object.entries(splits)) {
  console.log(`\n${"=".repeat(104)}\n${label}  (n=${subset.length})   [death-cross exit; H = TIME backstop in sessions; 504≈pure death-cross]`);
  console.log(`backstop  avgP/L   edge    win%   >25%  >50%  >100%  avgWin   worst    medHold(cal)  ret/yr-held  CROSS%/TIME%`);
  out.splits[label] = BACKSTOPS.map(H => aggregate(subset, H));
  for (const r of out.splits[label]) {
    console.log(`${String(r.H + "d").padEnd(8)} ${String((r.avg >= 0 ? "+" : "") + r.avg + "%").padStart(8)} ${String((r.edge >= 0 ? "+" : "") + r.edge + "%").padStart(7)}  ${String(r.win + "%").padStart(5)}  ${String(r.p25 + "%").padStart(5)} ${String(r.p50 + "%").padStart(5)} ${String(r.p100 + "%").padStart(5)}  ${String((r.avgWin >= 0 ? "+" : "") + r.avgWin + "%").padStart(8)} ${String(r.worst + "%").padStart(8)}  ${String(r.medHoldCal + "d").padStart(9)}   ${String((r.perYr >= 0 ? "+" : "") + r.perYr + "%").padStart(9)}   ${r.crossPct}%/${r.timePct}%`);
  }
}
writeFileSync(new URL("../../scratchpad/swing-validate/exit-backstop.json", import.meta.url), JSON.stringify(out, null, 2));
console.error("\nwrote scratchpad/swing-validate/exit-backstop.json");
