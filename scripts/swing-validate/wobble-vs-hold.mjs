/* Wobble-vs-Hold — should we SELL when the 5-gate entry signal lapses and
   RE-ENTER when it re-fires, instead of holding through the wobble?

   For every real v6.2 entry (fresh flat→entryStrong, WITH the rs126 SPY floor),
   over the SAME window [entry → shipped terminal], compare:
     A (HOLD, shipped)  : buy at entry, hold until the shipped exit fires
                          (40% catastrophe stop → 50/200 death cross → 189d TIME).
     B (WOBBLE)         : buy at entry; SELL at the close the moment entryStrong
                          goes false; sit in CASH (0%); RE-BUY at the close when
                          entryStrong fires again; … same 40% stop per sub-position;
                          same terminal as A. B's return = compounded sub-trades.
   Cash earns 0% (standard, conservative). Frictionless EOD fills = engine parity;
   turnover is reported so real-world cost/tax drag is visible.

   Tests the user's thesis directly: does B "sell high, rebuy lower"? → measured as
   the price change from each wobble-exit to the next re-entry.
   Splits: ALL / IS(<2017) / OOS(≥2017) / BEAR entry (SPY<200DMA at entry). */

import { readFileSync, writeFileSync } from "node:fs";
import { computeShortSignal, strengthSeriesFor, ret126SeriesFor,
         SBT_HARD_STOP_PCT, SBT_TIME_STOP_DAYS } from "../../netlify/lib/short-backtest.mjs";

const CACHE = new URL("../../scratchpad/swing-validate/deep-cache.json", import.meta.url);
const MINFWD = 200;              // forward bars needed so the 189d TIME backstop completes
const H = SBT_TIME_STOP_DAYS;    // 189 — shipped backstop behind the death cross
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
const spyR126 = ret126SeriesFor(spyHist);
const etfStr = {};
for (const [etf, h] of Object.entries(etfHistBySym || {})) etfStr[etf] = strengthSeriesFor(h);
// SPY 200DMA (for bear tagging)
const spyAsc = [...spyHist].reverse();
const spy200 = {}; { let s = 0; for (let i = 0; i < spyAsc.length; i++) { s += spyAsc[i].close; if (i >= 200) s -= spyAsc[i - 200].close; if (i >= 199) spy200[spyAsc[i].date] = s / 200; } }
const spyDatesDesc = spyHist.map(b => b.date);
const spy200AsOf = d => { for (const dt of spyDatesDesc) if (dt <= d) { if (spy200[dt] != null) return spy200[dt]; } return null; };

console.error("labeling entries (v6.2 gate WITH rs126) + simulating A vs B…");
const episodes = [];
const names = Object.keys(histBySym); let done = 0;
for (const sym of names) {
  const hist = histBySym[sym]; if (!hist || hist.length < 220) { done++; continue; }
  const etf = etfBySym?.[sym] || null; const secStr = etf ? (etfStr[etf] || []) : [];
  const lastScorable = hist.length - 200;          // desc index; i=0 newest
  // per-desc-index v6.2 signal
  const strong = new Array(lastScorable + 1).fill(false);
  const dc = new Array(lastScorable + 1).fill(false);
  for (let i = 0; i <= lastScorable; i++) {
    const sig = computeShortSignal(hist.slice(i, i + 260), {
      spyStrength: strengthAsOf(spyStr, hist[i].date),
      sectorStrength: strengthAsOf(secStr, hist[i].date),
      spyRet126: strengthAsOf(spyR126, hist[i].date),
    });
    if (sig) { strong[i] = !!sig.entryStrong; dc[i] = !!sig.deathCross; }
  }
  // ascending views
  const bars = [...hist].reverse(); const ascN = bars.length;
  const strongAsc = i => strong[ascN - 1 - i];     // i = ascending index
  const dcAsc = i => dc[ascN - 1 - i];
  const scorableAsc = i => (ascN - 1 - i) <= lastScorable && (ascN - 1 - i) >= 0;

  for (let ei = 0; ei < ascN; ei++) {
    if (!scorableAsc(ei) || !scorableAsc(ei - 1)) continue;
    if (!strongAsc(ei) || strongAsc(ei - 1)) continue;       // fresh flat→strong
    if (ei + MINFWD > ascN - 1) continue;                    // need forward runway
    const entryPx = bars[ei].close, entryDate = bars[ei].date;
    const hardStopA = entryPx * (1 - SBT_HARD_STOP_PCT);

    // ---- terminal (shipped exit) = strategy A ----
    let termK = null, termReason = null;
    const end = Math.min(ascN - 1, ei + MINFWD);
    for (let k = ei + 1; k <= end; k++) {
      const bar = bars[k], day = k - ei, low = bar.low ?? bar.close, open = bar.open ?? bar.close;
      if (low <= hardStopA) { termK = k; termReason = "STOP"; break; }
      if (scorableAsc(k) && dcAsc(k)) { termK = k; termReason = "CROSS"; break; }
      if (day >= H) { termK = k; termReason = "TIME"; break; }
    }
    if (termK == null) { termK = end; termReason = "EOD"; }
    const termDate = bars[termK].date;
    const retA = (bars[termK].close - entryPx) / entryPx * 100;

    // ---- strategy B (wobble in/out on entryStrong within [ei, termK]) ----
    let inPos = true, buyPx = entryPx, factor = 1, rt = 0, barsIn = 0;
    let lastExitPx = null; const rebuyDeltas = [];
    for (let k = ei + 1; k <= termK; k++) {
      const bar = bars[k], low = bar.low ?? bar.close, open = bar.open ?? bar.close;
      if (inPos) {
        barsIn++;
        // per-sub-position catastrophe stop
        const subStop = buyPx * (1 - SBT_HARD_STOP_PCT);
        if (low <= subStop) { const f = open <= subStop ? open : subStop; factor *= f / buyPx; rt++; inPos = false; lastExitPx = f; continue; }
        // signal lapsed → sell at close (unless this is the terminal bar, handled below)
        if (k < termK && scorableAsc(k) && !strongAsc(k)) { factor *= bar.close / buyPx; rt++; inPos = false; lastExitPx = bar.close; }
      } else {
        // re-enter when the signal fires again
        if (k < termK && scorableAsc(k) && strongAsc(k)) { buyPx = bar.close; inPos = true; if (lastExitPx != null) rebuyDeltas.push((buyPx - lastExitPx) / lastExitPx * 100); }
      }
    }
    if (inPos) { factor *= bars[termK].close / buyPx; rt++; barsIn++; } // close out at terminal
    const retB = (factor - 1) * 100;
    const windowBars = termK - ei;
    const timeInMkt = windowBars > 0 ? barsIn / windowBars : 1;

    const sc = spyCloseAsOf(spyHist, entryDate), sm = spy200AsOf(entryDate);
    episodes.push({
      sym, date: entryDate, year: +entryDate.slice(0, 4),
      bear: sc != null && sm != null ? sc < sm : null,
      retA, retB, termReason, roundTrips: rt, timeInMkt,
      spy: spyRet(spyHist, entryDate, termDate),
      rebuyDeltas,
    });
  }
  if (++done % 50 === 0) console.error(`  ${done}/${names.length}  episodes=${episodes.length}`);
}
console.error(`\ntotal episodes n=${episodes.length}`);

function agg(subset) {
  const A = subset.map(e => e.retA), B = subset.map(e => e.retB);
  const edgeA = subset.filter(e => e.spy != null).map(e => e.retA - e.spy);
  const edgeB = subset.filter(e => e.spy != null).map(e => e.retB - e.spy);
  const bBeatA = subset.filter(e => e.retB > e.retA).length;
  const diffs = subset.map(e => e.retB - e.retA);
  const allRebuys = subset.flatMap(e => e.rebuyDeltas);
  const lower = allRebuys.filter(d => d < 0).length;
  return {
    n: subset.length,
    avgA: r2(mean(A)), avgB: r2(mean(B)), medA: r2(median(A)), medB: r2(median(B)),
    winA: share(A.filter(x => x > 0).length, A.length), winB: share(B.filter(x => x > 0).length, B.length),
    worstA: r2(Math.min(...A)), worstB: r2(Math.min(...B)),
    edgeA: r2(mean(edgeA)), edgeB: r2(mean(edgeB)),
    bBeatA: share(bBeatA, subset.length), avgDiff: r2(mean(diffs)), medDiff: r2(median(diffs)),
    avgRT: r2(mean(subset.map(e => e.roundTrips))), timeInMkt: share(mean(subset.map(e => e.timeInMkt)), 1) / 100 == null ? null : r2(100 * mean(subset.map(e => e.timeInMkt))),
    nRebuys: allRebuys.length, rebuyLowerPct: share(lower, allRebuys.length), avgRebuyDelta: r2(mean(allRebuys)),
  };
}

const splits = {
  "ALL": episodes,
  "IS <2017": episodes.filter(e => e.year < 2017),
  "OOS ≥2017": episodes.filter(e => e.year >= 2017),
  "BEAR entry": episodes.filter(e => e.bear),
  "BULL entry": episodes.filter(e => e.bear === false),
};
const out = { meta: { newest: spyHist[0].date, oldest: spyHist[spyHist.length - 1].date, episodes: episodes.length, H, minFwd: MINFWD }, splits: {} };
const pc = (x) => (x >= 0 ? "+" : "") + x + "%";
console.log(`\n${"=".repeat(120)}`);
console.log(`WOBBLE (B: sell on signal-lapse, rebuy on re-fire) vs HOLD (A: shipped death-cross/189d/40% exit)`);
console.log(`entry = v6.2 gate incl. rs126 · frictionless EOD · cash=0% · window = entry→shipped terminal (≤189d)\n`);
for (const [label, subset] of Object.entries(splits)) {
  const a = agg(subset); out.splits[label] = a;
  console.log(`── ${label}  (n=${a.n}) ${"─".repeat(Math.max(0, 90 - label.length))}`);
  console.log(`   avg return   HOLD ${pc(a.avgA).padStart(8)}   WOBBLE ${pc(a.avgB).padStart(8)}     Δ(W−H) ${pc(a.avgDiff).padStart(8)}  (median Δ ${pc(a.medDiff)})`);
  console.log(`   median ret   HOLD ${pc(a.medA).padStart(8)}   WOBBLE ${pc(a.medB).padStart(8)}`);
  console.log(`   win rate     HOLD ${(a.winA+"%").padStart(8)}   WOBBLE ${(a.winB+"%").padStart(8)}`);
  console.log(`   worst        HOLD ${pc(a.worstA).padStart(8)}   WOBBLE ${pc(a.worstB).padStart(8)}`);
  console.log(`   edge vs SPY  HOLD ${pc(a.edgeA).padStart(8)}   WOBBLE ${pc(a.edgeB).padStart(8)}`);
  console.log(`   wobble beat hold in ${a.bBeatA}% of episodes · avg ${a.avgRT} round-trips · ${a.timeInMkt}% time in market`);
  console.log(`   rebuy-lower thesis: ${a.rebuyLowerPct}% of ${a.nRebuys} re-entries were BELOW the prior exit · avg rebuy move ${pc(a.avgRebuyDelta)}\n`);
}
writeFileSync(new URL("../../scratchpad/swing-validate/wobble-vs-hold.json", import.meta.url), JSON.stringify(out, null, 2));
console.error("wrote scratchpad/swing-validate/wobble-vs-hold.json");
