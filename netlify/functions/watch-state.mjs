import { getWatchState, setWatchState } from "../lib/store.mjs";

// GET  /api/watch-state → { flags, demoted, activity, sigHistory }
// PUT  /api/watch-state → body { flags, demoted, activity, sigHistory } → persists and echoes back
//
// sigHistory: { [SYM]: [{ ts, T, V, P }, ...] } — capped at 100 entries per
// ticker server-side. Powers the per-ticker TVP timeline chart and the
// 24h "was green, now off" yellow badge state.
const SIG_HIST_CAP = 100;
export default async (req) => {
  if (req.method === "GET") {
    return Response.json(await getWatchState());
  }
  if (req.method === "PUT") {
    const body = await req.json().catch(() => ({}));
    const flags    = (body.flags    && typeof body.flags    === 'object') ? body.flags    : {};
    const demoted  = (body.demoted  && typeof body.demoted  === 'object') ? body.demoted  : {};
    const activity = Array.isArray(body.activity) ? body.activity.slice(0, 50) : [];
    const sigHistory = {};
    if (body.sigHistory && typeof body.sigHistory === 'object') {
      for (const [sym, entries] of Object.entries(body.sigHistory)) {
        if (!Array.isArray(entries)) continue;
        sigHistory[sym] = entries.slice(-SIG_HIST_CAP).map(e => {
          const out = {
            ts: +e.ts || Date.now(),
            T:  !!e.T,
            V:  !!e.V,
            P:  !!e.P,
          };
          // price snapshot at the time of the scan — drives backtest returns
          const p = +e.price;
          if (Number.isFinite(p) && p > 0) out.price = p;
          return out;
        });
      }
    }
    await setWatchState({ flags, demoted, activity, sigHistory });
    return Response.json({ flags, demoted, activity, sigHistory });
  }
  return new Response("Method not allowed", { status: 405 });
};

export const config = { path: "/api/watch-state" };
