/* ===== QUICK SWING FEATURE =====
   Background REFRESH worker. Re-scores the Bounce watchlist ∪ daily Top-N every 5
   min (fired by quickswing-alert-cron.mjs during market hours) and writes each
   fresh row back to its store, so the Bounce tab shows current prices/verdicts on
   the next load. This worker used to also push real-time Telegram alerts; that
   layer was removed (the alerts weren't earning their keep) and it now does
   refresh only. Removable with the rest of the QUICK SWING FEATURE block. */
import { scoreTickerQuickSwing, getMarketRegime } from "../lib/quickswing-pipeline.mjs";
import {
  listQuickswingRows, listQsDaily, putQuickswingRow, putQsDailyRow,
  isLockHeld, acquireRescanLock, releaseRescanLock,
} from "../lib/store.mjs";

export default async (req) => {
  const { session = "regular" } = await req.json().catch(() => ({}));

  // Share the global rescan lock: if a manual rescan (or a previous refresh cycle
  // that overran) is in flight, skip this tick rather than double the FMP fan-out.
  const jobId = `qs-alert-${Date.now()}`;
  const gotLock = await acquireRescanLock(jobId);
  if (!gotLock) {
    console.log("[qs-alert] rescan in progress — skipping this cycle");
    return new Response("", { status: 202 });
  }

  let scored = 0;
  try {
    // Don't mirror rows into qs-daily while the morning daily scan is mid-replace
    // (different lock) — otherwise a refresh-tick write can resurrect a name the
    // scan just dropped. The daily worker rewrites qs-daily itself during its run.
    const dailyScanRunning = await isLockHeld("qs-daily-scan").catch(() => false);
    const regime = await getMarketRegime().catch(() => null);
    const [manual, daily] = await Promise.all([
      listQuickswingRows(),
      listQsDaily().catch(() => []),
    ]);
    const manualSet = new Set(manual.map((r) => r?.sym).filter(Boolean));
    const dailySet = new Set(daily.map((r) => r?.sym).filter(Boolean));
    // Union of both lists — a dual-listed name is scored once and mirrored to both.
    const syms = new Set([...manualSet, ...dailySet]);

    for (const sym of syms) {
      try {
        const row = await scoreTickerQuickSwing(sym, { skipCache: true, marketRegime: regime });
        // Write each fresh row back to the store(s) it belongs to (no leakage of
        // auto names into the manual watchlist; a name in both mirrors to daily).
        if (manualSet.has(sym)) await putQuickswingRow(sym, row).catch(() => {});
        if (dailySet.has(sym) && !dailyScanRunning) await putQsDailyRow(sym, row).catch(() => {});
        scored++;
      } catch (e) {
        console.error(`[qs-alert] ${sym} failed:`, e?.message || e);
      }
    }
  } finally {
    await releaseRescanLock(jobId);
  }

  console.log(`[qs-alert] session=${session} scored=${scored} (refresh-only)`);
  return new Response("", { status: 202 });
};
