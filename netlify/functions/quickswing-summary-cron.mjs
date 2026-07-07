/* ===== QUICK SWING FEATURE =====
   Scheduled dispatcher for the HOURLY Telegram summary. Fires at the top of every
   hour (Netlify Scheduled Function, cron in UTC — minute 0 UTC == minute 0 ET),
   asks summaryWindow() whether this ET slot is one we summarize on (weekday
   10:00–16:00 ET), and if so kicks off the summary worker fire-and-forget.

   All "when do we run" logic lives in summaryWindow() in
   netlify/lib/quickswing-summary.mjs (pure + unit-testable). Off-window fires
   return immediately having spent zero FMP calls.
   Removable with the rest of the QUICK SWING FEATURE block. */
import { summaryWindow } from "../lib/quickswing-summary.mjs";

export const config = { schedule: "0 * * * *" };

export default async () => {
  const { run, label } = summaryWindow(new Date());
  if (!run) {
    return new Response("", { status: 204 });
  }

  // Netlify sets URL (production) / DEPLOY_PRIME_URL (Deploy Previews) to the
  // site's base URL. Invoke the worker by its function path — a background
  // function returns 202 instantly and continues asynchronously.
  const base = process.env.DEPLOY_PRIME_URL || process.env.URL || "";
  try {
    await fetch(`${base}/.netlify/functions/quickswing-summary-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label }),
    });
  } catch (e) {
    console.error("[qs-summary-cron] failed to dispatch worker:", e?.message || e);
  }
  return new Response("", { status: 202 });
};
