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
import { mergeSeed, pruneTradeWindow } from "../lib/quickswing-backtest.mjs";

const BATCH = 4; // tickers seeded per request — keeps each call well under the timeout

export default async () => {
  const rows = await listQuickswingRows().catch(() => []);
  const syms = rows.map(r => r?.sym).filter(Boolean);

  // Pending = tracked tickers whose log hasn't had the one-time seed yet.
  const pending = [];
  for (const sym of syms) {
    const log = await getQuickswingTrades(sym).catch(() => null);
    if (!log || log.seeded !== true) pending.push(sym);
  }

  const batch = pending.slice(0, BATCH);
  const seeded = [];
  if (batch.length) {
    const regime = await getMarketRegime().catch(() => null);
    for (const sym of batch) {
      try {
        const existing = await getQuickswingTrades(sym).catch(() => null);
        const seed = await seedQuickSwingBacktest(sym, { spyHist: regime?.hist });
        const merged = pruneTradeWindow(mergeSeed(existing, seed));
        merged.seeded = true; // pruneTradeWindow preserves this, but set explicitly for clarity
        await putQuickswingTrades(sym, merged);
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
