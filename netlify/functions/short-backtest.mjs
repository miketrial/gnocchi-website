/* ===== SWING BACKTEST FEATURE ===== (removable — see checklist in
   netlify/lib/short-backtest.mjs)
   Returns the per-ticker swing as-if trade logs for the Swing view's Backtest
   popover. Pure read — the logs are written by the short rescan loop and the
   lazy seed endpoint. */
import { listShortTrades } from "../lib/store.mjs";

export default async () => {
  const logs = await listShortTrades();
  return new Response(JSON.stringify(logs), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
