/* ===== QUICK SWING FEATURE =====
   Scheduled dispatcher for the real-time Telegram alerts. Fires every 5 minutes
   (Netlify Scheduled Function, cron in UTC), decides whether the current ET
   moment is a session we alert on, and if so kicks off the alert worker
   (quickswing-alert-background.mjs) fire-and-forget.

   All the "when do we run" logic lives in decideWindow() in
   netlify/lib/quickswing-alert.mjs (pure + unit-tested). Off-window fires
   return immediately having spent zero FMP calls.
   Removable with the rest of the QUICK SWING FEATURE block. */
import { decideWindow, etDateStr, etClockLabel, evaluateWatchdog } from "../lib/quickswing-alert.mjs";
import { getQsHeartbeat, getQsWatchdog, putQsWatchdog } from "../lib/store.mjs";
import { sendTelegram } from "../lib/telegram.mjs";

export const config = { schedule: "*/5 * * * *" };

// A stale heartbeat = the worker isn't running. Session-aware: regular hours run
// every 5 min (~3 missed = 16 min); after-hours only every 15 min, so allow more.
const STALE_REGULAR_MS = 16 * 60 * 1000;
const STALE_AH_MS = 32 * 60 * 1000;

export default async () => {
  const { run, session } = decideWindow(new Date());
  if (!run) {
    return new Response("", { status: 204 });
  }

  // Silent-loop watchdog — this cron fires reliably even when the fire-and-forget
  // worker is dead, so it is the only place that can notice the loop went dark.
  // We anchor a grace period on the FIRST in-window dispatch today: that avoids a
  // false alarm on the day's first tick (which legitimately sees a prior-day
  // heartbeat), AND — unlike a "same-day heartbeat" gate — still catches a worker
  // that has been dead since before today once we've been dispatching for the
  // stale window with no fresh heartbeat. Alerts ONCE per stuck heartbeat and
  // tracks today's worst gap for the close-of-day health footer.
  try {
    const nowMs = Date.now();
    const today = etDateStr(new Date());
    const hb = await getQsHeartbeat();
    const wd = await getQsWatchdog();
    const { shouldAlert, hbAge, dispatchAge, nextState } = evaluateWatchdog({
      hbTs: hb?.ts, wd, nowMs, session, today,
      staleRegularMs: STALE_REGULAR_MS, staleAhMs: STALE_AH_MS,
    });
    if (shouldAlert) {
      const since = hb?.ts ? etClockLabel(new Date(hb.ts)) : "before today";
      const mins = Math.round((hb?.ts ? hbAge : dispatchAge) / 60000);
      await sendTelegram(`⚠️ <b>Bounce scan silent</b> — no successful run since ${since} (~${mins} min). The 5-min alert loop may be down.`);
    }
    await putQsWatchdog(nextState);
  } catch (e) {
    console.error("[qs-alert-cron] watchdog:", e?.message || e);
  }

  // Netlify sets URL (production) / DEPLOY_PRIME_URL (Deploy Previews) to the
  // site's base URL. Invoke the worker by its function path — a background
  // function returns 202 instantly and continues the scan asynchronously.
  const base = process.env.DEPLOY_PRIME_URL || process.env.URL || "";
  try {
    await fetch(`${base}/.netlify/functions/quickswing-alert-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session }),
    });
  } catch (e) {
    console.error("[qs-alert-cron] failed to dispatch worker:", e?.message || e);
  }
  return new Response("", { status: 202 });
};
