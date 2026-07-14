/* Regime overlay study — "size down when SPY < its 200-DMA": does a market-regime
   overlay improve the SHIPPED v6 swing rule (entry = v5 best-of-best gate; exit =
   50/200 death-cross + 40% stop + 189-session backstop)?

   Tested variants (all on the SAME v6 base trades, deep 2006-2026 cache):
     base          — as shipped, every entry full weight
     skipBear      — drop entries where SPY < its 200DMA at entry
     halfBear      — half-weight entries where SPY < its 200DMA at entry
     skipFalling   — drop only "falling bear" entries (SPY < 200DMA AND SPY < its
                     50DMA — mid-decline), keep recovery entries (SPY < 200 but > 50:
                     off-the-bottom rallies, which the deep-entry study showed are
                     where the positive bear aggregate comes from)
     spyCrossExit  — state-based: EXIT any open trade at the close of the first day
                     SPY closes below its 200DMA during the hold
     spyCrossHalf  — trim half at that SPY cross, run the rest to the normal exit
                     (pnl = 0.5×pnl@cross + 0.5×pnl@normal-exit)

   Also: a LOSS AUTOPSY of the base rule's ugly tail (≤ −25%): what regime were
   those entered in, and did SPY cross below its 200DMA during the hold? This tests
   the actual claim "the remaining ugly losses cluster when SPY < 200-DMA".

   Metrics are weight-aware (a half-sized trade contributes half its pnl and half
   its $): effective n, weighted avg P/L, weighted edge vs SPY (same-window B&H),
   win%, worst, cum$ at $10k×weight, exit mix. Splits: IS(<2017)/OOS, per-crisis.
   Pure/off-cache; entries byte-identical to the shipped gate. */

import { readFileSync, writeFileSync } from "node:fs";
import { computeShortSignal, strengthSeriesFor, SBT_HARD_STOP_PCT, SBT_TIME_STOP_DAYS } from "../../netlify/lib/short-backtest.mjs";

const CACHE = new URL("../../scratchpad/swing-validate/deep-cache.json", import.meta.url);
const RUNWAY = 252; // enough for the 189-backstop + slack; cohort gate below
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
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

/* ---- SPY regime series (ascending): below200 flag + falling (also < 50DMA) ---- */
const spyAsc = [...spyHist].reverse();
const spyState = {}; // date -> {below200, falling}
{
  let s200 = 0, s50 = 0;
  for (let i = 0; i < spyAsc.length; i++) {
    s200 += spyAsc[i].close; if (i >= 200) s200 -= spyAsc[i - 200].close;
    s50 += spyAsc[i].close; if (i >= 50) s50 -= spyAsc[i - 50].close;
    if (i >= 199) {
      const sma200 = s200 / 200, sma50 = s50 / 50;
      spyState[spyAsc[i].date] = { below200: spyAsc[i].close < sma200, falling: spyAsc[i].close < sma200 && spyAsc[i].close < sma50 };
    }
  }
}
const spyDatesAsc = spyAsc.map(b => b.date);
const stateAsOf = (date) => { // last state on/before date
  // binary search over ascending dates
  let lo = 0, hi = spyDatesAsc.length - 1, best = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (spyDatesAsc[m] <= date) { best = m; lo = m + 1; } else hi = m - 1; }
  return best == null ? null : spyState[spyDatesAsc[best]] ?? null;
};
// first SPY close < 200DMA strictly AFTER `date` (for the in-trade cross): returns date or null
const firstCrossAfter = (date, throughDate) => {
  let lo = 0, hi = spyDatesAsc.length - 1, start = spyDatesAsc.length;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (spyDatesAsc[m] > date) { start = m; hi = m - 1; } else lo = m + 1; }
  for (let i = start; i < spyDatesAsc.length; i++) {
    const d = spyDatesAsc[i];
    if (d > throughDate) return null;
    const st = spyState[d];
    if (st && st.below200) {
      // require the PRIOR day to be above (a fresh cross, not an ongoing bear)
      const prev = i > 0 ? spyState[spyDatesAsc[i - 1]] : null;
      if (!prev || !prev.below200) return d;
    }
  }
  return null;
};

/* ---- crisis windows (mirror deep-entry-study) ---- */
const CRISES = [
  ["GFC", "2007-10-01", "2009-03-31"], ["euro11", "2011-05-01", "2011-10-31"],
  ["sino16", "2015-08-01", "2016-02-29"], ["q4-18", "2018-10-01", "2018-12-31"],
  ["covid", "2020-02-15", "2020-04-30"], ["bear22", "2022-01-01", "2022-10-31"],
];
const crisisOf = (d) => { for (const [k, a, b] of CRISES) if (d >= a && d <= b) return k; return null; };

/* ---- ascending TA per name (SMA50/200 for the death-cross exit) ---- */
function ascendingTA(descHist) {
  const bars = [...descHist].reverse();
  const n = bars.length;
  const sma50 = Array(n).fill(null), sma200 = Array(n).fill(null);
  let s50 = 0, s200 = 0;
  for (let i = 0; i < n; i++) {
    s50 += bars[i].close; if (i >= 50) s50 -= bars[i - 50].close; if (i >= 49) sma50[i] = s50 / 50;
    s200 += bars[i].close; if (i >= 200) s200 -= bars[i - 200].close; if (i >= 199) sma200[i] = s200 / 200;
  }
  const idxByDate = {}; for (let i = 0; i < n; i++) idxByDate[bars[i].date] = i;
  return { bars, sma50, sma200, idxByDate };
}

/* ---- the shipped v6 exit: 40% stop -> death-cross at close -> 189 TIME ---- */
function v6Exit(ta, ei) {
  const { bars, sma50, sma200 } = ta;
  const entry = bars[ei].close;
  const hardStop = entry * (1 - SBT_HARD_STOP_PCT);
  const end = Math.min(bars.length - 1, ei + RUNWAY);
  for (let k = ei + 1; k <= end; k++) {
    const bar = bars[k], day = k - ei;
    const low = bar.low ?? bar.close, open = bar.open ?? bar.close;
    if (low <= hardStop) { const fill = (open <= hardStop) ? open : hardStop; return { pnl: ((fill - entry) / entry) * 100, exitK: k, reason: "STOP" }; }
    if (sma50[k] != null && sma200[k] != null && sma50[k] < sma200[k]) return { pnl: ((bar.close - entry) / entry) * 100, exitK: k, reason: "CROSS" };
    if (day >= SBT_TIME_STOP_DAYS) return { pnl: ((bar.close - entry) / entry) * 100, exitK: k, reason: "TIME" };
  }
  return { pnl: ((bars[end].close - entry) / entry) * 100, exitK: end, reason: "EOD" };
}

/* ---- build v6 entries (shipped gate, fresh transitions) ---- */
console.error("labeling entries (v5 gate)…");
const trades = [];
const names = Object.keys(histBySym);
let done = 0;
for (const sym of names) {
  const hist = histBySym[sym];
  if (!hist || hist.length < 260) { done++; continue; }
  const etf = etfBySym?.[sym] || null;
  const secStr = etf ? (etfStr[etf] || []) : [];
  const lastScorable = hist.length - 200;
  const strong = new Array(lastScorable + 1).fill(false);
  for (let i = 0; i <= lastScorable; i++) {
    const sig = computeShortSignal(hist.slice(i, i + 260), { spyStrength: strengthAsOf(spyStr, hist[i].date), sectorStrength: strengthAsOf(secStr, hist[i].date) });
    strong[i] = !!(sig && sig.entryStrong);
  }
  const ta = ascendingTA(hist);
  const ascN = ta.bars.length;
  for (let i = 0; i <= lastScorable; i++) {
    if (!strong[i]) continue;
    if (i + 1 <= lastScorable && strong[i + 1]) continue;
    const date = hist[i].date;
    const ei = ascN - 1 - i;
    if (ascN - 1 - ei < RUNWAY) continue;            // constant cohort: full runway only
    const st = stateAsOf(date);
    if (!st) continue;
    const x = v6Exit(ta, ei);
    const exitDate = ta.bars[x.exitK].date;
    const spy = spyRet(spyHist, date, exitDate);
    if (spy == null) continue;
    // in-trade SPY cross (fresh close below 200DMA strictly after entry, on/before exit)
    const crossDate = firstCrossAfter(date, exitDate);
    let pnlAtCross = null;
    if (crossDate != null) {
      // stock close on the first bar on/after crossDate (name may not trade that exact date)
      for (let k = ei + 1; k <= x.exitK; k++) if (ta.bars[k].date >= crossDate) { pnlAtCross = ((ta.bars[k].close - ta.bars[ei].close) / ta.bars[ei].close) * 100; break; }
    }
    trades.push({
      sym, date, year: +date.slice(0, 4), crisis: crisisOf(date),
      bearEntry: st.below200, fallingEntry: st.falling,
      pnl: x.pnl, spy, edge: x.pnl - spy, reason: x.reason,
      crossDate, pnlAtCross,
      spyAtCrossToExit: crossDate ? spyRet(spyHist, crossDate, exitDate) : null,
    });
  }
  if (++done % 100 === 0) console.error(`  ${done}/${names.length}  trades=${trades.length}`);
}
console.error(`v6 cohort trades: ${trades.length} (bear-entry ${trades.filter(t => t.bearEntry).length}, falling ${trades.filter(t => t.fallingEntry).length}, in-trade SPY cross ${trades.filter(t => t.crossDate).length})`);

/* ---- overlay variants: weight(entry) + optional pnl transform ---- */
const VARIANTS = {
  base:         { w: () => 1, pnl: t => t.pnl },
  skipBear:     { w: t => (t.bearEntry ? 0 : 1), pnl: t => t.pnl },
  halfBear:     { w: t => (t.bearEntry ? 0.5 : 1), pnl: t => t.pnl },
  skipFalling:  { w: t => (t.fallingEntry ? 0 : 1), pnl: t => t.pnl },
  spyCrossExit: { w: () => 1, pnl: t => (t.pnlAtCross != null ? t.pnlAtCross : t.pnl) },
  spyCrossHalf: { w: () => 1, pnl: t => (t.pnlAtCross != null ? 0.5 * t.pnlAtCross + 0.5 * t.pnl : t.pnl) },
};

function aggregate(subset, v) {
  let W = 0, sumP = 0, sumE = 0, wins = 0, nEff = 0, cum = 0, worst = null;
  for (const t of subset) {
    const w = v.w(t); if (!w) continue;
    const p = v.pnl(t);
    // edge uses SPY over the SAME window the variant is exposed: for the exit-at-cross
    // variant the honest window is entry->cross; approximate by scaling spy the same
    // way (full-window spy for base/entry variants; entry->cross spy when cut early).
    const spy = (v === VARIANTS.spyCrossExit && t.crossDate != null && t.spyAtCrossToExit != null)
      ? t.spy - t.spyAtCrossToExit  // spy(entry->cross) = spy(entry->exit) − spy(cross->exit) (arith approx)
      : t.spy;
    W += w; nEff++; sumP += w * p; sumE += w * (p - spy);
    if (p > 0) wins += w;
    cum += 10000 * w * (p / 100);
    if (worst == null || p < worst) worst = p;
  }
  return { n: nEff, effW: r2(W), avgPnl: r2(sumP / W), edge: r2(sumE / W), winPct: r2(100 * wins / W), worst: r2(worst), cum$: Math.round(cum) };
}

const OUT = { meta: { newest: spyHist[0].date, trades: trades.length, exit: "v6 (40% stop -> 50/200 CROSS -> 189 TIME)", cohort: "full 252-bar runway" }, sections: {} };
const show = (label, subset) => {
  console.log(`\n${"=".repeat(96)}\n${label}  (n=${subset.length})`);
  console.log(`variant       nTrades  effWeight  avgP/L    edge     win%    worst      cum$(10k×w)`);
  const rows = {};
  for (const [name, v] of Object.entries(VARIANTS)) {
    const a = aggregate(subset, v);
    rows[name] = a;
    console.log(`${name.padEnd(13)} ${String(a.n).padStart(6)}  ${String(a.effW).padStart(8)}  ${((a.avgPnl >= 0 ? "+" : "") + a.avgPnl + "%").padStart(8)} ${((a.edge >= 0 ? "+" : "") + a.edge + "%").padStart(8)}  ${(a.winPct + "%").padStart(6)}  ${(a.worst + "%").padStart(8)}  ${("$" + a.cum$.toLocaleString()).padStart(12)}`);
  }
  OUT.sections[label] = rows;
};

show("ALL (2006-2026, full-runway cohort)", trades);
show("IS <2017", trades.filter(t => t.year < 2017));
show("OOS >=2017", trades.filter(t => t.year >= 2017));

/* ---- per-crisis: entries DURING each named window, base vs skipBear ---- */
console.log(`\n${"=".repeat(96)}\nPER-CRISIS (v6 base rule; these are what a bear filter would drop or shrink)`);
console.log(`crisis   n    avgP/L    edge     worst    | skipBear leaves n`);
for (const [k] of CRISES.map(x => [x[0]])) {
  const a = trades.filter(t => t.crisis === k);
  if (!a.length) { console.log(`${k.padEnd(7)} 0`); continue; }
  const b = aggregate(a, VARIANTS.base);
  const left = a.filter(t => !t.bearEntry).length;
  console.log(`${k.padEnd(7)} ${String(a.length).padStart(3)}  ${((b.avgPnl >= 0 ? "+" : "") + b.avgPnl + "%").padStart(8)} ${((b.edge >= 0 ? "+" : "") + b.edge + "%").padStart(8)}  ${(b.worst + "%").padStart(7)}  | ${left}`);
}

/* ---- LOSS AUTOPSY: the base rule's ugly tail ---- */
const ugly = trades.filter(t => t.pnl <= -25).sort((a, b) => a.pnl - b.pnl);
const uglyBear = ugly.filter(t => t.bearEntry).length;
const uglyCrossed = ugly.filter(t => !t.bearEntry && t.crossDate != null).length;
const uglyBullNoCross = ugly.filter(t => !t.bearEntry && t.crossDate == null).length;
console.log(`\n${"=".repeat(96)}\nLOSS AUTOPSY — base-rule trades ≤ −25%: ${ugly.length} of ${trades.length} (${r2(100 * ugly.length / trades.length)}%)`);
console.log(`  entered in bear regime (SPY<200DMA):            ${uglyBear}  (${r2(100 * uglyBear / ugly.length)}%)`);
console.log(`  entered in BULL, SPY crossed <200DMA mid-hold:  ${uglyCrossed}  (${r2(100 * uglyCrossed / ugly.length)}%)`);
console.log(`  entered in BULL, SPY never crossed during hold: ${uglyBullNoCross}  (${r2(100 * uglyBullNoCross / ugly.length)}%)`);
console.log(`  …of the bull+crossed uglies, avg P/L if EXITED at the SPY cross instead: ${r2(mean(ugly.filter(t => !t.bearEntry && t.pnlAtCross != null).map(t => t.pnlAtCross)))}% (vs ${r2(mean(ugly.filter(t => !t.bearEntry && t.pnlAtCross != null).map(t => t.pnl)))}% held)`);
console.log(`\nworst 12 base-rule trades:`);
for (const t of ugly.slice(0, 12)) {
  console.log(`  ${t.sym.padEnd(6)} ${t.date}  ${(t.pnl + "%").padStart(8)}  ${t.reason.padEnd(5)} entry=${t.bearEntry ? (t.fallingEntry ? "BEAR-falling" : "BEAR-recovery") : "bull"}${t.crisis ? ` crisis=${t.crisis}` : ""}${t.crossDate ? ` spyCross=${t.crossDate} (pnl@cross ${r2(t.pnlAtCross)}%)` : ""}`);
}

/* ---- the mirror image: what do the overlays give up? (big winners cut) ---- */
const crossedWinners = trades.filter(t => t.crossDate != null && t.pnl >= 25);
console.log(`\nWINNERS the spyCrossExit overlay would cut early (pnl ≥ +25% with an in-trade SPY cross): ${crossedWinners.length}`);
console.log(`  avg held-to-exit P/L: ${r2(mean(crossedWinners.map(t => t.pnl)))}%  vs avg if exited at the SPY cross: ${r2(mean(crossedWinners.map(t => t.pnlAtCross)))}%`);

writeFileSync(new URL("../../scratchpad/swing-validate/regime-overlay.json", import.meta.url), JSON.stringify({ ...OUT, ugly: ugly.slice(0, 40) }, null, 2));
console.error("\nwrote scratchpad/swing-validate/regime-overlay.json");
