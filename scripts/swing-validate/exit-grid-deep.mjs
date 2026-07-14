/* Exit-grid test over the DEEP 2006-2026 cache (through the 2008/2011/2015/2018/
   2020/2022 bears) — the honest test the forensic (bull-only 2024-26) can't give.

   Question the forensic raised: the 63-day TIME cap clips bull winners, but trailing/
   trend-break exits get whipsawed. Does that hold once real bears are in the sample —
   or do trend-break/trailing exits earn their keep by cutting losers in a bear?

   Faithful entry: the shipped v5 gate — computeShortSignal(...).entryStrong
   (techScore>=14 & px>50>200 & $vol>=$1B & sectorRS>=2), long-only, one sample per
   fresh strong transition. Forward runway 252 bars so every exit rule is measured on
   a full 1-year window. Exit grid runs on ascending TA (rolling SMA50/200 + Wilder
   ATR14). Benchmark: SPY buy-and-hold over each trade's own entry->exit window.

   Splits: IS(entry<2017)/OOS(>=2017) and bull/bear (SPY vs its 200DMA at entry).
   Constant cohort (>=252 runway) for the clean apples-to-apples cross-rule read. */

import { readFileSync, writeFileSync } from "node:fs";
import { computeShortSignal, strengthSeriesFor, SBT_HARD_STOP_PCT } from "../../netlify/lib/short-backtest.mjs";

const CACHE = new URL("../../scratchpad/swing-validate/deep-cache.json", import.meta.url);
const RUNWAY = 252;
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
const winRate = a => (a.length ? a.filter(x => x > 0).length / a.length : null);
const r2 = x => (x == null ? null : Math.round(x * 100) / 100);
const strengthAsOf = (series, date) => { for (const s of series) if (s.date <= date) return s.strength; return null; };
const spyCloseAsOf = (spyHist, date) => { for (const b of spyHist) if (b.date <= date) return b.close ?? b.price; return null; };
function spyRet(spyHist, e, x) { const a = spyCloseAsOf(spyHist, e), b = spyCloseAsOf(spyHist, x); return (a > 0 && b > 0) ? ((b - a) / a) * 100 : null; }

console.error("loading deep cache…");
const c = JSON.parse(readFileSync(CACHE, "utf8"));
const { spyHist, etfBySym, etfHistBySym, histBySym } = c;
const spyStr = strengthSeriesFor(spyHist);
const etfStr = {};
for (const [etf, h] of Object.entries(etfHistBySym || {})) etfStr[etf] = strengthSeriesFor(h);

// SPY 200DMA (ascending) for regime tagging at entry
const spyAsc = [...spyHist].reverse();
const spy200 = {}; { let s = 0; for (let i = 0; i < spyAsc.length; i++) { s += spyAsc[i].close; if (i >= 200) s -= spyAsc[i - 200].close; if (i >= 199) spy200[spyAsc[i].date] = s / 200; } }
const spyCloseByDate = {}; for (const b of spyHist) spyCloseByDate[b.date] = b.close;
function regimeAt(date) { const sp = spyCloseAsOf(spyHist, date); let sma = null; for (const d of spyAsc.map(b => b.date).reverse()) { if (d <= date && spy200[d] != null) { sma = spy200[d]; break; } } return (sp != null && sma != null) ? (sp >= sma ? "bull" : "bear") : "na"; }
// faster regime: precompute nearest spy200 as-of
const spyDatesDesc = spyHist.map(b => b.date);
function spy200AsOf(date) { for (const d of spyDatesDesc) if (d <= date) { if (spy200[d] != null) return spy200[d]; } return null; }
function regime(date) { const sp = spyCloseAsOf(spyHist, date); const sma = spy200AsOf(date); return (sp != null && sma != null) ? (sp >= sma ? "bull" : "bear") : "na"; }

function ascendingTA(descHist) {
  const bars = [...descHist].reverse();
  const n = bars.length;
  const sma50 = Array(n).fill(null), sma200 = Array(n).fill(null), atr14 = Array(n).fill(null);
  let s50 = 0, s200 = 0;
  for (let i = 0; i < n; i++) {
    s50 += bars[i].close; if (i >= 50) s50 -= bars[i - 50].close; if (i >= 49) sma50[i] = s50 / 50;
    s200 += bars[i].close; if (i >= 200) s200 -= bars[i - 200].close; if (i >= 199) sma200[i] = s200 / 200;
  }
  const tr = Array(n).fill(null);
  for (let i = 1; i < n; i++) { const h = bars[i].high ?? bars[i].close, l = bars[i].low ?? bars[i].close, pc = bars[i - 1].close; tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)); }
  let prev = null;
  for (let i = 14; i < n; i++) { if (prev == null) { let s = 0; for (let k = i - 13; k <= i; k++) s += tr[k]; prev = s / 14; } else prev = (prev * 13 + tr[i]) / 14; atr14[i] = prev; }
  return { bars, sma50, sma200, atr14 };
}

function cfExit(ta, ei, rule) {
  const { bars, sma50, sma200, atr14 } = ta;
  const entry = bars[ei].close;
  const hardStop = entry * (1 - SBT_HARD_STOP_PCT);
  let extreme = bars[ei].high ?? entry;
  const end = Math.min(bars.length - 1, ei + RUNWAY);
  for (let k = ei + 1; k <= end; k++) {
    const bar = bars[k], day = k - ei;
    const low = bar.low ?? bar.close, close = bar.close, open = bar.open ?? bar.close;
    if (low <= hardStop) { const fill = (open <= hardStop) ? open : hardStop; return { pnl: ((fill - entry) / entry) * 100, hold: day, exitK: k, reason: "STOP" }; }
    if (rule.trailAtr) { const atr = atr14[k] ?? atr14[k - 1]; if (atr > 0) { const line = extreme - rule.trailAtr * atr; if (low <= line) { const fill = (open <= line) ? open : line; return { pnl: ((fill - entry) / entry) * 100, hold: day, exitK: k, reason: "TRAIL" }; } } }
    if (rule.trendBreak && sma50[k] != null && close < sma50[k]) return { pnl: ((close - entry) / entry) * 100, hold: day, exitK: k, reason: "TREND" };
    if (rule.maCross && sma50[k] != null && sma200[k] != null && sma50[k] < sma200[k]) return { pnl: ((close - entry) / entry) * 100, hold: day, exitK: k, reason: "MACROSS" };
    if (rule.timeStop && day >= rule.timeStop) return { pnl: ((close - entry) / entry) * 100, hold: day, exitK: k, reason: "TIME" };
    if ((bar.high ?? close) > extreme) extreme = bar.high ?? close;
  }
  return { pnl: ((bars[end].close - entry) / entry) * 100, hold: end - ei, exitK: end, reason: "EOD" };
}

const RULES = {
  "shipped63":   { timeStop: 63 },
  "hold126":     { timeStop: 126 },
  "hold252":     { timeStop: 252 },
  "trendBreak":  { trendBreak: true, timeStop: 252 },
  "maCross":     { maCross: true, timeStop: 252 },
  "maCross189":  { maCross: true, timeStop: 189 },   // the v6 candidate: death-cross + 189-session backstop
  "chand3":      { trailAtr: 3, timeStop: 252 },
  "chand4":      { trailAtr: 4, timeStop: 252 },
  "chand4_tb":   { trailAtr: 4, trendBreak: true, timeStop: 252 },
};
const ORDER = Object.keys(RULES);

// ---- build entries (v5 gate, fresh transition), only those with a full 252 runway for the clean cohort
console.error("labeling entries (v5 gate)…");
const entries = [];
const names = Object.keys(histBySym);
let done = 0;
for (const sym of names) {
  const hist = histBySym[sym];
  if (!hist || hist.length < 260) { done++; continue; }
  const etf = etfBySym?.[sym] || null;
  const secStr = etf ? (etfStr[etf] || []) : [];
  const len = hist.length;
  const lastScorable = len - 200;
  const strong = new Array(lastScorable + 1).fill(false);
  for (let i = 0; i <= lastScorable; i++) {
    const date = hist[i].date;
    const sig = computeShortSignal(hist.slice(i, i + 260), { spyStrength: strengthAsOf(spyStr, date), sectorStrength: strengthAsOf(secStr, date) });
    strong[i] = !!(sig && sig.entryStrong);
  }
  const ta = ascendingTA(hist);
  const ascN = ta.bars.length;
  for (let i = 0; i <= lastScorable; i++) {
    if (!strong[i]) continue;
    if (i + 1 <= lastScorable && strong[i + 1]) continue; // not fresh
    const date = hist[i].date;
    const ei = ascN - 1 - i; // ascending index of the entry bar
    const runway = ascN - 1 - ei;
    if (runway < 21) continue; // need some forward room
    entries.push({ sym, etf, date, ei, ta, runway, year: +date.slice(0, 4), regime: regime(date) });
  }
  if (++done % 50 === 0) console.error(`  ${done}/${names.length}  entries=${entries.length}`);
}
console.error(`entries=${entries.length}  cohort252=${entries.filter(e => e.runway >= RUNWAY).length}`);

// ---- aggregate a rule over a subset
function agg(subset, rname) {
  const rule = RULES[rname];
  const pnls = [], edges = [], holds = [], wins = [], losses = [], calDays = [];
  const reasons = {};
  for (const e of subset) {
    const r = cfExit(e.ta, e.ei, rule);
    const exitDate = e.ta.bars[r.exitK].date;
    const s = spyRet(spyHist, e.date, exitDate);
    pnls.push(r.pnl); holds.push(r.hold);
    calDays.push(Math.round((Date.parse(exitDate) - Date.parse(e.date)) / 86400000));
    if (s != null) edges.push(r.pnl - s);
    (r.pnl > 0 ? wins : losses).push(r.pnl);
    reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  }
  return {
    rule: rname, n: pnls.length,
    avgPnl: r2(mean(pnls)), edge: r2(mean(edges)), winPct: r2(winRate(pnls) * 100),
    avgWin: r2(mean(wins)), avgLoss: r2(mean(losses)), medHold: median(holds),
    medHoldCal: median(calDays), avgHoldCal: Math.round(mean(calDays)),
    worst: r2(Math.min(...pnls)), best: r2(Math.max(...pnls)),
    reasons,
  };
}

const cohort = entries.filter(e => e.runway >= RUNWAY);
const allE = entries.filter(e => e.runway >= 21);
const splits = {
  "ALL entries (any runway; recent=truncated)": allE,
  "COHORT252 (clean: same trades every row)": cohort,
  "  IS <2017": cohort.filter(e => e.year < 2017),
  "  OOS >=2017": cohort.filter(e => e.year >= 2017),
  "  BULL entry": cohort.filter(e => e.regime === "bull"),
  "  BEAR entry": cohort.filter(e => e.regime === "bear"),
};

const out = { meta: { newest: spyHist[0].date, oldest: spyHist[spyHist.length - 1].date, names: names.length, entries: entries.length, cohort252: cohort.length, runway: RUNWAY, gate: "v5 entryStrong (tech>=14 & px>50>200 & $vol>=1B & secRS>=2)" }, splits: {} };

for (const [label, subset] of Object.entries(splits)) {
  console.log(`\n${"=".repeat(96)}\n${label}  (n=${subset.length})`);
  console.log(`rule         n     avgP/L   edge     win%    avgWin   avgLoss  medHold  worst     best     exitMix`);
  const rows = ORDER.map(rn => agg(subset, rn));
  out.splits[label.trim()] = rows;
  for (const r of rows) {
    const mix = Object.entries(r.reasons).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${Math.round(v / r.n * 100)}%`).join(" ");
    console.log(`${r.rule.padEnd(11)} ${String(r.n).padStart(4)}  ${((r.avgPnl >= 0 ? "+" : "") + r.avgPnl + "%").padStart(8)} ${((r.edge >= 0 ? "+" : "") + r.edge + "%").padStart(7)}  ${(r.winPct + "%").padStart(6)}  ${((r.avgWin >= 0 ? "+" : "") + r.avgWin + "%").padStart(7)}  ${(r.avgLoss + "%").padStart(7)}  ${String(r.medHold).padStart(6)}  ${(r.worst + "%").padStart(7)}  ${((r.best >= 0 ? "+" : "") + r.best + "%").padStart(7)}   ${mix}`);
  }
}

writeFileSync(new URL("../../scratchpad/swing-validate/exit-grid-deep.json", import.meta.url), JSON.stringify(out, null, 2));
console.error("\nwrote scratchpad/swing-validate/exit-grid-deep.json");
