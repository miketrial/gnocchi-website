/* ===== QUICK SWING FEATURE =====
   Real-time alert worker. Re-scores the Quick Swing watchlist, diffs each
   verdict against the last one we alerted on (qs-alert-state), and pushes a
   Telegram message on genuine entry/exit transitions. Invoked (fire-and-forget)
   by the scheduled dispatcher quickswing-alert-cron.mjs during market hours.

   Reuses the exact same scoring call as the manual rescan
   (rescan-background.mjs:58) so the alerting verdict can never drift from what
   the app's table shows. Background function (name ends "-background") → up to
   15 min runtime, comfortably covering the sequential, self-paced FMP fan-out.
   Removable with the rest of the QUICK SWING FEATURE block. */
import { scoreTickerQuickSwing, getMarketRegime } from "../lib/quickswing-pipeline.mjs";
import {
  listQuickswingRows, putQuickswingRow,
  getQsAlertState, putQsAlertState,
  acquireRescanLock, releaseRescanLock,
} from "../lib/store.mjs";
import { sendTelegram } from "../lib/telegram.mjs";
import { alertTransition, formatAlert } from "../lib/quickswing-alert.mjs";

export default async (req) => {
  const { session = "regular" } = await req.json().catch(() => ({}));

  // Share the global rescan lock: if a manual rescan (or a previous alert cycle
  // that overran) is in flight, skip this tick rather than double the FMP
  // fan-out. The next 5-min fire will pick up any transition we missed.
  const jobId = `qs-alert-${Date.now()}`;
  const gotLock = await acquireRescanLock(jobId);
  if (!gotLock) {
    console.log("[qs-alert] rescan in progress — skipping this cycle");
    return new Response("", { status: 202 });
  }

  let scored = 0, alerted = 0;
  try {
    const regime = await getMarketRegime().catch(() => null);
    const watchlist = await listQuickswingRows();

    for (const { sym } of watchlist) {
      try {
        const row = await scoreTickerQuickSwing(sym, { skipCache: true, marketRegime: regime });
        await putQuickswingRow(sym, row).catch(() => {}); // keep the app table fresh
        scored++;

        const prev = await getQsAlertState(sym).then((s) => s?.verdict ?? null).catch(() => null);
        const { fire, kind, changed } = alertTransition(prev, row.verdict);
        if (fire) {
          await sendTelegram(formatAlert(row, kind, session));
          alerted++;
        }
        if (changed) await putQsAlertState(sym, row.verdict).catch(() => {});
      } catch (e) {
        console.error(`[qs-alert] ${sym} failed:`, e?.message || e);
      }
    }
  } finally {
    await releaseRescanLock(jobId);
  }

  console.log(`[qs-alert] session=${session} scored=${scored} alerted=${alerted}`);
  return new Response("", { status: 202 });
};
