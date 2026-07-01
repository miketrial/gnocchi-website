/* ===== QUICK SWING FEATURE ===== (removable — see checklist in
   netlify/lib/quickswing-pipeline.mjs) */
import { deleteQuickswingRow } from "../lib/store.mjs";

export default async (req) => {
  if (req.method !== "DELETE") return new Response("Method not allowed", { status: 405 });
  const ticker = decodeURIComponent(new URL(req.url).pathname.split("/").pop() || "");
  if (!ticker) return new Response("Missing ticker", { status: 400 });
  await deleteQuickswingRow(ticker);
  return Response.json({ ok: true, ticker: ticker.toUpperCase() });
};
