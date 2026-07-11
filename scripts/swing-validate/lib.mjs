/* ===== SWING VALIDATION HARNESS — shared, deterministic primitives ==========
   The common foundation every swing-validate workstream (P1 survivorship, P2
   factor scorecard, P4 calibration, P5 robustness, P6 benchmarks) builds on, so
   the stats can't drift between agents/scripts. Pure + deterministic: it reads a
   dated FMP cache off disk (never the network), reuses the LIVE engine functions
   (short-study.mjs / short-backtest.mjs / quickswing-pipeline.mjs) so every
   reconstruction is byte-identical to what the site ships, and seeds its own PRNG
   so bootstraps reproduce.

   Determinism rules (mirrors §3.7 of the validation plan):
     - No Date.now()/Math.random() in any function whose result is reported.
     - Randomised routines (bootstrap) take an explicit integer seed → LCG.
     - Everything keys off the cache's own bar dates, never the wall clock. */

import { readFileSync, existsSync } from "node:fs";
import { cleanHist, strengthFactor } from "../../netlify/lib/quickswing-pipeline.mjs";
import {
  labelShortTicker, strengthSeries, shortDetailAt, simulateShortExit, swingExitGrid,
  shortExitGridReport, shortAttributionReport, aggregateShortRule,
  mean, median, winRate, pearson, profitFactor, FACTOR_KEYS,
} from "../../netlify/lib/short-study.mjs";

export {
  labelShortTicker, strengthSeries, shortDetailAt, simulateShortExit, swingExitGrid,
  shortExitGridReport, shortAttributionReport, aggregateShortRule,
  mean, median, winRate, pearson, profitFactor, FACTOR_KEYS, cleanHist, strengthFactor,
};

/* ---------- Weighted-composite labeling (#2 — re-backtest a reweighted score) ----------
   Mirrors labelShortTicker's fresh-transition entry logic, but the entry gate is a
   WEIGHTED core score (Σ weights[k]·factor.buy) crossing `threshold`, not the equal
   -weight buyScore≥12. Long-only. `weights` is a partial map over FACTOR_KEYS
   (missing key ⇒ weight 1; set 0 to drop a factor). Reuses the LIVE shortDetailAt so
   the per-bar factor points are byte-identical to the scorer. Returns the same record
   shape as labelShortTicker (+ wScore) so the exit sims / attribution work unchanged. */
const strengthAsOfLocal = (series, date) => { for (const s of series || []) if (s.date <= date) return s.strength; return null; };
export function labelWeighted(sym, hist, spyStr, secStr, { weights = {}, threshold = 12, maxHorizon = 63, minBars = 200, liqGate = 1 } = {}) {
  const out = [];
  if (!Array.isArray(hist) || hist.length < minBars + 2) return out;
  const len = hist.length;
  const w = (k) => (weights[k] == null ? 1 : weights[k]);
  const detail = new Array(len).fill(null);
  for (let i = 0; i < len; i++) {
    const h = hist.slice(i);
    if (h.length < minBars) break;
    detail[i] = shortDetailAt(h, strengthAsOfLocal(spyStr, hist[i].date), strengthAsOfLocal(secStr, hist[i].date));
  }
  const wScoreOf = (d) => d ? d.factors.reduce((s, f) => s + w(f.key) * (f.buy ?? 0), 0) : null;
  const sideOf = (d) => {
    if (!d || d.liqPts < liqGate) return null;
    return wScoreOf(d) >= threshold ? "long" : null;
  };
  for (let i = 0; i < len; i++) {
    const d = detail[i];
    const side = sideOf(d);
    if (!side) continue;
    if (sideOf(detail[i + 1]) === side) continue; // not a fresh transition
    const fwd = [];
    for (let hstep = 1; hstep <= maxHorizon && i - hstep >= 0; hstep++) {
      const j = i - hstep, dj = detail[j] || {};
      fwd.push({ date: hist[j].date, open: hist[j].open, high: hist[j].high, low: hist[j].low, close: hist[j].close,
        sma50: dj.sma50 ?? null, sma200: dj.sma200 ?? null, atr14: dj.atr14 ?? null, side: dj.date ? sideOf(dj) : null });
    }
    if (!fwd.length) continue;
    out.push({ sym, side: "long", entryDate: d.date, entryClose: d.close, entryAtr14: d.atr14 ?? null,
      buyScore: d.buyScore, sellScore: d.sellScore, wScore: wScoreOf(d), factors: d.factors, fwd });
  }
  return out;
}
// Label a whole cache with a weighted composite (parallels labelUniverse).
export function labelUniverseWeighted(cache, opts = {}) {
  const { spyHist, etfBySym, etfHistBySym, histBySym } = cache;
  const spyStr = strengthSeries(spyHist);
  const etfStr = {};
  for (const [etf, h] of Object.entries(etfHistBySym || {})) etfStr[etf] = strengthSeries(h);
  const records = [];
  for (const sym of Object.keys(histBySym)) {
    const hist = histBySym[sym] || [];
    if (ineligible(hist)) continue;
    const etf = etfBySym?.[sym] || null;
    const recs = labelWeighted(sym, hist, spyStr, etf ? (etfStr[etf] || []) : [], opts);
    for (const r of recs) r.etf = etf;
    records.push(...recs);
  }
  return records;
}

/* Sector -> ETF map — identical to short-pipeline.mjs's sectorEtfFor(); keeps
   the harness self-contained so the delisted-name extension can map its own. */
export const INDUSTRY_ETF = { "Semiconductors": "SMH" };
export const SECTOR_ETF = {
  "Technology": "XLK", "Healthcare": "XLV", "Utilities": "XLU", "Industrials": "XLI",
  "Consumer Cyclical": "XLY", "Consumer Defensive": "XLP", "Financial Services": "XLF",
  "Communication Services": "XLC", "Basic Materials": "XLB", "Energy": "XLE", "Real Estate": "XLRE",
};
export const etfFor = (sector, industry) => INDUSTRY_ETF[industry] || SECTOR_ETF[sector] || null;

export const SURVIVOR_CACHE = new URL("../../scratchpad/short-study-cache.json", import.meta.url);
export const PIT_CACHE = new URL("../../scratchpad/swing-validate/pit-cache.json", import.meta.url);

/* ---------- Cache loaders ----------
   Survivor cache: { spyHist, etfBySym, etfHistBySym, histBySym } — the 90-name
   study pull (scripts/run-short-study.mjs). PIT cache adds delisted names +
   their as-of membership window + VIX (built by scripts/swing-validate/pit-universe.mjs). */
export function loadSurvivorCache(url = SURVIVOR_CACHE) {
  if (!existsSync(url)) throw new Error(`survivor cache missing: ${url.pathname} — run scripts/run-short-study.mjs`);
  return JSON.parse(readFileSync(url, "utf8"));
}
export function loadPitCache(url = PIT_CACHE) {
  if (!existsSync(url)) return null;
  return JSON.parse(readFileSync(url, "utf8"));
}

/* ---------- Extra stats the live study lib doesn't carry ---------- */
export function std(a) {
  if (!a || a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1));
}
// Spearman rank correlation — monotonic-relationship measure robust to the
// fat forward-return tails that distort Pearson IC. Average-ranks ties.
export function spearman(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const rank = (arr) => {
    const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(n);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1; // 1-based average rank across the tie block
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  return pearson(rank(xs), rank(ys));
}
export function sharpe(rets, periodsPerYear = null) {
  const s = std(rets), m = mean(rets);
  if (s == null || !s) return null;
  const raw = m / s;
  return periodsPerYear ? raw * Math.sqrt(periodsPerYear) : raw;
}
export function sortino(rets, periodsPerYear = null) {
  const m = mean(rets);
  if (m == null) return null;
  const downs = rets.filter(r => r < 0);
  if (!downs.length) return Infinity;
  const dd = Math.sqrt(downs.reduce((s, x) => s + x * x, 0) / downs.length);
  if (!dd) return null;
  const raw = m / dd;
  return periodsPerYear ? raw * Math.sqrt(periodsPerYear) : raw;
}
// Max drawdown of an equity curve given as a sequence of arithmetic returns (%),
// compounded. Returns a NEGATIVE percentage (peak-to-trough).
export function maxDrawdown(retsPct) {
  let equity = 1, peak = 1, mdd = 0;
  for (const r of retsPct) {
    equity *= (1 + r / 100);
    if (equity > peak) peak = equity;
    const dd = (equity - peak) / peak;
    if (dd < mdd) mdd = dd;
  }
  return mdd * 100;
}

/* ---------- Deterministic PRNG (mulberry32) for reproducible bootstrap ---------- */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Bootstrap the mean of `rets` → { lo, hi, mean } at the given percentile CI.
// Seeded so the interval is byte-reproducible across runs.
export function bootstrapMeanCI(rets, { iters = 2000, ci = 0.95, seed = 12345 } = {}) {
  if (!rets.length) return { lo: null, hi: null, mean: null };
  const rng = makeRng(seed);
  const n = rets.length;
  const means = new Array(iters);
  for (let b = 0; b < iters; b++) {
    let s = 0;
    for (let i = 0; i < n; i++) s += rets[(rng() * n) | 0];
    means[b] = s / n;
  }
  means.sort((a, b) => a - b);
  const loI = Math.floor(((1 - ci) / 2) * iters);
  const hiI = Math.min(iters - 1, Math.floor((1 - (1 - ci) / 2) * iters));
  return { lo: means[loI], hi: means[hiI], mean: mean(rets) };
}
// Bootstrap the max-drawdown DISTRIBUTION of a reshuffled trade sequence.
export function bootstrapMaxDD(retsPct, { iters = 2000, seed = 777 } = {}) {
  if (!retsPct.length) return { median: null, p05: null, worst: null };
  const rng = makeRng(seed);
  const n = retsPct.length;
  const dds = new Array(iters);
  for (let b = 0; b < iters; b++) {
    const shuffled = new Array(n);
    for (let i = 0; i < n; i++) shuffled[i] = retsPct[(rng() * n) | 0];
    dds[b] = maxDrawdown(shuffled);
  }
  dds.sort((a, b) => a - b); // most-negative first
  return { median: dds[Math.floor(iters / 2)], p05: dds[Math.floor(0.05 * iters)], worst: dds[0] };
}

/* ---------- Forward return at an arbitrary horizon (long-only swing) ----------
   rec.fwd is oldest-forward (index 0 = entry+1). H sessions later = fwd[H-1]. */
export function fwdReturnPct(rec, H) {
  const bar = rec.fwd[Math.min(H, rec.fwd.length) - 1];
  if (!bar || !(bar.close > 0) || !(rec.entryClose > 0)) return null;
  const sign = rec.side === "short" ? -1 : 1;
  return sign * ((bar.close - rec.entryClose) / rec.entryClose) * 100;
}

/* ---------- Label an entire cache into entry records ----------
   Wraps labelShortTicker over every eligible name and stamps each record with
   its ETF (sector proxy, for portfolio caps + redundancy). `cache` is either the
   survivor cache or the PIT cache (same shape; PIT adds `membership` per sym). */
const LIQ_MIN_DOLLAR_VOL = 10e6, MIN_BARS = 200;
function medianDollarVol(hist) {
  const dv = hist.slice(0, 60).map(b => (b.close || 0) * (b.volume || 0)).filter(x => x > 0).sort((a, b) => a - b);
  return dv.length ? dv[Math.floor(dv.length / 2)] : 0;
}
export function ineligible(hist) {
  if (!hist || hist.length < MIN_BARS + 5) return `only ${hist?.length ?? 0} bars`;
  if (hist.some(b => !(b.close > 0) || !(b.high >= b.low))) return "bad OHLC bar";
  if (medianDollarVol(hist) < LIQ_MIN_DOLLAR_VOL) return "illiquid";
  return null;
}
export function labelUniverse(cache, {
  longTh = 12, shortTh = 12, bidirectional = false, maxHorizon = 63, minBars = MIN_BARS,
  membershipGate = false,   // PIT: only keep entries whose date is inside [ipoDate, delistedDate]
} = {}) {
  const { spyHist, etfBySym, etfHistBySym, histBySym, membership } = cache;
  const spyStr = strengthSeries(spyHist);
  const etfStr = {};
  for (const [etf, h] of Object.entries(etfHistBySym || {})) etfStr[etf] = strengthSeries(h);

  const records = [];
  const dropped = [];
  for (const sym of Object.keys(histBySym)) {
    const hist = histBySym[sym] || [];
    const reason = ineligible(hist);
    if (reason) { dropped.push(`${sym}: ${reason}`); continue; }
    const etf = etfBySym?.[sym] || null;
    const secStr = etf ? (etfStr[etf] || []) : [];
    let recs = labelShortTicker(sym, hist, spyStr, secStr, { minBars, maxHorizon, longTh, shortTh, bidirectional });
    if (membershipGate && membership?.[sym]) {
      const { ipoDate, delistedDate } = membership[sym];
      recs = recs.filter(r => (!ipoDate || r.entryDate >= ipoDate) && (!delistedDate || r.entryDate <= delistedDate));
    }
    for (const r of recs) r.etf = etf;
    records.push(...recs);
  }
  return { records, dropped };
}

/* ---------- Chronological IS/OOS split (by entry date) ---------- */
export function splitByDate(records, frac = 0.7) {
  const sorted = [...records].sort((a, b) => (a.entryDate < b.entryDate ? -1 : 1));
  const cut = Math.floor(sorted.length * frac);
  return { IS: sorted.slice(0, cut), OOS: sorted.slice(cut), sorted };
}
/* Rolling walk-forward folds: k contiguous chronological blocks; fold i trains on
   blocks <i, tests on block i (expanding window). Returns [{trainEnd, test:[]}]. */
export function walkForwardFolds(records, k = 4) {
  const sorted = [...records].sort((a, b) => (a.entryDate < b.entryDate ? -1 : 1));
  const size = Math.floor(sorted.length / k);
  const folds = [];
  for (let i = 1; i < k; i++) {
    folds.push({ train: sorted.slice(0, i * size), test: sorted.slice(i * size, (i + 1) * size) });
  }
  return folds;
}

/* ---------- Regime classifier ----------
   Per entry date: trend axis = SPY close vs its own 200DMA (bull/bear); vol axis
   = VIX level terciles when a VIX series is supplied, else SPY 20-day realized
   vol terciles. spyHist / vixHist are newest-first. Terciles precomputed once. */
export function buildRegimeContext(spyHist, vixHist = null) {
  const asc = [...spyHist].reverse(); // oldest-first
  const sma200At = {};
  for (let i = 0; i < asc.length; i++) {
    if (i >= 199) {
      let s = 0; for (let k = i - 199; k <= i; k++) s += asc[k].close;
      sma200At[asc[i].date] = s / 200;
    }
  }
  // vol proxy series (date -> value) for tercile cuts
  const volAt = {};
  if (vixHist && vixHist.length) {
    for (const b of vixHist) volAt[b.date] = b.close;
  } else {
    for (let i = 20; i < asc.length; i++) {
      const rets = [];
      for (let k = i - 19; k <= i; k++) rets.push(Math.log(asc[k].close / asc[k - 1].close));
      volAt[asc[i].date] = std(rets) * Math.sqrt(252) * 100;
    }
  }
  const vals = Object.values(volAt).filter(v => v != null).sort((a, b) => a - b);
  const t1 = vals[Math.floor(vals.length / 3)], t2 = vals[Math.floor(2 * vals.length / 3)];
  const spyCloseAt = {};
  for (const b of spyHist) spyCloseAt[b.date] = b.close;
  return { sma200At, volAt, t1, t2, spyCloseAt, spyDates: spyHist.map(b => b.date) };
}
function asOf(map, dates, date) {
  // dates newest-first; first entry <= date
  for (const d of dates) if (d <= date) return map[d];
  return null;
}
export function regimeOf(ctx, date) {
  const spy = asOf(ctx.spyCloseAt, ctx.spyDates, date);
  const sma = asOf(ctx.sma200At, ctx.spyDates, date);
  const vol = asOf(ctx.volAt, ctx.spyDates, date);
  const trend = (spy != null && sma != null) ? (spy >= sma ? "bull" : "bear") : "na";
  const volBucket = vol == null ? "na" : (vol <= ctx.t1 ? "calm" : vol <= ctx.t2 ? "normal" : "stress");
  return { trend, vol: volBucket };
}

/* ---------- Cost model ----------
   Round-trip cost in basis points, subtracted from each trade's pnl%. Swing holds
   are multi-week on liquid large-caps, so costs are small vs expectancy — but we
   sweep a band and report net so sensitivity is visible (mirrors qs-calibrate). */
export const COST_BAND_BPS = [0, 5, 10, 20, 40];
export const applyCost = (pnlPct, bps) => pnlPct - bps / 100;

/* ---------- Capital-constrained portfolio sim ----------
   The as-if log is per-ticker independent; this turns a set of dated trades into
   ONE equity curve under realistic constraints. Event-driven: walk trades in
   entry-date order, open when a slot (and sector budget) is free, equal-$ sizing
   across maxPositions, book pnl at the trade's own exit. Returns aggregate CAGR,
   Sharpe/Sortino (per-trade), maxDD (equity curve), exposure, and the booked
   per-trade returns. `costBps` applied per booked trade. */
export function portfolioSim(records, rule, {
  maxPositions = 8, perSectorMax = 3, costBps = 10, startEquity = 100000,
} = {}) {
  // Build concrete trades with entry/exit dates from the exit rule.
  const trades = [];
  for (const rec of records) {
    const r = simulateShortExit(rec, rule);
    const exitBar = rec.fwd[Math.min(r.hold, rec.fwd.length) - 1];
    if (!exitBar) continue;
    trades.push({
      sym: rec.sym, etf: rec.etf || "?", entryDate: rec.entryDate, exitDate: exitBar.date,
      pnl: applyCost(r.pnl, costBps),
    });
  }
  trades.sort((a, b) => (a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : 0));

  const open = [];            // {exitDate, etf, dollars}
  const booked = [];          // realized per-trade returns (%)
  let equity = startEquity, cash = startEquity;
  const equityCurve = [];     // {date, equity} sampled at each close event
  let skippedFull = 0, skippedSector = 0, taken = 0;
  const dayCount = {};        // date -> #positions open (for exposure)
  const allDates = [...new Set(trades.flatMap(t => [t.entryDate, t.exitDate]))].sort();

  const closeDue = (date) => {
    // exit oldest-first so the equity curve is monotonic in event order
    const due = open.filter(p => p.exitDate <= date).sort((a, b) => (a.exitDate < b.exitDate ? -1 : 1));
    for (const pos of due) {
      const gain = pos.dollars * (pos.pnl / 100);
      cash += pos.dollars + gain; equity += gain;
      booked.push(pos.pnl);
      equityCurve.push({ date: pos.exitDate, equity });
      open.splice(open.indexOf(pos), 1);
    }
  };
  for (const t of trades) {
    closeDue(t.entryDate);                         // free slots that exited by now
    const sectorOpen = open.filter(p => p.etf === t.etf).length;
    if (open.length >= maxPositions) { skippedFull++; continue; }
    if (sectorOpen >= perSectorMax) { skippedSector++; continue; }
    const dollars = equity / maxPositions;         // equal-$ sizing on current equity
    if (dollars > cash) { skippedFull++; continue; }
    cash -= dollars;
    open.push({ exitDate: t.exitDate, etf: t.etf, dollars, pnl: t.pnl });
    taken++;
  }
  // close everything remaining
  const lastDate = allDates[allDates.length - 1] || "9999";
  closeDue(lastDate);

  // exposure: fraction of active days with >=1 position (approx via trade spans)
  for (const d of allDates) {
    dayCount[d] = trades.filter(t => t.entryDate <= d && t.exitDate > d).length;
  }
  const activeDays = Object.values(dayCount).filter(c => c > 0).length;
  const span = allDates.length ? (Date.parse(lastDate) - Date.parse(allDates[0])) / 86400000 : 0;
  const years = span / 365.25;
  const totalReturn = (equity - startEquity) / startEquity;
  const cagr = years > 0 ? (Math.pow(1 + totalReturn, 1 / years) - 1) * 100 : null;

  // Portfolio max drawdown from the ACTUAL dated equity curve (positions are
  // sized at equity/maxPositions and overlap, so compounding raw per-trade
  // returns would wildly overstate DD — walk the equity levels instead).
  let peak = startEquity, portMdd = 0;
  for (const pt of equityCurve) {
    if (pt.equity > peak) peak = pt.equity;
    const dd = (pt.equity - peak) / peak;
    if (dd < portMdd) portMdd = dd;
  }

  return {
    taken, skippedFull, skippedSector,
    finalEquity: Math.round(equity),
    totalReturnPct: totalReturn * 100,
    cagr,
    sharpePerTrade: sharpe(booked),
    sortinoPerTrade: sortino(booked),
    maxDDpct: portMdd * 100,
    avgConcurrent: mean(Object.values(dayCount)),
    exposureFrac: allDates.length ? activeDays / allDates.length : null,
    nBooked: booked.length,
    years: Math.round(years * 10) / 10,
  };
}

/* ---------- Aggregate a rule net-of-cost (extends aggregateShortRule) ---------- */
export function aggregateNet(records, rule, spyHist, costBps = 10) {
  const base = aggregateShortRule(records, rule, spyHist);
  const rets = records.map(rec => {
    const r = simulateShortExit(rec, rule);
    return applyCost(r.pnl, costBps);
  });
  return { ...base, netExpectancy: mean(rets), netWinRate: winRate(rets), costBps };
}

/* ---------- Deflated-Sharpe / multiple-testing haircut ----------
   Given the number of independent configs tried (nTrials) and a chosen config's
   t-stat, a crude Bonferroni-style sanity flag: is the edge still significant
   after correcting for the search? Returns { tStat, pBonferroni, survives }. */
export function multipleTestingCheck(rets, nTrials) {
  const m = mean(rets), s = std(rets), n = rets.length;
  if (m == null || s == null || !s || n < 3) return { tStat: null, survives: false };
  const tStat = m / (s / Math.sqrt(n));
  // two-sided normal-approx p, then Bonferroni over nTrials
  const p = 2 * (1 - normCdf(Math.abs(tStat)));
  const pBonf = Math.min(1, p * Math.max(1, nTrials));
  return { tStat, p, pBonferroni: pBonf, survives: pBonf < 0.05 };
}
function normCdf(x) {
  // Abramowitz-Stegun 7.1.26
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989423 * Math.exp(-x * x / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return x > 0 ? 1 - p : p;
}

export const round = (x, d = 2) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);
