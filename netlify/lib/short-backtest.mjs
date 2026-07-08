/* ===== SWING BACKTEST FEATURE =====
   "As-if" paper-trade backtest for the Swing (1wk-3mo) view — the trend-following
   sibling of the Bounce backtest (netlify/lib/quickswing-backtest.mjs). Same
   shape (a per-ticker forward-accumulating trade log, seeded from a historical
   EOD replay, benchmarked against SPY buy-and-hold), but calibrated for the swing
   horizon and philosophy:

     - LONG-ONLY. A 2-year, 90-name study (scripts/run-short-study.mjs) found the
       symmetric short side loses on this universe (−2.3% avg vs longs +1.8%) and
       blows the worst trade from −52% to −150% — shorting weak trend-breakers
       both bleeds return and destroys capital protection. Buying strength is the
       whole Swing thesis; the log honors it.
     - Entry: a fresh transition into a STRONG swing setup — the reconstructable
       technical core of the 33-point score (Trend, 3M-Momentum, Near-High,
       Liquidity, Volume-Surge, Sector-RS → 0-18) at/above the same 67% strong bar
       the live screener uses (12/18), AND price in a clean uptrend (px>50DMA>200DMA).
       The 5 fundamental factors (analyst, valuation, quality, leverage, catalyst)
       are NOT in the entry signal — they can't be reconstructed at a past date, so
       — exactly like Bounce — the log keys off the EOD-computable factors so the
       seed replay and forward recording are byte-identical.
     - Exit priority (calibrated — see the study): (1) 4×ATR14 catastrophe stop,
       (2) TREND exit on a 50/200 death-cross (the primary "trend is over" signal —
       highest SPY edge, +1.72pp), (3) a 63-session (~3-month) time cap. No
       take-profit and no short-side flip: a trend trade's edge IS letting winners
       run to the trend break, so an early profit target would cap the fat tail.

   Pure functions; the endpoints (short-backtest.mjs / short-backtest-seed.mjs)
   and short-pipeline.mjs's live scorer supply the I/O. Self-contained and
   removable with the SWING BACKTEST FEATURE block. */

import { atrFrom } from "./ta-helpers.mjs";
import { strengthFactor } from "./quickswing-pipeline.mjs";

const MAX_CLOSED = 200;
// Rolling window: a trade drops off once its ENTRY is older than this (pruning by
// entry, like Bounce, guarantees a hard "furthest back, ever"). Swing holds run
// ~40 days, so the window is much wider than Bounce's 15 — ~6.5 months keeps a
// handful of completed multi-week trades visible per ticker.
export const SBT_WINDOW_DAYS = 195;
export const SBT_SEED_SESSIONS = 130;      // trading days replayed on the first seed (~6mo)
export const SBT_STOP_ATR_MULT = 4.0;      // catastrophe stop = entry − 4×ATR14 (wide; swing needs room)
export const SBT_TIME_STOP_DAYS = 63;      // sessions — the outer 3-month swing bound
export const SBT_ENTRY_MIN = 12;           // technical strong bar (12/18 = same 67% as 22/33 live)
// Bump when the entry/exit calibration changes so already-seeded logs re-seed.
// v1: long-only, entry techScore≥12 & uptrend, exit 4×ATR / 50-200 death-cross / 63d.
// v2: Near-High factor re-tuned (top mark → 5-18% pullback zone, not pinned at high).
export const SBT_SEED_VERSION = 2;

const round2 = x => (x == null ? null : Math.round(x * 100) / 100);

export function emptyShortLog() { return { open: null, closed: [] }; }
export function needsShortSeed(log) { return !log || log.seedVersion !== SBT_SEED_VERSION; }

/* ---------- Reconstructable technical swing signal ----------
   Computes the 6 EOD-computable swing factors (0-18) plus the trend/stop context
   at ONE bar. `hist` is newest-first with index 0 = the as-of bar. spyStrength /
   sectorStrength are the IBD-style weighted ROC values as of that bar (the caller
   supplies them so this stays pure). Every threshold matches short-pipeline.mjs's
   long-side scoring so the backtest measures the real screener's timing core. */
export function computeShortSignal(hist, { spyStrength = null, sectorStrength = null } = {}) {
  if (!Array.isArray(hist) || hist.length < 200) return null;
  const closes = hist.slice(0, 260).map(d => d.close ?? d.price).filter(p => p != null);
  if (closes.length < 200) return null;
  const price = closes[0];
  const sma = n => { let s = 0; for (let k = 0; k < n; k++) s += closes[k]; return s / n; };
  const sma50 = sma(50), sma200 = sma(200);

  // 1. Trend
  const above = (price - sma50) / sma50;
  let trendPts;
  if (price > sma50 && sma50 > sma200 && above >= 0.08) trendPts = 3;
  else if (price > sma50 && sma50 > sma200)             trendPts = 2;
  else if (price > sma50)                               trendPts = 1;
  else                                                  trendPts = 0;

  // 2. 3M Momentum (63-day return)
  let momPts = 0;
  if (closes.length >= 63 && closes[62] > 0) {
    const ret = price / closes[62] - 1;
    if (ret >= 0.15) momPts = 3; else if (ret >= 0.05) momPts = 2; else if (ret >= 0) momPts = 1; else momPts = 0;
  }

  // 3. Near 52w High — re-tuned to reward the 5-18% "pullback to strength" zone
  //    over being pinned at the high (see checkNearHigh in short-pipeline.mjs).
  const high = Math.max(...closes);
  const offHigh = (high - price) / high;
  let nearPts;
  if (offHigh > 0.05 && offHigh <= 0.18) nearPts = 3; else if (offHigh <= 0.05) nearPts = 2; else if (offHigh <= 0.30) nearPts = 1; else nearPts = 0;

  // 4. Liquidity (20-day avg $-volume) — also the eligibility gate
  const dv = hist.slice(0, 20).map(d => (d.close ?? d.price ?? 0) * (d.volume ?? 0)).filter(v => v > 0);
  const avgDollarVol = dv.length ? dv.reduce((s, x) => s + x, 0) / dv.length : 0;
  let liqPts;
  if (avgDollarVol >= 100e6) liqPts = 3; else if (avgDollarVol >= 20e6) liqPts = 2; else if (avgDollarVol >= 10e6) liqPts = 1; else liqPts = 0;

  // 5. Volume Surge (recent-day surge + 10-day money flow) — accumulation ladder
  let volPts = 0;
  if (hist.length >= 21) {
    const h0 = hist[0], h1 = hist[1];
    const rVol = h0?.volume, rClose = h0?.close ?? h0?.price, pClose = h1?.close ?? h1?.price;
    const vols = hist.slice(1, 21).map(d => d.volume).filter(v => v > 0);
    if (rVol != null && rClose != null && pClose != null && vols.length >= 15) {
      const avg20 = vols.reduce((s, x) => s + x, 0) / vols.length;
      const rv = rVol / avg20;
      const isUp = rClose > pClose, isDown = rClose < pClose;
      let upD = 0, dnD = 0, look = 0;
      for (let i = 0; i < 10 && i + 1 < hist.length; i++) {
        const c = hist[i].close ?? hist[i].price, pc = hist[i + 1].close ?? hist[i + 1].price, v = hist[i].volume;
        if (c == null || pc == null || v == null || v <= 0) continue;
        const d = c * v;
        if (c > pc) upD += d; else if (c < pc) dnD += d;
        look++;
      }
      const total = upD + dnD;
      const flow = look >= 6 && total > 0 ? (upD - dnD) / total : null;
      const sustBuy = flow != null && flow >= 0.3, sustSell = flow != null && flow <= -0.3, mildBuy = flow != null && flow >= 0.1;
      if (rv >= 1.5 && isDown) volPts = 0;
      else if (sustSell) volPts = 0;
      else if (rv >= 2.5 && isUp && sustBuy) volPts = 3;
      else if (rv >= 1.5 && isUp && sustBuy) volPts = 3;
      else if (rv >= 2.5 && isUp) volPts = 3;
      else if (rv >= 1.5 && isUp && mildBuy) volPts = 2;
      else if (rv >= 1.5 && isUp) volPts = 2;
      else if (sustBuy && rv >= 0.8) volPts = 2;
      else if (rv >= 2.5) volPts = 1;
      else if (mildBuy && rv >= 0.8) volPts = 1;
      else if (rv >= 0.8) volPts = 1;
      else volPts = 0;
    }
  }

  // 6. Sector RS (sector ETF weighted-ROC minus SPY's)
  let secPts = 0;
  if (spyStrength != null && sectorStrength != null) {
    const delta = sectorStrength - spyStrength;
    if (delta >= 0.15) secPts = 3; else if (delta >= 0.08) secPts = 2; else if (delta >= -0.03) secPts = 1; else secPts = 0;
  }

  const techScore = trendPts + momPts + nearPts + liqPts + volPts + secPts;
  const uptrend = price > sma50 && sma50 > sma200;
  const b0 = hist[0];
  return {
    techScore, price, sma50: round2(sma50), sma200: round2(sma200), uptrend,
    deathCross: sma50 < sma200,
    atr14: round2(atrFrom(hist, 0, 14)),
    liqPts,
    entryStrong: techScore >= SBT_ENTRY_MIN && uptrend && liqPts >= 1,
    bar: { date: b0.date, open: b0.open ?? b0.close, high: b0.high ?? b0.close, low: b0.low ?? b0.close, close: b0.close ?? b0.price },
  };
}

/* ---------- Rolling-window prune (by ENTRY date) ---------- */
export function pruneShortWindow(log, days = SBT_WINDOW_DAYS) {
  if (!log || typeof log !== "object") return emptyShortLog();
  const cutoff = Date.now() - days * 86400000;
  const closed = (Array.isArray(log.closed) ? log.closed : []).filter(t => {
    const ts = Date.parse(t.entryScoredAt || t.entryAt);
    return !isFinite(ts) || ts >= cutoff;
  });
  const out = { open: log.open ?? null, closed: closed.slice(0, MAX_CLOSED) };
  if (log.seeded) out.seeded = true;
  if (log.seedVersion != null) out.seedVersion = log.seedVersion;
  return out;
}

/* ---------- SPY buy-and-hold benchmark ---------- */
function spyCloseAsOf(spyHist, dateStr) {
  for (const b of spyHist) if (b.date <= dateStr) return b.close ?? b.price;
  return null;
}
export function shortSpyReturnBetween(spyHist, entryIso, exitIso) {
  if (!Array.isArray(spyHist) || !spyHist.length || !entryIso || !exitIso) return null;
  const e = spyCloseAsOf(spyHist, String(entryIso).slice(0, 10));
  const x = spyCloseAsOf(spyHist, String(exitIso).slice(0, 10));
  if (!(e > 0) || !(x > 0)) return null;
  return Math.round(((x - e) / e) * 100 * 100) / 100;
}
export function annotateShortBenchmarks(log, spyHist) {
  if (!log || !Array.isArray(log.closed) || !Array.isArray(spyHist) || !spyHist.length) return log;
  for (const t of log.closed) {
    if (t.spyPct == null) {
      const r = shortSpyReturnBetween(spyHist, t.entryScoredAt || t.entryAt, t.exitScoredAt || t.exitAt);
      if (r != null) t.spyPct = r;
    }
  }
  return log;
}

function holdDaysBetween(startIso, endIso) {
  const a = Date.parse(startIso), b = Date.parse(endIso);
  if (!isFinite(a) || !isFinite(b) || b < a) return null;
  return Math.round(((b - a) / 86400000) * 10) / 10;
}

/* ---------- Seed merge (forward trades win) ---------- */
export function mergeShortSeed(existing, seed) {
  const ex = existing && typeof existing === "object" ? existing : emptyShortLog();
  const sd = seed && typeof seed === "object" ? seed : emptyShortLog();
  const seen = new Set();
  const closed = [];
  for (const t of [...(ex.closed || []), ...(sd.closed || [])]) {
    const key = `${t.sym}|${t.entryScoredAt || t.entryAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    closed.push(t);
  }
  return { open: ex.open ?? sd.open ?? null, closed, seeded: true, seedVersion: SBT_SEED_VERSION };
}

/* ---------- Fold one scored bar into the trade log (LONG-ONLY) ----------
   `sig` is the output of computeShortSignal for this bar; `prevLog` may be null.
   The bar carries OHLC (sig.bar), atr14, sma50/200, and entryStrong/deathCross.
   Pure — the caller persists the result. */
export function recordShortTransition(sym, sig, prevLog, scoredAt) {
  const log = prevLog && typeof prevLog === "object"
    ? { open: prevLog.open ?? null, closed: Array.isArray(prevLog.closed) ? prevLog.closed : [] }
    : emptyShortLog();
  if (prevLog && prevLog.seeded) log.seeded = true;
  if (prevLog && prevLog.seedVersion != null) log.seedVersion = prevLog.seedVersion;

  if (!sig || !sig.bar || !(sig.bar.close > 0)) return log; // unscoreable bar — leave open position untouched
  const bar = sig.bar;
  const sessionDate = bar.date;
  const nowIso = scoredAt || `${bar.date}T21:00:00.000Z`;

  const openPosition = () => {
    const atr14 = sig.atr14 > 0 ? sig.atr14 : null;
    const stopPrice = atr14 ? round2(bar.close - SBT_STOP_ATR_MULT * atr14) : null;
    return {
      sym, side: "long",
      entryAt: nowIso, entryScoredAt: nowIso,
      entryPrice: bar.close, atr14, stopPrice,
      entrySessionDate: sessionDate, lastSessionDate: sessionDate, barsHeld: 0,
    };
  };
  const closePosition = (o, exitPrice, exitReason) => {
    const pnlPct = Math.round(((exitPrice - o.entryPrice) / o.entryPrice) * 100 * 100) / 100;
    log.closed = [{
      sym: o.sym, side: "long",
      entryAt: o.entryAt, entryScoredAt: o.entryScoredAt, entryPrice: o.entryPrice,
      stopPrice: o.stopPrice ?? null,
      exitAt: nowIso, exitScoredAt: nowIso, exitPrice, exitReason,
      pnlPct,
      holdDays: holdDaysBetween(o.entryScoredAt || o.entryAt, nowIso),
    }, ...log.closed].slice(0, MAX_CLOSED);
  };

  if (!log.open) {
    if (sig.entryStrong) log.open = openPosition();
    return log;
  }

  const o = log.open;
  // Count a session once per new bar date (intraday rescans don't inflate the hold).
  if (sessionDate) {
    if (o.lastSessionDate == null) { o.lastSessionDate = sessionDate; o.barsHeld = o.barsHeld || 0; }
    else if (sessionDate > o.lastSessionDate) { o.barsHeld = (o.barsHeld || 0) + 1; o.lastSessionDate = sessionDate; }
  }

  // 1. STOP — a long is cut when the day's LOW pierces the 4×ATR line. A gap
  //    through the stop at the open fills at the open; an intraday touch fills at
  //    the stop; a live snapshot with no low fills at min(price, stop).
  if (o.stopPrice != null) {
    const low = bar.low > 0 ? bar.low : null;
    const breachRef = low != null ? low : bar.close;
    if (breachRef > 0 && breachRef <= o.stopPrice) {
      let exitPrice;
      if (bar.open > 0 && bar.open <= o.stopPrice) exitPrice = bar.open;
      else if (low != null) exitPrice = o.stopPrice;
      else exitPrice = Math.min(bar.close, o.stopPrice);
      closePosition(o, exitPrice, "STOP");
      log.open = null;
      return log;
    }
  }

  // 2. TREND — the 50DMA has crossed below the 200DMA (death cross): the primary
  //    uptrend is over. Exit at the close. This is the trend-follow edge — hold
  //    winners until the trend actually breaks, not on the first red day.
  if (sig.deathCross) {
    closePosition(o, bar.close, "TREND");
    log.open = null;
    return log;
  }

  // 3. TIME — a swing that's run the full 3-month window without its trend
  //    breaking is closed to free the capital.
  if (o.barsHeld >= SBT_TIME_STOP_DAYS) {
    closePosition(o, bar.close, "TIME");
    log.open = null;
    return log;
  }

  return log; // trend intact, under the time cap, above the stop → hold
}

/* ---------- Historical replay → seed log ----------
   Replays the last `sessions` bars oldest→newest, folding each through
   recordShortTransition, then tags each closed trade with SPY's return over the
   same dates. spyStrSeries / sectorStrSeries are [{date, strength}] newest-first
   (precomputed once by the caller); strengthAsOf picks the value as of each bar. */
function strengthAsOf(series, date) {
  if (!Array.isArray(series)) return null;
  for (const s of series) if (s.date <= date) return s.strength;
  return null;
}
export function strengthSeriesFor(hist) {
  const out = [];
  if (!Array.isArray(hist)) return out;
  for (let i = 0; i < hist.length; i++) out.push({ date: hist[i].date, strength: strengthFactor(hist.slice(i)) });
  return out;
}
export function replayShortTrades(sym, hist, spyStrSeries, sectorStrSeries, spyHist, { sessions = SBT_SEED_SESSIONS } = {}) {
  let log = emptyShortLog();
  if (!Array.isArray(hist) || hist.length < 205) return log; // need 200 warmup + a few bars
  const dates = hist.slice(0, sessions).map(b => b.date).reverse(); // oldest→newest
  for (const date of dates) {
    const hAsOf = hist.filter(d => d.date <= date);
    if (hAsOf.length < 200) continue;
    const sig = computeShortSignal(hAsOf, {
      spyStrength: strengthAsOf(spyStrSeries, date),
      sectorStrength: strengthAsOf(sectorStrSeries, date),
    });
    if (!sig) continue;
    log = recordShortTransition(sym, sig, log, `${date}T21:00:00.000Z`);
  }
  annotateShortBenchmarks(log, spyHist);
  return log;
}
/* ===== END SWING BACKTEST FEATURE ===== */
