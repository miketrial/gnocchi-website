/* ===== SWING (Short-Term) — offline study harness (analysis only, not deployed)
   =========================================================================
   Purpose: decide, from ~2y of real FMP EOD history, how a Bounce-parity "as-if"
   trade log for the SWING (1wk-3mo) screener should behave — specifically
     (a) LONG-ONLY vs BIDIRECTIONAL (does shorting weak trend-breakers add value
         or just bleed?), and
     (b) which EXIT rule best fits the multi-week horizon (a trailing/trend-break
         exit, not Bounce's "first favorable close" take-profit, which is tuned
         for a 1-2 day hold and would choke a trend trade).

   The live swing scorer (short-pipeline.mjs) scores 11 factors, 5 of which are
   fundamental (analyst revisions, valuation, quality, leverage, catalyst) and
   CANNOT be reconstructed at a past date without point-in-time fundamentals. So
   — exactly like the Bounce study, which reconstructs only its EOD-computable
   factors — this harness reconstructs the 6 PRICE/VOLUME factors that drive
   entry timing:

     1. Trend        (price vs 50/200 DMA)
     2. 3M Momentum  (63-day return)
     3. Extreme      (near 52w high for longs / near 52w low for shorts)
     4. Liquidity    (20-day avg $-volume — a gate, feeds both sides)
     5. Volume Surge (recent-day surge + 10-day money flow)
     6. Sector RS    (sector ETF weighted-ROC minus SPY's)

   Each factor is scored on BOTH sides: a long-side "buy" score (uptrend, positive
   momentum, near-high, sector leading, accumulation) and a mirrored short-side
   "sell" score (downtrend, negative momentum, near-low, sector lagging,
   distribution). The long side is byte-identical to short-pipeline.mjs's factor
   thresholds; the short side is the symmetric mirror (there is no live short-side
   scorer to match yet — that's exactly what this study is deciding).

   Removable with the swing backtest feature. Pure functions; the runner
   (scripts/run-short-study.mjs) does the FMP I/O. */

import { atrFrom } from "./ta-helpers.mjs";
import { strengthFactor } from "./quickswing-pipeline.mjs";

/* ---------- stats helpers ---------- */
export function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
export function median(a) {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor((s.length - 1) / 2)];
}
export function winRate(a) { return a.length ? a.filter(x => x > 0).length / a.length : null; }
export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; num += a * b; dx += a * a; dy += b * b; }
  const den = Math.sqrt(dx * dy);
  return den > 0 ? num / den : null;
}
export function profitFactor(rets) {
  let win = 0, loss = 0;
  for (const r of rets) { if (r > 0) win += r; else loss += -r; }
  return loss > 0 ? win / loss : (win > 0 ? Infinity : null);
}

export const FACTOR_KEYS = ["TREND", "MOM", "EXTREME", "LIQ", "VOL", "SECRS"];

/* ---------- SPY / sector strength "as of" series ----------
   strengthFactor(hist.slice(i)) is the IBD-style weighted ROC as of hist[i].date.
   Precompute it at every index once (keyed by date), then a ticker bar dated D
   looks up the most recent index-strength with date <= D. */
export function strengthSeries(hist) {
  const out = [];
  if (!Array.isArray(hist)) return out;
  for (let i = 0; i < hist.length; i++) {
    out.push({ date: hist[i].date, strength: strengthFactor(hist.slice(i)) });
  }
  return out; // newest-first, same order as hist
}
function strengthAsOf(series, date) {
  // series newest-first; first entry dated <= date is the most recent as-of value
  for (const s of series) if (s.date <= date) return s.strength;
  return null;
}

/* ---------- Bidirectional factor reconstruction ----------
   `h` is a newest-first OHLCV slice with index 0 = the as-of bar. Each helper
   returns { buy, sell, ... } where buy/sell are 0-3 points (or 0 when n/a — we
   keep n/a as 0 here, matching how the live score sums null-as-0). */

// 1. Trend — long buys clean uptrends; short mirrors clean downtrends.
function fTrend(h) {
  if (!h || h.length < 200) return null;
  const closes = h.slice(0, 220).map(d => d.close);
  if (closes.length < 200) return null;
  const sma = n => { let s = 0; for (let k = 0; k < n; k++) s += closes[k]; return s / n; };
  const price = closes[0], sma50 = sma(50), sma200 = sma(200);
  const above = (price - sma50) / sma50, below = (sma50 - price) / sma50;
  let buy;
  if (price > sma50 && sma50 > sma200 && above >= 0.08) buy = 3;
  else if (price > sma50 && sma50 > sma200)             buy = 2;
  else if (price > sma50)                               buy = 1;
  else                                                  buy = 0;
  let sell;
  if (price < sma50 && sma50 < sma200 && below >= 0.08) sell = 3;
  else if (price < sma50 && sma50 < sma200)             sell = 2;
  else if (price < sma50)                               sell = 1;
  else                                                  sell = 0;
  return { buy, sell, sma50, sma200, price };
}

// 2. 3M Momentum — 63-day return, mirrored.
function fMomentum(h) {
  if (!h || h.length < 65) return null;
  const closes = h.slice(0, 70).map(d => d.close);
  if (closes.length < 63) return null;
  const now = closes[0], then = closes[62];
  if (!then || then <= 0) return null;
  const ret = now / then - 1;
  if (!(ret >= -0.95 && ret <= 10)) return null; // sanity, mirrors SHORT_SANITY.ret3m
  let buy;
  if (ret >= 0.15) buy = 3; else if (ret >= 0.05) buy = 2; else if (ret >= 0) buy = 1; else buy = 0;
  let sell;
  if (ret <= -0.15) sell = 3; else if (ret <= -0.05) sell = 2; else if (ret <= 0) sell = 1; else sell = 0;
  return { buy, sell, ret };
}

// 3. Extreme — long: near the 52w high; short: near the 52w low.
function fExtreme(h) {
  if (!h || h.length < 200) return null;
  const closes = h.slice(0, 260).map(d => d.close);
  if (closes.length < 200) return null;
  const now = closes[0], high = Math.max(...closes), low = Math.min(...closes);
  const offHigh = (high - now) / high, offLow = (now - low) / low;
  let buy;
  if (offHigh <= 0.05) buy = 3; else if (offHigh <= 0.15) buy = 2; else if (offHigh <= 0.30) buy = 1; else buy = 0;
  let sell;
  if (offLow <= 0.05) sell = 3; else if (offLow <= 0.15) sell = 2; else if (offLow <= 0.30) sell = 1; else sell = 0;
  return { buy, sell, offHigh, offLow };
}

// 4. Liquidity — 20-day avg $-volume. A gate: feeds both sides equally.
function fLiquidity(h) {
  if (!h || h.length < 20) return null;
  const dv = h.slice(0, 20).map(d => (d.close ?? 0) * (d.volume ?? 0)).filter(v => v > 0);
  if (!dv.length) return null;
  const avg = dv.reduce((s, x) => s + x, 0) / dv.length;
  let pts;
  if (avg >= 100e6) pts = 3; else if (avg >= 20e6) pts = 2; else if (avg >= 10e6) pts = 1; else pts = 0;
  return { buy: pts, sell: pts, avgDollarVol: avg };
}

// 5. Volume Surge — recent-day surge (rv) + 10-day money flow, scored as
//    confluence. Long = accumulation; short = distribution (mirror).
function fVolume(h) {
  if (!h || h.length < 21) return null;
  const h0 = h[0], h1 = h[1];
  const recentVol = h0?.volume, recentClose = h0?.close, priorClose = h1?.close;
  if (recentVol == null || recentClose == null || priorClose == null) return null;
  const vols = h.slice(1, 21).map(d => d.volume).filter(v => v > 0);
  if (vols.length < 15) return null;
  const avg20 = vols.reduce((s, x) => s + x, 0) / vols.length;
  const rv = recentVol / avg20;
  if (!(rv >= 0 && rv <= 50)) return null;
  const dir = Math.sign(recentClose - priorClose);
  const isUp = dir > 0, isDown = dir < 0;

  let upD = 0, dnD = 0, look = 0;
  if (h.length >= 11) {
    for (let i = 0; i < 10; i++) {
      const t = h[i], p = h[i + 1];
      if (!t || !p) break;
      const c = t.close, pc = p.close, v = t.volume;
      if (c == null || pc == null || v == null || v <= 0) continue;
      const d = c * v;
      if (c > pc) upD += d; else if (c < pc) dnD += d;
      look++;
    }
  }
  const total = upD + dnD;
  const flow = look >= 6 && total > 0 ? (upD - dnD) / total : null;
  const sustBuy = flow != null && flow >= 0.3;
  const sustSell = flow != null && flow <= -0.3;
  const mildBuy = flow != null && flow >= 0.1;
  const mildSell = flow != null && flow <= -0.1;

  // Long (accumulation) — mirrors checkVolumeSurge's buy ladder.
  let buy;
  if (rv >= 1.5 && isDown) buy = 0;
  else if (sustSell) buy = 0;
  else if (rv >= 2.5 && isUp && sustBuy) buy = 3;
  else if (rv >= 1.5 && isUp && sustBuy) buy = 3;
  else if (rv >= 2.5 && isUp) buy = 3;
  else if (rv >= 1.5 && isUp && mildBuy) buy = 2;
  else if (rv >= 1.5 && isUp) buy = 2;
  else if (sustBuy && rv >= 0.8) buy = 2;
  else if (rv >= 2.5) buy = 1;
  else if (mildBuy && rv >= 0.8) buy = 1;
  else if (rv >= 0.8) buy = 1;
  else buy = 0;

  // Short (distribution) — the symmetric mirror.
  let sell;
  if (rv >= 1.5 && isUp) sell = 0;
  else if (sustBuy) sell = 0;
  else if (rv >= 2.5 && isDown && sustSell) sell = 3;
  else if (rv >= 1.5 && isDown && sustSell) sell = 3;
  else if (rv >= 2.5 && isDown) sell = 3;
  else if (rv >= 1.5 && isDown && mildSell) sell = 2;
  else if (rv >= 1.5 && isDown) sell = 2;
  else if (sustSell && rv >= 0.8) sell = 2;
  else if (rv >= 2.5) sell = 1;
  else if (mildSell && rv >= 0.8) sell = 1;
  else if (rv >= 0.8) sell = 1;
  else sell = 0;

  return { buy, sell, rv, flow };
}

// 6. Sector RS — sector-ETF strength minus SPY strength (passed in as-of values).
function fSectorRS(sectorStrength, spyStrength) {
  if (sectorStrength == null || spyStrength == null) return null;
  const delta = sectorStrength - spyStrength;
  let buy;
  if (delta >= 0.15) buy = 3; else if (delta >= 0.08) buy = 2; else if (delta >= -0.03) buy = 1; else buy = 0;
  let sell;
  if (delta <= -0.15) sell = 3; else if (delta <= -0.08) sell = 2; else if (delta <= 0.03) sell = 1; else sell = 0;
  return { buy, sell, delta };
}

/* Full replayable swing detail at one bar. Returns per-side scores (0-18),
   per-factor buy/sell points (for attribution), and the bar's OHLC + moving
   averages + ATR14 (for the exit sim). null when history is too short to score. */
export function shortDetailAt(h, spyStrength, sectorStrength) {
  const trend = fTrend(h);
  if (!trend) return null; // trend needs 200 bars — our minimum
  const mom = fMomentum(h);
  const ext = fExtreme(h);
  const liq = fLiquidity(h);
  const vol = fVolume(h);
  const secrs = fSectorRS(sectorStrength, spyStrength);

  const parts = { TREND: trend, MOM: mom, EXTREME: ext, LIQ: liq, VOL: vol, SECRS: secrs };
  let buyScore = 0, sellScore = 0;
  const factors = [];
  for (const key of FACTOR_KEYS) {
    const p = parts[key];
    const buy = p?.buy ?? 0, sell = p?.sell ?? 0;
    buyScore += buy; sellScore += sell;
    factors.push({ key, buy, sell });
  }
  const b0 = h[0];
  return {
    date: b0.date, open: b0.open, high: b0.high, low: b0.low, close: b0.close,
    buyScore, sellScore, factors,
    sma50: trend.sma50, sma200: trend.sma200,
    atr14: atrFrom(h, 0, 14),
    liqPts: liq?.buy ?? 0,
  };
}

/* ---------- Labeling ----------
   Precompute detail at every index, then find fresh directional transitions and
   attach forward bars. A bar's "side":
     long  if buyScore  >= longTh  and buyScore  > sellScore
     short if sellScore >= shortTh and sellScore > buyScore   (bidirectional only)
     else null
   An ENTRY is a bar whose side differs from the previous session's side — one
   sample per swing episode, not one per persistent day. Entries are treated as
   independent events (overlap allowed) to measure rule quality with max samples.

   Eligibility: liquidity gate (liqPts >= 1, i.e. >= $10M/day) so the study isn't
   dominated by untradeable names, matching the live screener's spirit. */
export function labelShortTicker(sym, hist, spyStrSeries, sectorStrSeries, {
  minBars = 200, maxHorizon = 63, longTh = 12, shortTh = 12, bidirectional = true, liqGate = 1,
} = {}) {
  const out = [];
  if (!Array.isArray(hist) || hist.length < minBars + 2) return out;
  const len = hist.length;

  const detail = new Array(len).fill(null);
  for (let i = 0; i < len; i++) {
    const h = hist.slice(i);
    if (h.length < minBars) break; // once too short, every older index is too short
    const spyStr = strengthAsOf(spyStrSeries, hist[i].date);
    const secStr = strengthAsOf(sectorStrSeries, hist[i].date);
    detail[i] = shortDetailAt(h, spyStr, secStr);
  }

  const sideOf = (d) => {
    if (!d || d.liqPts < liqGate) return null;
    if (d.buyScore >= longTh && d.buyScore > d.sellScore) return "long";
    if (bidirectional && d.sellScore >= shortTh && d.sellScore > d.buyScore) return "short";
    return null;
  };

  for (let i = 0; i < len; i++) {
    const d = detail[i];
    if (!d) continue;
    const side = sideOf(d);
    if (!side) continue;
    const prevSide = sideOf(detail[i + 1]); // i+1 is the prior (older) session
    if (prevSide === side) continue; // persistent, not a fresh transition

    const fwd = [];
    for (let hstep = 1; hstep <= maxHorizon && i - hstep >= 0; hstep++) {
      const j = i - hstep;
      const dj = detail[j] || {};
      fwd.push({
        date: hist[j].date, open: hist[j].open, high: hist[j].high, low: hist[j].low, close: hist[j].close,
        sma50: dj.sma50 ?? null, sma200: dj.sma200 ?? null, atr14: dj.atr14 ?? null,
        side: dj.date ? sideOf(dj) : null,
      });
    }
    if (!fwd.length) continue;

    out.push({
      sym, side, entryDate: d.date, entryClose: d.close, entryAtr14: d.atr14 ?? null,
      buyScore: d.buyScore, sellScore: d.sellScore, factors: d.factors, fwd,
    });
  }
  return out;
}

/* ---------- Exit simulation ---------- */
const sideSign = (side) => (side === "short" ? -1 : 1);
function pnlPct(rec, exitPrice) {
  return sideSign(rec.side) * ((exitPrice - rec.entryClose) / rec.entryClose) * 100;
}

/* Simulate one entry under one exit rule → { pnl, hold, reason }. Per forward bar,
   exit priority: (1) hard/trailing stop intrabar, (2) profit/structure target at
   the close, (3) signal flip at the close, (4) time stop. Runs out of bars → last
   close. `rule` fields:
     initStopAtr  — initial hard stop at entry ± mult×ATR14(entry), 0/undefined = off
     trailAtr     — chandelier trailing stop: extreme-since-entry ∓ mult×ATR14(bar)
     target       — "none" | "pct" | "trendBreak" | "maCross"
     pctX         — fractional target for target:"pct" (e.g. 0.15)
     timeStop     — sessions held cap, 0/undefined = off
     useFlip      — exit when the reconstructed side flips to the opposite */
export function simulateShortExit(rec, rule) {
  const long = rec.side === "long";
  const entry = rec.entryClose;
  const initStop = (rule.initStopAtr > 0 && rec.entryAtr14 > 0)
    ? (long ? entry - rule.initStopAtr * rec.entryAtr14 : entry + rule.initStopAtr * rec.entryAtr14)
    : null;
  let extreme = entry; // highest high (long) / lowest low (short) seen since entry

  for (let k = 0; k < rec.fwd.length; k++) {
    const bar = rec.fwd[k];
    const day = k + 1;

    // Trailing chandelier stop, recomputed from the running extreme + this bar's ATR.
    let trailStop = null;
    if (rule.trailAtr > 0) {
      const atr = bar.atr14 > 0 ? bar.atr14 : rec.entryAtr14;
      if (atr > 0) trailStop = long ? extreme - rule.trailAtr * atr : extreme + rule.trailAtr * atr;
    }
    // The effective stop is the tighter (more protective) of init + trailing.
    let stop = null;
    for (const s of [initStop, trailStop]) {
      if (s == null) continue;
      if (stop == null) stop = s;
      else stop = long ? Math.max(stop, s) : Math.min(stop, s);
    }

    // (1) stop — intrabar low (long) / high (short) piercing the line; gap fills at open.
    if (stop != null) {
      if (long && bar.low > 0 && bar.low <= stop) {
        const fill = bar.open > 0 && bar.open <= stop ? bar.open : stop;
        return { pnl: pnlPct(rec, fill), hold: day, reason: rule.trailAtr > 0 ? "TRAIL" : "STOP" };
      }
      if (!long && bar.high > 0 && bar.high >= stop) {
        const fill = bar.open > 0 && bar.open >= stop ? bar.open : stop;
        return { pnl: pnlPct(rec, fill), hold: day, reason: rule.trailAtr > 0 ? "TRAIL" : "STOP" };
      }
    }

    // (2) target
    let tgt = false;
    if (rule.target === "pct") {
      const g = long ? (bar.close - entry) / entry : (entry - bar.close) / entry;
      tgt = g >= (rule.pctX ?? 0.15);
    } else if (rule.target === "trendBreak") {
      tgt = bar.sma50 != null && (long ? bar.close < bar.sma50 : bar.close > bar.sma50);
    } else if (rule.target === "maCross") {
      tgt = bar.sma50 != null && bar.sma200 != null && (long ? bar.sma50 < bar.sma200 : bar.sma50 > bar.sma200);
    }
    if (tgt) return { pnl: pnlPct(rec, bar.close), hold: day, reason: "TARGET" };

    // (3) flip
    if (rule.useFlip && bar.side && bar.side !== rec.side) {
      return { pnl: pnlPct(rec, bar.close), hold: day, reason: "FLIP" };
    }

    // (4) time stop
    if (rule.timeStop && day >= rule.timeStop) {
      return { pnl: pnlPct(rec, bar.close), hold: day, reason: "TIME" };
    }

    // advance the trailing extreme AFTER this bar's exits are cleared
    if (long) { if (bar.high > extreme) extreme = bar.high; }
    else      { if (bar.low > 0 && (extreme === entry || bar.low < extreme)) extreme = bar.low; }
  }
  const last = rec.fwd[rec.fwd.length - 1];
  return { pnl: pnlPct(rec, last.close), hold: rec.fwd.length, reason: "EOD" };
}

/* Per-trade SPY buy-and-hold over the same entry→exit window (the honest yardstick
   for a market-timing strategy). spyHist newest-first. */
function spyCloseAsOf(spyHist, date) { for (const b of spyHist) if (b.date <= date) return b.close; return null; }
function spyReturnOver(spyHist, entryDate, exitDate, side) {
  const e = spyCloseAsOf(spyHist, entryDate), x = spyCloseAsOf(spyHist, exitDate);
  if (!(e > 0) || !(x > 0)) return null;
  // For a SPY buy-and-hold benchmark the sign follows the market, not the trade
  // side — you'd have been LONG SPY regardless. But to compare like-for-like on a
  // short trade we ask "did the short beat being long the market" via edge below;
  // the raw SPY return here is always the long-SPY return.
  return ((x - e) / e) * 100;
}

export function aggregateShortRule(records, rule, spyHist) {
  const rets = [], holds = [], spys = [], reasons = {};
  for (const rec of records) {
    const r = simulateShortExit(rec, rule);
    rets.push(r.pnl); holds.push(r.hold);
    reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    if (spyHist) {
      const exitBar = rec.fwd[Math.min(r.hold, rec.fwd.length) - 1];
      const s = exitBar ? spyReturnOver(spyHist, rec.entryDate, exitBar.date, rec.side) : null;
      if (s != null) spys.push(s);
    }
  }
  const exp = mean(rets), avgHold = mean(holds);
  const avgSpy = spys.length ? mean(spys) : null;
  return {
    n: rets.length,
    expectancy: exp,
    expPerDay: exp != null && avgHold ? exp / avgHold : null,
    winRate: winRate(rets),
    profitFactor: profitFactor(rets),
    avgHold, medHold: median(holds),
    worst: rets.length ? Math.min(...rets) : null,
    best: rets.length ? Math.max(...rets) : null,
    avgSpy,
    edge: exp != null && avgSpy != null ? exp - avgSpy : null,
    reasons,
  };
}

/* The swing-horizon exit grid. Each rule is a named, curated combination (a full
   cartesian would be noise). ATR stops are wide (swing volatility needs room);
   the trailing "chandelier" variants are the canonical trend-follow exit. */
export function swingExitGrid() {
  return [
    { label: "hold63",        target: "none",       timeStop: 63 },                                 // buy & hold the horizon (baseline)
    { label: "time20",        target: "none",       timeStop: 20 },
    { label: "time40",        target: "none",       timeStop: 40 },
    { label: "trendBreak",    target: "trendBreak", timeStop: 63 },                                 // exit when close loses the 50DMA
    { label: "maCross",       target: "maCross",    timeStop: 63 },                                 // exit on 50/200 cross
    { label: "maCross_atr30", target: "maCross",    timeStop: 63, initStopAtr: 3.0 },               // trend exit + catastrophe stop
    { label: "maCross_atr40", target: "maCross",    timeStop: 63, initStopAtr: 4.0 },
    { label: "atr30",         target: "none",       timeStop: 63, initStopAtr: 3.0 },
    { label: "atr30_tb",      target: "trendBreak", timeStop: 63, initStopAtr: 3.0 },
    { label: "atr40_tb",      target: "trendBreak", timeStop: 63, initStopAtr: 4.0 },
    { label: "chand30",       target: "none",       timeStop: 63, trailAtr: 3.0 },                  // pure chandelier trail
    { label: "chand30_tb",    target: "trendBreak", timeStop: 63, trailAtr: 3.0 },
    { label: "chand40",       target: "none",       timeStop: 63, trailAtr: 4.0 },
    { label: "chand40_t40",   target: "none",       timeStop: 40, trailAtr: 4.0 },
    { label: "pct15_atr30",   target: "pct", pctX: 0.15, timeStop: 63, initStopAtr: 3.0 },
    { label: "pct20_atr30",   target: "pct", pctX: 0.20, timeStop: 63, initStopAtr: 3.0 },
    { label: "flip_atr30",    target: "none", useFlip: true, timeStop: 63, initStopAtr: 3.0 },
    { label: "flip_chand30",  target: "none", useFlip: true, timeStop: 63, trailAtr: 3.0 },
  ];
}

export function shortExitGridReport(records, spyHist, rules = swingExitGrid()) {
  return rules
    .map(rule => ({ rule: rule.label, ...aggregateShortRule(records, rule, spyHist) }))
    .sort((a, b) => (b.expectancy ?? -1e9) - (a.expectancy ?? -1e9));
}

/* ---------- Factor attribution ----------
   For each factor, bucket long entries by the factor's buy-points and short
   entries by its sell-points, and report avg forward-H return + win rate per
   bucket + the points→return IC. A factor whose top bucket doesn't earn more is
   not pulling its weight. */
export function shortFwdReturn(rec, H) {
  const bar = rec.fwd[Math.min(H, rec.fwd.length) - 1];
  if (!bar) return null;
  return sideSign(rec.side) * ((bar.close - rec.entryClose) / rec.entryClose) * 100;
}
export function shortAttributionReport(records, { horizon = 21 } = {}) {
  const report = {};
  for (const key of FACTOR_KEYS) {
    const buckets = { 0: [], 1: [], 2: [], 3: [] };
    const xs = [], ys = [];
    for (const rec of records) {
      const f = rec.factors.find(ff => ff.key === key);
      if (!f) continue;
      const pts = rec.side === "short" ? f.sell : f.buy;
      const ret = shortFwdReturn(rec, horizon);
      if (pts == null || ret == null) continue;
      const b = Math.max(0, Math.min(3, Math.round(pts)));
      buckets[b].push(ret);
      xs.push(pts); ys.push(ret);
    }
    report[key] = {
      n: xs.length, ic: pearson(xs, ys),
      buckets: Object.fromEntries(Object.entries(buckets).map(([k, arr]) =>
        [k, { n: arr.length, avgRet: mean(arr), winRate: winRate(arr) }])),
    };
  }
  return report;
}
