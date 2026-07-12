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
     - Entry (v5 "best of the best" gate — see docs/swing-deep-entry-report.md): a fresh
       transition into a STRONG swing setup — the reconstructable technical core of the
       33-point score (Trend, 3M-Momentum, Near-High, Liquidity, Volume-Surge, Sector-RS
       → 0-18) at/above 14/18 (~78%), price in a clean uptrend (px>50DMA>200DMA), the
       sector leading SPY (Sector-RS ≥ 2), AND ≥$1B/day dollar-volume. A deep 2006-2026
       out-of-sample/out-of-regime study found this is the only combo whose edge holds
       through IS + OOS + real bears; raw entry-strength alone (12/18) was ~0 in-sample.
       The 5 fundamental factors (analyst, valuation, quality, leverage, catalyst) are
       NOT in the entry signal — they can't be reconstructed at a past date, so — exactly
       like Bounce — the log keys off the EOD-computable factors so the seed replay and
       forward recording are byte-identical.
     - Exit priority (v4 risk-first calibration — see docs/swing-calibration-report.md):
       (1) a loose 40% hard catastrophe stop (SBT_HARD_STOP_PCT), (2) a 63-session
       (~3-month) time cap — now the PRIMARY exit. The old 50/200 death-cross early-exit
       and the tight 4×ATR stop were DROPPED: both clipped winners and worsened drawdown,
       and a plain 63-day hold + wide backstop won on OOS expectancy + risk (and matches
       standard trend-following practice). No take-profit / no short-side flip: a trend
       trade's edge IS letting winners run, so an early target would cap the fat tail.

   Pure functions; the endpoints (short-backtest.mjs / short-backtest-seed.mjs)
   and short-pipeline.mjs's live scorer supply the I/O. Self-contained and
   removable with the SWING BACKTEST FEATURE block. */

import { atrFrom } from "./ta-helpers.mjs";
import { strengthFactor } from "./quickswing-pipeline.mjs";
import { marketCloseMinET } from "./market-calendar.mjs";

const MAX_CLOSED = 200;
// Rolling window: a trade drops off once its ENTRY is older than this (pruning by
// entry, like Bounce, guarantees a hard "furthest back, ever"). Swing holds run
// ~40 days, so the window is much wider than Bounce's 15 — ~6.5 months keeps a
// handful of completed multi-week trades visible per ticker.
export const SBT_WINDOW_DAYS = 195;
export const SBT_SEED_SESSIONS = 130;      // trading days replayed on the first seed (~6mo)
export const SBT_STOP_ATR_MULT = 4.0;      // (legacy v1–v3) prior catastrophe stop = entry − 4×ATR14; superseded by SBT_HARD_STOP_PCT
export const SBT_HARD_STOP_PCT = 0.40;     // v4 catastrophe stop = entry × (1 − 0.40): a loose, rarely-fired backstop that bounds the
                                           // single-trade NON-gap tail without choking trend winners. Calibration found a tight stop
                                           // AND the 50/200 death-cross both hurt (they clip winners) — see docs/swing-calibration-report.md.
export const SBT_TIME_STOP_DAYS = 63;      // sessions — a 63-day hold is now the PRIMARY exit (canonical momentum window)
export const SBT_ENTRY_MIN = 14;           // technical strong bar (14/18 ≈ 78%) — raised from 12 in v5 (see below)
export const SBT_SECRS_MIN = 2;            // v5: entry also requires the name's sector leading SPY (SECRS ≥ 2, i.e. ETF-ROC − SPY-ROC ≥ +0.08)
// Liquidity guardrail (v5: raised $300M → $1B/day). A deep 20-year study
// (docs/swing-deep-entry-report.md, 2006-2026 incl. the 2008/2018/2020 bears) swept
// the floor and found edge-vs-SPY is flat-to-NEGATIVE (and bear-negative at EVERY
// tier) below ~$1B/day, and only turns positive — and bear-robust — at $1B+. The
// most-liquid mega-caps are a flight-to-quality/defensiveness filter, NOT an alpha
// claim (still ~1/3 leverage; survivor-only numbers are upper bounds).
export const SBT_LIQ_FLOOR = 1e9;
// Bump when the entry/exit calibration changes so already-seeded logs re-seed.
// v1: long-only, entry techScore≥12 & uptrend, exit 4×ATR / 50-200 death-cross / 63d.
// v2: Near-High factor re-tuned (top mark → 5-18% pullback zone, not pinned at high).
// v3: liquidity guardrail — entries require avgDollarVol ≥ $300M/day (SBT_LIQ_FLOOR).
// v4: risk-first calibration — exit is now a 63-day hold + a loose 40% hard catastrophe
//     stop; the 50/200 death-cross early-exit and the tight 4×ATR stop are DROPPED (both
//     clipped winners / worsened drawdown). Prices are now split-adjusted upstream, which
//     kills the phantom HON −47% split "trade". See docs/swing-calibration-report.md.
// v5: "best of the best" entry — the deep 2006-2026 out-of-sample/out-of-regime study
//     (docs/swing-deep-entry-report.md) demoted raw entry-strength (techScore≥15's
//     in-sample edge was ~0; its headline was post-2017 bull) and found the only rule
//     positive across IS + OOS + bear was techScore≥14 & $-vol≥$1B/day & sector-RS≥2.
//     So the entry is tightened to that combo. Honest framing unchanged: high-conviction
//     mega-cap tilt, not alpha; no protection when buying INTO a real bear.
export const SBT_SEED_VERSION = 5;

const round2 = x => (x == null ? null : Math.round(x * 100) / 100);

/* ---------- Completed-session guard (no partial-today-bar) ----------
   FMP's historical-price-eod/full carries TODAY'S IN-PROGRESS bar during market
   hours, so hist[0] is a non-final intraday snapshot until the ET session closes.
   The forward fold must never book on it (it would be look-ahead-contaminated and
   non-deterministic — the entry would depend on which minute the rescan fired,
   and would then win the seed merge, permanently overriding the completed-bar
   replay). This decides, from the ET wall clock (todayEt = etDateStr(now),
   minutesOfDay = etParts(now).minutesOfDay), whether a bar dated `barDate` (ET
   calendar day) is a COMPLETED session: prior days always are; today's bar is
   complete only once the ET regular session (16:00, or 13:00 on a half-day) has
   closed. Pure — the caller supplies the clock so it stays testable/deterministic. */
export function sessionComplete(barDate, todayEt, minutesOfDay) {
  if (!barDate || !todayEt) return false;
  if (barDate < todayEt) return true;
  if (barDate > todayEt) return false;              // future bar — never trust
  return minutesOfDay >= marketCloseMinET(todayEt); // today: only after the close
}

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
    liqPts, secPts, avgDollarVol: Math.round(avgDollarVol),
    // v5 "best of the best" entry gate: a strong technical core (≥14/18), a clean
    // uptrend, the mega-cap $1B/day liquidity floor, AND the sector leading SPY
    // (SECRS ≥ 2). The only combo that held edge across IS + OOS + real bears
    // (docs/swing-deep-entry-report.md). secPts needs SPY + sector strength; if
    // either is missing it reads 0, so an unmapped-sector name can't fire — intended.
    entryStrong: techScore >= SBT_ENTRY_MIN && uptrend
      && avgDollarVol >= SBT_LIQ_FLOOR && secPts >= SBT_SECRS_MIN,
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
  if (log.dailyLog) out.dailyLog = log.dailyLog;   // preserve the notifier snapshot
  if (log.sym) out.sym = log.sym;                   // preserve the ticker key (the render needs it)
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
  const open = ex.open ?? sd.open ?? null;
  const seen = new Set();
  // Seed the dedup set with the SURVIVING open position's key first. Without this,
  // an entry that is still OPEN in the forward log but already CLOSED in the seed
  // replay (the replay had more history and folded its exit) would appear BOTH as
  // an unrealized open position AND as a realized closed trade — double-counting
  // it in win-rate / avg-return. "Forward wins" ⇒ keep it open, drop the seed's
  // closed copy.
  if (open) seen.add(`${open.sym}|${open.entryScoredAt || open.entryAt}`);
  const closed = [];
  for (const t of [...(ex.closed || []), ...(sd.closed || [])]) {
    const key = `${t.sym}|${t.entryScoredAt || t.entryAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    closed.push(t);
  }
  return { open, closed, seeded: true, seedVersion: SBT_SEED_VERSION };
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
  // Carry the notifier snapshot + ticker key through the fold so a live rescan
  // doesn't strip the last-15-session daily log written by the seed.
  if (prevLog && prevLog.dailyLog) log.dailyLog = prevLog.dailyLog;
  if (prevLog && prevLog.sym) log.sym = prevLog.sym;

  if (!sig || !sig.bar || !(sig.bar.close > 0)) return log; // unscoreable bar — leave open position untouched
  const bar = sig.bar;
  const sessionDate = bar.date;
  const nowIso = scoredAt || `${bar.date}T21:00:00.000Z`;

  const openPosition = () => {
    const atr14 = sig.atr14 > 0 ? sig.atr14 : null; // kept for display/reference only
    // v4 catastrophe stop: a fixed % below entry (wide, rarely fired). Bounds the
    // single-trade non-gap loss without the winner-choking of the old 4×ATR/death-cross.
    const stopPrice = round2(bar.close * (1 - SBT_HARD_STOP_PCT));
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

  // 1. STOP — a long is cut when the day's LOW pierces the 40% hard catastrophe line.
  //    A gap through the stop at the open fills at the open (pessimistic); an intraday
  //    touch fills at the stop; a live snapshot with no low fills at min(price, stop).
  //    (v4: the 50/200 death-cross early-exit was DROPPED — it clipped winners; a plain
  //    63-day hold with this loose backstop won on OOS expectancy + risk. See the report.)
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

  // 2. TIME — the primary exit: a 63-session hold, then close to recycle capital.
  if (o.barsHeld >= SBT_TIME_STOP_DAYS) {
    closePosition(o, bar.close, "TIME");
    log.open = null;
    return log;
  }

  return log; // under the time cap, above the catastrophe stop → hold
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

/* ---------- Daily BUY/SELL/HOLD notifier log ----------
   A per-session view of what the swing signal did — the "notifier" the tab is
   really for. Replays the full seed window so position state is correct, records
   the ACTION at every session, and returns the last `sessions` days:
     BUY  — a fresh entry fired this session (entryStrong transition, guardrail-passed)
     SELL — an open position exited this session (reason: STOP / TIME)
     HOLD — in an open position, trend intact
     WATCH— flat, and this session was strong-but-blocked (uptrend+score but below
            the $300M/day guardrail, so no entry — shows why a name didn't fire)
     FLAT — flat, no setup
   Honest by construction: it shows the mechanism (which signals fire on real
   data), NOT a profit claim — the validation found the timing adds no edge. Pure;
   the caller supplies the fetched hist + precomputed SPY/sector strength series. */
export function dailySignalLog(sym, hist, spyStrSeries, sectorStrSeries, { sessions = 15, replaySessions = SBT_SEED_SESSIONS } = {}) {
  if (!Array.isArray(hist) || hist.length < 205) return { sym, days: [], open: null };
  const dates = hist.slice(0, replaySessions).map(b => b.date).reverse(); // oldest→newest
  let log = emptyShortLog();
  const all = [];
  for (const date of dates) {
    const hAsOf = hist.filter(d => d.date <= date);
    if (hAsOf.length < 200) continue;
    const sig = computeShortSignal(hAsOf, {
      spyStrength: strengthAsOf(spyStrSeries, date),
      sectorStrength: strengthAsOf(sectorStrSeries, date),
    });
    if (!sig) continue;
    const hadOpen = !!log.open;
    log = recordShortTransition(sym, sig, log, `${date}T21:00:00.000Z`);
    const nowOpen = !!log.open;
    let action, reason = null;
    if (!hadOpen && nowOpen) action = "BUY";
    else if (hadOpen && !nowOpen) { action = "SELL"; reason = log.closed[0]?.exitReason || null; }
    else if (hadOpen && nowOpen) action = "HOLD";
    else action = (sig.techScore >= SBT_ENTRY_MIN && sig.uptrend) ? "WATCH" : "FLAT"; // strong-but-below-guardrail vs no setup
    all.push({
      date, action, reason,
      techScore: sig.techScore, price: round2(sig.bar.close), uptrend: sig.uptrend,
      avgDollarVol: sig.avgDollarVol, guardrailPass: sig.avgDollarVol >= SBT_LIQ_FLOOR,
      stopPrice: nowOpen ? log.open.stopPrice : null,
    });
  }
  return { sym, days: all.slice(-sessions), open: log.open, seedVersion: SBT_SEED_VERSION };
}
/* ===== END SWING BACKTEST FEATURE ===== */
