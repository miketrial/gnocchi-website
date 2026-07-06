/* ===== QUICK SWING FEATURE ===== (removable — see checklist in
   netlify/lib/quickswing-pipeline.mjs)

   Lazy, on-demand historical backfill for the Bounce backtest log. Called from
   the client only when the user opens the Backtest popover — never during a
   rescan — so the expensive per-ticker replay fetch (historical prices +
   earnings) is paid for at most once per ticker, and only if someone actually
   looks at the log.

   Seeds a small BATCH of not-yet-seeded tickers per request and reports how
   many remain, so the client can loop without any single invocation running
   long enough to hit the function timeout. */
import { listQuickswingRows, getQuickswingTrades, putQuickswingTrades } from "../lib/store.mjs";
import { seedQuickSwingBacktest, getMarketRegime } from "../lib/quickswing-pipeline.mjs";
import { mergeSeed, pruneTradeWindow, needsSeed, BT_SEED_VERSION, BT_SEED_DAYS, BT_WINDOW_DAYS } from "../lib/quickswing-backtest.mjs";

const BATCH = 4; // tickers seeded per request — keeps each call well under the timeout

export default async () => {
  const rows = await listQuickswingRows().catch(() => []);
  const syms = rows.map(r => r?.sym).filter(Boolean);

  // Pending = tracked tickers not yet seeded, OR seeded under an older
  // scoring-calibration version (needsSeed handles the version check).
  const pending = [];
  for (const sym of syms) {
    const log = await getQuickswingTrades(sym).catch(() => null);
    if (needsSeed(log)) pending.push(sym);
  }

  const batch = pending.slice(0, BATCH);
  const seeded = [];
  if (batch.length) {
    const regime = await getMarketRegime().catch(() => null);
    for (const sym of batch) {
      try {
        const existing = await getQuickswingTrades(sym).catch(() => null);
        // A version bump means the scoring or exit rule changed, so any trades
        // already in the log were booked under the OLD rule. Merging would keep
        // those stale trades (their entries don't line up with the new rule's),
        // so instead REPLACE: replay the whole visible window fresh under the
        // new rule. A genuine first-time seed still merges the 15-day backfill
        // with whatever forward-recording booked under the current rule.
        const isReseed = existing && existing.seedVersion != null && existing.seedVersion !== BT_SEED_VERSION;
        let next;
        if (isReseed) {
          const seed = await seedQuickSwingBacktest(sym, { daysBack: BT_WINDOW_DAYS, spyHist: regime?.hist });
          next = pruneTradeWindow({ open: seed.open, closed: seed.closed, seeded: true, seedVersion: BT_SEED_VERSION });
        } else {
          const seed = await seedQuickSwingBacktest(sym, { daysBack: BT_SEED_DAYS, spyHist: regime?.hist });
          next = pruneTradeWindow(mergeSeed(existing, seed));
        }
        next.seeded = true;
        next.seedVersion = BT_SEED_VERSION;
        await putQuickswingTrades(sym, next);
        seeded.push(sym);
      } catch (e) {
        // Leave this ticker unseeded so a later open retries it — don't wedge the batch.
        console.error(`[quickswing] ${sym} lazy-seed error:`, e?.message || e);
      }
    }
  }

  const remaining = Math.max(0, pending.length - seeded.length);
  return new Response(JSON.stringify({ seeded, remaining }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
