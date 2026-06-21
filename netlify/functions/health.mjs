import { probeFmpHealth } from "../lib/health.mjs";

// GET /api/health → live probe of FMP's CDN for the sym-flip condition.
export default async () => {
  const result = await probeFmpHealth();
  const code = result.status === "error" ? 500 : 200;
  return Response.json(result, { status: code });
};
