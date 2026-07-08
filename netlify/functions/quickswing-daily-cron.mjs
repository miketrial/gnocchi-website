/* ===== QUICK SWING FEATURE =====
   Scheduled dispatcher for the daily Most-Active Bounce scan. Netlify cron
   runs in UTC with no DST awareness, so we schedule at BOTH 13:45 and 14:45 UTC
   (the two wall-clock times that map to 09:45 ET across DST) and gate in code:
   only the fire whose ET clock reads 09:45 on a weekday dispatches the worker;
   the other (08:45 ET in winter / 10:45 ET in summer) returns immediately having
   spent zero FMP. Mirrors the ET-gating pattern in quickswing-alert-cron.mjs.
   Removable with the rest of the QUICK SWING FEATURE block. */
import { etParts, etDateStr } from "../lib/quickswing-alert.mjs";
import { isMarketHoliday } from "../lib/market-calendar.mjs";

export const config = { schedule: "45 13,14 * * 1-5" };

export default async () => {
  const now = new Date();
  const { weekday, hour, minute } = etParts(now);
  const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday);
  // 09:45 ET, tolerant of Netlify cron jitter. Only ONE of the two UTC fires maps
  // to ET hour 9 (the other is hour 8 or 10), so gating on hour===9 && minute>=44
  // fires once even if delivery slips several minutes late — a tight ±1-min gate
  // would drop the whole day's scan on jitter. A double-dispatch (e.g. :45 and
  // :50 both matching) is harmless: the daily-scan lock rejects the second.
  const inWindow = isWeekday && hour === 9 && minute >= 44 && !isMarketHoliday(etDateStr(now));
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
