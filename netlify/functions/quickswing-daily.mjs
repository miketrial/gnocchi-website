/* ===== QUICK SWING FEATURE ===== (removable — see checklist in
   netlify/lib/quickswing-pipeline.mjs)
   GET the day's auto Top-N (Most-Active scan) rows for the Bounce tab's
   bottom section. Read-only — the list is written only by the 9:45 scan
   (quickswing-daily-background.mjs) and kept fresh by the 5-min alert loop. */
import { listQsDaily } from "../lib/store.mjs";

export default async () => {
  const rows = await listQsDaily();
  // Best buy-score first, matching the Telegram message ordering.
  const num = (s) => { const n = parseInt(String(s ?? "").split("/")[0], 10); return Number.isFinite(n) ? n : -1; };
  rows.sort((a, b) => num(b.buyScore) - num(a.buyScore));
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
