/* ===== QUICK SWING FEATURE ===== (removable — see checklist in
   netlify/lib/quickswing-pipeline.mjs) */
import { listQuickswingTrades } from "../lib/store.mjs";

export default async () => {
  const logs = await listQuickswingTrades();
  return new Response(JSON.stringify(logs), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
