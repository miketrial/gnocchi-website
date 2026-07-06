/* ===== QUICK SWING FEATURE =====
   Scheduled dispatcher for the real-time Telegram alerts. Fires every 5 minutes
   (Netlify Scheduled Function, cron in UTC), decides whether the current ET
   moment is a session we alert on, and if so kicks off the alert worker
   (quickswing-alert-background.mjs) fire-and-forget.

   All the "when do we run" logic lives in decideWindow() in
   netlify/lib/quickswing-alert.mjs (pure + unit-tested). Off-window fires
   return immediately having spent zero FMP calls.
   Removable with the rest of the QUICK SWING FEATURE block. */
import { decideWindow } from "../lib/quickswing-alert.mjs";

export const config = { schedule: "*/5 * * * *" };

export default async () => {
  const { run, session } = decideWindow(new Date());
  if (!run) {
    return new Response("", { status: 204 });
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
