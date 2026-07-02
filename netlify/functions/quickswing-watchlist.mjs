/* ===== QUICK SWING FEATURE ===== (removable — see checklist in
   netlify/lib/quickswing-pipeline.mjs) */
import { listQuickswingRows } from "../lib/store.mjs";

export default async () => {
  const rows = await listQuickswingRows();
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
