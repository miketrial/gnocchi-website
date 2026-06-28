import { getWatchState, setWatchState } from "../lib/store.mjs";

// GET  /api/watch-state → { flags, demoted, activity }
// PUT  /api/watch-state → body { flags, demoted, activity } → persists and echoes back
export default async (req) => {
  if (req.method === "GET") {
    return Response.json(await getWatchState());
  }
  if (req.method === "PUT") {
    const body = await req.json().catch(() => ({}));
    const flags    = (body.flags    && typeof body.flags    === 'object') ? body.flags    : {};
    const demoted  = (body.demoted  && typeof body.demoted  === 'object') ? body.demoted  : {};
    const activity = Array.isArray(body.activity) ? body.activity.slice(0, 50) : [];
    await setWatchState({ flags, demoted, activity });
    return Response.json({ flags, demoted, activity });
  }
  return new Response("Method not allowed", { status: 405 });
};

export const config = { path: "/api/watch-state" };
