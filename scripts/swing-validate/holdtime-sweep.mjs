/* Hold-time sensitivity sweep for the SHIPPED swing engine.
   Question: what happens to the swing backtest as we widen the time-stop from the
   current 63-session (~3mo) hold out to 12 months, in ~1-month (21-session) steps?

   Faithful to the live engine:
     - Entry: the exact shipped gate — computeShortSignal(...).entryStrong
       (techScore>=12 AND px>50DMA>200DMA AND avgDollarVol>=$300M/day), long-only,
       one sample per FRESH strong transition (prev bar not entryStrong). This is
       the standard exit-study convention (independent, overlap-allowed entries)
       so the ONLY thing changing across columns is the hold horizon.
     - Exit: the shipped v4 stack — a 40% hard catastrophe stop (day's low pierces
       entry*0.60, pessimistic gap-fill at open) then a TIME cap at H sessions.
       No death-cross, no ATR, no take-profit (matches short-backtest.mjs).
     - Benchmark: SPY buy-and-hold over each trade's own entry->exit window.

   Two cohorts, because the cache is finite (newest bar 2026-07-07):
     ALL      — every entry, truncated to available runway (EOD exit if < H bars
                remain). The reason-mix column shows how much truncation there is.
     COHORT252— only entries with >=252 forward bars available, so EVERY horizon is
                measured on the SAME trades. This is the clean apples-to-apples test
                of "does holding longer help?", with no entry-mix / truncation confound.

   Pure/off-cache; reuses the live computeShortSignal + strengthFactor so the entry
   set is byte-identical to what the site ships. */

import { readFileSync } from "node:fs";
import { computeShortSignal, strengthSeriesFor } from "../../netlify/lib/short-backtest.mjs";

const CACHE = new URL("../../scratchpad/swing-validate/universe500-cache.json", import.meta.url);
const HARD_STOP_PCT = 0.40;
const HORIZONS = [63, 84, 105, 126, 147, 168, 189, 210, 231, 252]; // 3..12 months (~21 sessions/mo)
const FULL_RUNWAY = 252;

const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
const winRate = a => (a.length ? a.filter(x => x > 0).length / a.length : null);
const r2 = x => (x == null ? null : Math.round(x * 100) / 100);
const strengthAsOf = (series, date) => { for (const s of series) if (s.date <= date) return s.strength; return null; };
const spyCloseAsOf = (spyHist, date) => { for (const b of spyHist) if (b.date <= date) return b.close ?? b.price; return null; };
function spyRet(spyHist, entryDate, exitDate) {
  const e = spyCloseAsOf(spyHist, entryDate), x = spyCloseAsOf(spyHist, exitDate);
  if (!(e > 0) || !(x > 0)) return null;
  return ((x - e) / e) * 100;
}

console.error("loading cache…");
const c = JSON.parse(readFileSync(CACHE, "utf8"));
const { spyHist, etfBySym, etfHistBySym, histBySym } = c;
const spyStr = strengthSeriesFor(spyHist);
const etfStr = {};
for (const [etf, h] of Object.entries(etfHistBySym || {})) etfStr[etf] = strengthSeriesFor(h);

// ---- Build the entry records (shipped entry gate) with a 252-bar forward window.
const records = [];
const names = Object.keys(histBySym);
let done = 0;
for (const sym of names) {
  const hist = histBySym[sym] || [];
  if (hist.length < 205) { done++; continue; }
  const etf = etfBySym?.[sym] || null;
  const secStr = etf ? (etfStr[etf] || []) : [];
  const len = hist.length;
  // entryStrong at each index (0 = newest). Need >=200 bars of history in the slice.
  const strong = new Array(len).fill(false);
  const lastScorable = len - 200;
  for (let i = 0; i <= lastScorable; i++) {
    const date = hist[i].date;
    const sig = computeShortSignal(hist.slice(i), {
      spyStrength: strengthAsOf(spyStr, date),
      sectorStrength: strengthAsOf(secStr, date),
    });
    strong[i] = !!(sig && sig.entryStrong);
  }
  // fresh transition: strong[i] && !strong[i+1] (i+1 is the older/prior session)
  for (let i = 0; i <= lastScorable; i++) {
    if (!strong[i]) continue;
    if (i + 1 <= lastScorable && strong[i + 1]) continue; // persistent, not fresh
    const entryClose = hist[i].close;
    if (!(entryClose > 0)) continue;
    const fwd = [];
    for (let j = i - 1; j >= 0 && (i - j) <= FULL_RUNWAY; j--) {
      const b = hist[j];
      fwd.push({ date: b.date, open: b.open ?? b.close, high: b.high ?? b.close, low: b.low ?? b.close, close: b.close });
    }
    if (!fwd.length) continue;
    records.push({ sym, etf, entryDate: hist[i].date, entryClose, runway: fwd.length, fwd });
  }
  if (++done % 50 === 0) console.error(`  ${done}/${names.length} names, ${records.length} entries`);
}
console.error(`entries: ${records.length}  (cohort252: ${records.filter(r => r.runway >= FULL_RUNWAY).length})`);

// ---- Exit sim: 40% hard catastrophe stop, then TIME cap at H. Mirrors recordShortTransition.
function simExit(rec, H) {
  const entry = rec.entryClose;
  const stop = entry * (1 - HARD_STOP_PCT);
  for (let k = 0; k < rec.fwd.length; k++) {
    const bar = rec.fwd[k];
    const day = k + 1;
    // catastrophe stop: day's low pierces the line; gap-through at open fills at open.
    const low = bar.low > 0 ? bar.low : bar.close;
    if (low <= stop) {
      const fill = (bar.open > 0 && bar.open <= stop) ? bar.open : stop;
      return { pnl: ((fill - entry) / entry) * 100, hold: day, exitDate: bar.date, reason: "STOP" };
    }
    if (day >= H) return { pnl: ((bar.close - entry) / entry) * 100, hold: day, exitDate: bar.date, reason: "TIME" };
  }
  const last = rec.fwd[rec.fwd.length - 1];
  return { pnl: ((last.close - entry) / entry) * 100, hold: rec.fwd.length, exitDate: last.date, reason: "EOD" };
}

function aggregate(recs, H) {
  const rets = [], holds = [], spys = [], edges = [];
  const reasons = { STOP: 0, TIME: 0, EOD: 0 };
  for (const rec of recs) {
    const r = simExit(rec, H);
    rets.push(r.pnl); holds.push(r.hold); reasons[r.reason]++;
    const s = spyRet(spyHist, rec.entryDate, r.exitDate);
    if (s != null) { spys.push(s); edges.push(r.pnl - s); }
  }
  const avg = mean(rets), avgHold = mean(holds);
  const cum = rets.reduce((s, x) => s + 10000 * (x / 100), 0); // fixed $10k/trade, summed
  return {
    H, n: rets.length,
    winPct: r2(winRate(rets) * 100),
    avgPnl: r2(avg),
    medHold: median(holds),
    perDay: r2(avg != null && avgHold ? avg / avgHold : null),
    avgSpy: r2(mean(spys)),
    edge: r2(mean(edges)),
    best: r2(Math.max(...rets)),
    worst: r2(Math.min(...rets)),
    cum$: Math.round(cum),
    pctTIME: r2((reasons.TIME / rets.length) * 100),
    pctSTOP: r2((reasons.STOP / rets.length) * 100),
    pctEOD: r2((reasons.EOD / rets.length) * 100),
  };
}

const all = records;
const cohort = records.filter(r => r.runway >= FULL_RUNWAY);

const out = {
  meta: { cacheNewest: spyHist[0].date, cacheOldest: spyHist[spyHist.length - 1].date,
          names: names.length, entriesAll: all.length, entriesCohort252: cohort.length,
          entryGate: "shipped computeShortSignal.entryStrong (tech>=12 & px>50>200 & $vol>=300M)",
          exit: "40% hard stop + TIME cap at H; long-only", months: HORIZONS.map(h => Math.round(h / 21)) },
  monthsByH: Object.fromEntries(HORIZONS.map(h => [h, Math.round(h / 21)])),
  ALL: HORIZONS.map(H => aggregate(all, H)),
  COHORT252: HORIZONS.map(H => aggregate(cohort, H)),
};

const fmt = rows => {
  const cols = ["H", "mo", "n", "winPct", "avgPnl", "perDay", "avgSpy", "edge", "medHold", "best", "worst", "cum$", "pctTIME", "pctSTOP", "pctEOD"];
  console.log(cols.join("\t"));
  for (const r of rows) console.log([r.H, Math.round(r.H / 21), r.n, r.winPct, r.avgPnl, r.perDay, r.avgSpy, r.edge, r.medHold, r.best, r.worst, r.cum$, r.pctTIME, r.pctSTOP, r.pctEOD].join("\t"));
};

console.log("\n===== ALL ENTRIES (truncated to runway; watch pctEOD) =====");
fmt(out.ALL);
console.log("\n===== COHORT252 (same trades every row; >=252 bars runway) — the clean test =====");
fmt(out.COHORT252);

const outPath = new URL("../../scratchpad/swing-validate/holdtime-sweep.json", import.meta.url);
const { writeFileSync } = await import("node:fs");
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.error(`\nwrote ${outPath.pathname}`);
