/* ===== QUICK SWING FEATURE =====
   Scheduled dispatcher for the real-time Telegram alerts. Fires every 5 minutes
   (Netlify Scheduled Function, cron in UTC), decides whether the current ET
   moment is a session we alert on, and if so kicks off the alert worker
   (quickswing-alert-background.mjs) fire-and-forget.

   All the "when do we run" logic lives in decideWindow() in
   netlify/lib/quickswing-alert.mjs (pure + unit-tested). Off-window fires
   return immediately having spent zero FMP calls.
   Removable with the rest of the QUICK SWING FEATURE block. */
import { decideWindow, etDateStr, etClockLabel } from "../lib/quickswing-alert.mjs";
import { getQsHeartbeat, getQsWatchdog, putQsWatchdog } from "../lib/store.mjs";
import { sendTelegram } from "../lib/telegram.mjs";

export const config = { schedule: "*/5 * * * *" };

// ~3 missed 5-min cycles without a successful worker run = the loop is dark.
const STALE_MS = 16 * 60 * 1000;

export default async () => {
  const { run, session } = decideWindow(new Date());
  if (!run) {
    return new Response("", { status: 204 });
  }

  // Silent-loop watchdog — this cron fires reliably even when the fire-and-forget
  // worker is dead, so it is the only place that can notice the loop went dark.
  // Alert ONCE per stuck heartbeat; also track today's worst gap for the close-of-
  // day health footer. Runs BEFORE we (re)dispatch the worker below.
  try {
    const today = etDateStr(new Date());
    const hb = await getQsHeartbeat();
    const wd = await getQsWatchdog();
    // Only flag a gap when the last heartbeat is from TODAY — the day's first tick
    // legitimately has a stale (prior-day) heartbeat the worker is about to refresh.
    const sameDayHb = hb?.ts && etDateStr(new Date(hb.ts)) === today;
    const gapMs = sameDayHb ? (Date.now() - hb.ts) : 0;
    const stale = sameDayHb && gapMs > STALE_MS;
    const priorWorst = wd.day === today ? (wd.worstGapMs || 0) : 0;
    const worstGapMs = Math.max(priorWorst, gapMs);
    if (stale && wd.staleAlertedForTs !== hb.ts) {
      await sendTelegram(`⚠️ <b>Bounce scan silent</b> — no successful run since ${etClockLabel(new Date(hb.ts))} (~${Math.round(gapMs / 60000)} min). The 5-min alert loop may be down.`);
      await putQsWatchdog({ day: today, staleAlertedForTs: hb.ts, worstGapMs });
    } else {
      await putQsWatchdog({ day: today, staleAlertedForTs: stale ? wd.staleAlertedForTs : null, worstGapMs });
    }
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
