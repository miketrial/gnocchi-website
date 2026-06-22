import { getHaikuUsage, haikuCap } from "../lib/store.mjs";

// GET /api/usage → today's Anthropic (Haiku) spend-cap status.
export default async () => {
  const used = await getHaikuUsage().catch(() => 0);
  const cap = haikuCap();
  const remaining = Math.max(0, cap - used);
  return Response.json({
    date: new Date().toISOString().slice(0, 10),
    used,
    cap,
    remaining,
    capped: used >= cap,
    // rough cost estimate at ~$0.12 per Haiku web-search call
    est_cost_usd: Math.round(used * 0.12 * 100) / 100,
  });
};
