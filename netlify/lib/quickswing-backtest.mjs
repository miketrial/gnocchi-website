/* ===== QUICK SWING FEATURE =====
   "As-if" paper-trade backtest for the Bounce (Quick Swing) view.

   The screener already emits a BUY / SELL / NEUTRAL / BLOCKED verdict on every
   scan. This module turns that stream of verdicts into a running trade log:

     - Enter (long) the first time the verdict reads BUY.
     - Hold while it stays BUY.
     - Exit the moment it stops being BUY (flips to NEUTRAL / SELL / BLOCKED),
       booking a closed trade with P/L.

   Long-only, forward-accumulating — no historical replay, no short side. The
   log is the source of truth for the endpoint + UI; nothing here hits the
   network. Self-contained and removable with the rest of the QUICK SWING
   FEATURE block (see the checklist in quickswing-pipeline.mjs). */

const MAX_CLOSED = 200; // cap the per-ticker closed-trade history
// Rolling window: a trade drops off once its ENTRY is older than this. Pruning
// by entry (not exit) guarantees nothing older than the cap ever shows — a
// trade's exit is always later than its entry, so entry-within-15d ⇒ the whole
// trade is within 15d. 15 is the hard "furthest back, ever" for this log.
export const BT_WINDOW_DAYS = 15;
export const BT_SEED_DAYS = 15;   // history backfilled the first time a ticker is added
// Bump when the scoring calibration OR exit rule changes so already-seeded logs
// get a one-time re-seed (they'd otherwise keep showing trades from the old rules).
// v2: extreme-read override + 0.30 weak threshold + 0.85 BUY regime penalty.
// v3: exit on SELL (not on the first non-BUY read).
// v4: per-trade SPY buy-and-hold benchmark (spyPct).
// v5: high-conviction BUY gate (RS ≥ 0 AND ≥3/6 factors agree).
// v6: BUY gate loosened to RS ≥ 0 only (dropped the agreement requirement).
// v7: overnight-gap BUY-conviction damper (gappier names need a stronger read).
// v8: 15-day window, pruned by ENTRY date (was 50-day, pruned by exit).
// v9: 2.5×ATR(5) stop-loss exit (in addition to the SELL flip).
export const BT_SEED_VERSION = 9;

// Stop-loss: a long is cut once price falls 2.5×ATR(5)-at-entry below the entry.
// Calibrated on an 8-ticker/250-session replay: vs the SELL-only rule it trims
// the worst trade from −26% to −14% while keeping ~98% of cumulative P&L and the
// full win rate — wide, volatility-scaled so normal wiggles breathe but a real
// structural break is cut. (Tighter multiples and hard % caps all bled far more
// return; a −13%/day name like SNDK simply can't be stopped tightly without
// cutting its winners too — size those down instead.) See the stop-loss study.
export const QS_STOP_ATR_MULT = 2.5;
const round2 = x => Math.round(x * 100) / 100;

export function emptyLog() {
  return { open: null, closed: [] };
}

/* A log needs (re)seeding if it's missing or was seeded under an older
   calibration version. */
export function needsSeed(log) {
  return !log || log.seedVersion !== BT_SEED_VERSION;
}

/* Rolling-window prune: drop closed trades whose ENTRY is older than `days` ago,
   measured from now. Pruning on entry (not exit) is what enforces the hard
   "furthest back, ever" guarantee — a trade entered inside the window is wholly
   inside it, so no entry date older than the cap can ever leak into the log via
   a long hold. A freshly-seeded ticker carries ~15 days of history; as forward
   days accumulate the window rolls, the oldest entry falling off as each new day
   is added. The open position is never pruned. */
export function pruneTradeWindow(log, days = BT_WINDOW_DAYS) {
  if (!log || typeof log !== "object") return emptyLog();
  const cutoff = Date.now() - days * 86400000;
  const closed = (Array.isArray(log.closed) ? log.closed : []).filter(t => {
    const ts = Date.parse(t.entryScoredAt || t.entryAt);
    return !isFinite(ts) || ts >= cutoff;
  });
  // Preserve the seed markers — they record that the one-time historical
  // backfill has already run (and under which calibration version), so a later
  // rescan-driven prune must not clear them (that would force a re-seed).
  const out = { open: log.open ?? null, closed: closed.slice(0, MAX_CLOSED) };
  if (log.seeded) out.seeded = true;
  if (log.seedVersion != null) out.seedVersion = log.seedVersion;
  return out;
}

/* ---------- Buy-and-hold benchmark (vs SPY over the same dates) ----------
   For each closed trade we record what SPY returned over the SAME entry→exit
   window. That's the honest yardstick for a market-timing strategy: "did
   catching the bounce beat simply being in the market those days?" — without
   it, a big cumulative $ can just be a rising tide. */
function spyCloseAsOf(spyHist, dateStr) {
  // spyHist is newest-first; the first bar dated on/before dateStr is the
  // most recent SPY close as of that day (handles weekends/holidays).
  for (const b of spyHist) if (b.date <= dateStr) return b.close;
  return null;
}
export function spyReturnBetween(spyHist, entryIso, exitIso) {
  if (!Array.isArray(spyHist) || !spyHist.length || !entryIso || !exitIso) return null;
  const e = spyCloseAsOf(spyHist, String(entryIso).slice(0, 10));
  const x = spyCloseAsOf(spyHist, String(exitIso).slice(0, 10));
  if (!(e > 0) || !(x > 0)) return null;
  return Math.round(((x - e) / e) * 100 * 100) / 100;
}
/* Fill spyPct on any closed trade that doesn't have it yet. Idempotent — safe
   to call from the seed replay, the rescan close path, and the seed endpoint. */
export function annotateBenchmarks(log, spyHist) {
  if (!log || !Array.isArray(log.closed) || !Array.isArray(spyHist) || !spyHist.length) return log;
  for (const t of log.closed) {
    if (t.spyPct == null) {
      const r = spyReturnBetween(spyHist, t.entryScoredAt || t.entryAt, t.exitScoredAt || t.exitAt);
      if (r != null) t.spyPct = r;
    }
  }
  return log;
}

/* Whole days between two ISO timestamps, rounded to one decimal (a 1-2 day
   strategy — sub-day precision is more noise than signal, but 0.x reads
   better than bucketing everything to "0 days"). */
function holdDaysBetween(startIso, endIso) {
  const a = Date.parse(startIso), b = Date.parse(endIso);
  if (!isFinite(a) || !isFinite(b) || b < a) return null;
  return Math.round(((b - a) / 86400000) * 10) / 10;
}

/* Merge a lazily-computed historical seed into whatever the forward-recording
   loop has already booked, and mark the log as seeded so it's never re-seeded.
   Forward trades (recent, from live scans) take precedence: the live `open`
   position is kept over the seed's stale trailing one, and duplicate trades
   (same ticker + entry timestamp) are de-duplicated, keeping the forward copy. */
export function mergeSeed(existing, seed) {
  const ex = existing && typeof existing === "object" ? existing : emptyLog();
  const sd = seed && typeof seed === "object" ? seed : emptyLog();
  const seen = new Set();
  const closed = [];
  for (const t of [...(ex.closed || []), ...(sd.closed || [])]) {
    const key = `${t.sym}|${t.entryScoredAt || t.entryAt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    closed.push(t);
  }
  return { open: ex.open ?? sd.open ?? null, closed, seeded: true, seedVersion: BT_SEED_VERSION };
}

/* Fold one freshly-scored row into the ticker's trade log and return the
   updated log. Pure — callers persist the result. `prevLog` may be null/absent
   (first time we've seen this ticker); `newRow` is a full pipeline row or an
   error stub. */
export function recordQuickswingTransition(newRow, prevLog) {
  const log = prevLog && typeof prevLog === "object"
    ? { open: prevLog.open ?? null, closed: Array.isArray(prevLog.closed) ? prevLog.closed : [] }
    : emptyLog();
  // Carry the one-time-seed markers forward — forward-recording must not clear
  // them, or the popover would re-run the expensive historical backfill.
  if (prevLog && prevLog.seeded) log.seeded = true;
  if (prevLog && prevLog.seedVersion != null) log.seedVersion = prevLog.seedVersion;

  // Ignore rows we can't price a trade off of — an errored scan or a missing
  // price leaves any open position untouched (we simply skip this datapoint).
  if (!newRow || newRow.error || !(newRow.price > 0)) return log;

  if (!log.open) {
    // Flat: a BUY opens a paper long. Anything else is a no-op.
    if (newRow.verdict === "BUY") {
      // Pin the stop at entry: entry − 2.5×ATR(5)-at-entry. atr5 rides on the row
      // (live scorer and the historical replay both supply it); if it's missing
      // the position simply carries no stop rather than a bogus one.
      const atr5 = newRow.atr5 > 0 ? newRow.atr5 : null;
      log.open = {
        sym: newRow.sym,
        entryAt: new Date().toISOString(),
        entryScoredAt: newRow.scored_at || null,
        entryPrice: newRow.price,
        entryPriceIsLive: !!newRow.priceIsLive,
        atr5,
        stopPrice: atr5 ? round2(newRow.price - QS_STOP_ATR_MULT * atr5) : null,
      };
    }
    return log;
  }

  const o = log.open;

  // Exit rule, in priority order:
  //  1. STOP — price broke the entry-time 2.5×ATR stop. Cut regardless of verdict
  //     (a mean-reversion read may scream BUY into a crash; the stop overrides).
  //  2. SELL — the verdict flipped to an actual overbought reversal. NEUTRAL alone
  //     is NOT an exit: backtested across 250 sessions, holding until SELL rather
  //     than bailing on the first non-BUY read roughly DOUBLED avg P/L per trade
  //     (+3.2% vs +1.6%) at equal win rate. Trade-off: longer holds. See the study.
  // A stop breach on a completed daily bar (replay) is the day's LOW piercing the
  // stop; on a live snapshot it's the current price. Fill: a gap through the stop
  // at the open fills at the open; an intraday touch is assumed filled at the stop.
  let exitPrice = null, exitReason = null;
  if (o.stopPrice != null) {
    const low = newRow.low > 0 ? newRow.low : null;
    const breachRef = low != null ? low : newRow.price;
    if (breachRef > 0 && breachRef <= o.stopPrice) {
      if (newRow.open > 0 && newRow.open <= o.stopPrice) exitPrice = newRow.open; // gapped below at the open
      else if (low != null) exitPrice = o.stopPrice;                              // intraday touch
      else exitPrice = Math.min(newRow.price, o.stopPrice);                       // live snapshot
      exitReason = "STOP";
    }
  }
  if (exitReason == null) {
    if (newRow.verdict !== "SELL") return log;
    exitPrice = newRow.price;
    exitReason = "SELL";
  }

  const pnlPct = Math.round(((exitPrice - o.entryPrice) / o.entryPrice) * 100 * 100) / 100;
  const closed = {
    sym: o.sym,
    entryAt: o.entryAt,
    entryScoredAt: o.entryScoredAt,
    entryPrice: o.entryPrice,
    entryPriceIsLive: o.entryPriceIsLive,
    stopPrice: o.stopPrice ?? null,
    exitAt: new Date().toISOString(),
    exitScoredAt: newRow.scored_at || null,
    exitPrice,
    exitPriceIsLive: !!newRow.priceIsLive,
    exitReason, // "STOP" or "SELL"
    pnlPct,
    holdDays: holdDaysBetween(o.entryScoredAt || o.entryAt, newRow.scored_at || new Date().toISOString()),
  };

  log.closed = [closed, ...log.closed].slice(0, MAX_CLOSED);
  log.open = null;
  return log;
}
/* ===== END QUICK SWING FEATURE ===== */
