/* ===== QUICK SWING FEATURE =====
   Scheduled dispatcher for the daily Most-Active 500 Bounce scan. Netlify cron
   runs in UTC with no DST awareness, so we schedule at BOTH 13:45 and 14:45 UTC
   (the two wall-clock times that map to 09:45 ET across DST) and gate in code:
   only the fire whose ET clock reads 09:45 on a weekday dispatches the worker;
   the other (08:45 ET in winter / 10:45 ET in summer) returns immediately having
   spent zero FMP. Mirrors the ET-gating pattern in quickswing-alert-cron.mjs.
   Removable with the rest of the QUICK SWING FEATURE block. */
import { etParts } from "../lib/quickswing-alert.mjs";

export const config = { schedule: "45 13,14 * * 1-5" };

export default async () => {
  const { weekday, hour, minute } = etParts(new Date());
  const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday);
  // 09:45 ET, ±1 min for cron jitter. Exactly one of the two UTC fires lands
  // here; the other resolves to 08:45 or 10:45 ET and is skipped.
  const inWindow = isWeekday && hour === 9 && Math.abs(minute - 45) <= 1;
  if (!inWindow) return new Response("", { status: 204 });

  // Netlify sets URL (production) / DEPLOY_PRIME_URL (Deploy Previews) to the
  // site base URL. Background function returns 202 instantly and continues async.
  const base = process.env.DEPLOY_PRIME_URL || process.env.URL || "";
  try {
    await fetch(`${base}/.netlify/functions/quickswing-daily-background`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: "cron" }),
    });
  } catch (e) {
    console.error("[qs-daily-cron] failed to dispatch worker:", e?.message || e);
  }
  return new Response("", { status: 202 });
};
