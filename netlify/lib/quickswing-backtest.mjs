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
export const BT_WINDOW_DAYS = 50; // rolling window: trades older than this drop off
export const BT_SEED_DAYS = 15;   // history backfilled the first time a ticker is added
// Bump when the scoring calibration OR exit rule changes so already-seeded logs
// get a one-time re-seed (they'd otherwise keep showing trades from the old rules).
// v2: extreme-read override + 0.30 weak threshold + 0.85 BUY regime penalty.
// v3: exit on SELL (not on the first non-BUY read).
export const BT_SEED_VERSION = 3;

export function emptyLog() {
  return { open: null, closed: [] };
}

/* A log needs (re)seeding if it's missing or was seeded under an older
   calibration version. */
export function needsSeed(log) {
  return !log || log.seedVersion !== BT_SEED_VERSION;
}

/* Rolling-window prune: drop closed trades whose exit is older than `days` ago,
   measured from now. A freshly-seeded ticker carries ~15 days of history (all
   inside the window, so nothing drops); as forward days accumulate the window
   fills toward 50, then rolls — the oldest day falling off as each new one is
   added. The open position is never pruned. */
export function pruneTradeWindow(log, days = BT_WINDOW_DAYS) {
  if (!log || typeof log !== "object") return emptyLog();
  const cutoff = Date.now() - days * 86400000;
  const closed = (Array.isArray(log.closed) ? log.closed : []).filter(t => {
    const ts = Date.parse(t.exitScoredAt || t.exitAt);
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
      log.open = {
        sym: newRow.sym,
        entryAt: new Date().toISOString(),
        entryScoredAt: newRow.scored_at || null,
        entryPrice: newRow.price,
        entryPriceIsLive: !!newRow.priceIsLive,
      };
    }
    return log;
  }

  // In a trade: hold until the verdict flips to SELL (an actual overbought
  // reversal). NEUTRAL just means "no longer stretched" — not a reason to bail.
  // Backtested across 14 tickers / 250 sessions, exiting on SELL rather than on
  // the first non-BUY read roughly DOUBLED avg P/L per trade (+3.2% vs +1.6%)
  // at an equal win rate, and made every exit a clean, single-meaning signal.
  // Trade-off: longer holds (~4.6d vs ~1.8d). See the calibration study.
  if (newRow.verdict !== "SELL") return log;

  const o = log.open;
  const exitPrice = newRow.price;
  const pnlPct = Math.round(((exitPrice - o.entryPrice) / o.entryPrice) * 100 * 100) / 100;
  const closed = {
    sym: o.sym,
    entryAt: o.entryAt,
    entryScoredAt: o.entryScoredAt,
    entryPrice: o.entryPrice,
    entryPriceIsLive: o.entryPriceIsLive,
    exitAt: new Date().toISOString(),
    exitScoredAt: newRow.scored_at || null,
    exitPrice,
    exitPriceIsLive: !!newRow.priceIsLive,
    exitReason: newRow.verdict, // always SELL under the current exit rule
    pnlPct,
    holdDays: holdDaysBetween(o.entryScoredAt || o.entryAt, newRow.scored_at || new Date().toISOString()),
  };

  log.closed = [closed, ...log.closed].slice(0, MAX_CLOSED);
  log.open = null;
  return log;
}
/* ===== END QUICK SWING FEATURE ===== */
