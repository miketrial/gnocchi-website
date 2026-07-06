/* ===== QUICK SWING FEATURE =====
   1-2 day mean-reversion view. Self-contained and independently removable —
   see the removal checklist in netlify/lib/quickswing-pipeline.mjs. */
import { scoreTickerQuickSwing, getMarketRegime } from "../lib/quickswing-pipeline.mjs";
import { recordQuickswingTransition, pruneTradeWindow, annotateBenchmarks } from "../lib/quickswing-backtest.mjs";
import { listQuickswingRows, putQuickswingRow, getQuickswingTrades, putQuickswingTrades, putJob, acquireRescanLock, releaseRescanLock } from "../lib/store.mjs";

export default async (req) => {
  const { jobId, force, tickers: onlyTickers, clientTickers } = await req.json().catch(() => ({}));
  if (!jobId) return new Response("Missing jobId", { status: 400 });

  // Single-ticker adds bypass the lock — same reasoning as short-rescan-background.
  // Uses the SAME global lock as Basic/Short Term (by design — it exists to
  // stop overlapping full-watchlist fan-outs from stacking regardless of
  // which view triggered them, not to isolate one view from another).
  const isSingleTicker = onlyTickers && onlyTickers.length === 1;
  if (!isSingleTicker) {
    const gotLock = await acquireRescanLock(jobId);
    if (!gotLock) {
      await putJob(jobId, { status: "error", error: "A rescan is already in progress — try again in a moment." });
      return new Response("", { status: 202 });
    }
  }

  try {
    return await runQuickSwingScan({ jobId, force, onlyTickers, clientTickers });
  } finally {
    if (!isSingleTicker) await releaseRescanLock(jobId);
  }
};

async function runQuickSwingScan({ jobId, force, onlyTickers, clientTickers }) {
  // Quick Swing tracks its OWN ticker list, independent of Basic/Short Term's
  // shared watchlist — a good 2-12wk trend hold and a good 1-2 day mean-
  // reversion candidate are often different companies entirely. "Existing"
  // here means "already tracked by Quick Swing" (has a qs-rows entry), not
  // "on the Basic watchlist."
  const existing = await listQuickswingRows();
  const storedSyms = new Set(existing.map(r => r.sym));
  const extraSyms = (clientTickers || []).filter(s => !storedSyms.has(s));
  const allSyms = [...existing.map(r => r.sym), ...extraSyms];

  const targets = (onlyTickers && onlyTickers.length) ? onlyTickers : allSyms;
  const total = allSyms.length;
  const rows = [];
  await putJob(jobId, { status: "running", total, completed: 0, rows });

  // Market regime (SPY vs its own trend + distribution-day count) is a
  // portfolio-wide read, not a per-ticker one — fetch/compute it ONCE for
  // the whole batch and hand the same object to every ticker, rather than
  // re-deriving (and re-hitting the SPY cache) 40+ times in a row.
  const regime = await getMarketRegime().catch(() => null);

  for (const sym of allSyms) {
    if (!targets.includes(sym)) continue;
    try {
      const skipCache = !!force || !!(onlyTickers && onlyTickers.length);
      const row = await scoreTickerQuickSwing(sym, { skipCache, marketRegime: regime });
      await putQuickswingRow(sym, row).catch(() => {});
      // Fold this scan into the ticker's "as-if" paper-trade log — opens a
      // paper long on a BUY verdict, closes it the moment the verdict stops
      // being BUY. This uses the row we JUST scored, so it costs no extra FMP
      // calls. The heavier 15-day historical backfill is NOT done here — it's
      // seeded lazily the first time the user opens the Backtest popover (see
      // quickswing-backtest-seed.mjs), to keep rescans cheap. Best-effort: a
      // store hiccup must not fail the scan.
      try {
        let log = await getQuickswingTrades(sym);
        log = recordQuickswingTransition(row, log);
        log = pruneTradeWindow(log);
        annotateBenchmarks(log, regime?.hist); // tag any newly-closed trade with its SPY-same-days return
        await putQuickswingTrades(sym, log);
      } catch (e) { /* backtest log is non-critical — ignore */ }
      rows.push(row);
    } catch (e) {
      rows.push({ sym, error: String(e?.message || e) });
    }
    await putJob(jobId, { status: "running", total, completed: rows.length, rows });
  }

  await putJob(jobId, { status: "done", total, completed: rows.length, rows });
  return new Response("", { status: 202 });
}
