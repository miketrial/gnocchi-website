import { getWatchState, setWatchState } from "../lib/store.mjs";

// GET  /api/watch-state → { flags, demoted, activity, sigHistory, held }
// PUT  /api/watch-state → body { flags, demoted, activity, sigHistory, held } → persists and echoes back
//
// sigHistory: { [SYM]: [{ ts, buy, cross, price }, ...] } — capped at 100 entries
// per ticker server-side. buy = all 5 backtest entry gates green that session;
// cross = 50/200 death cross that session. Powers the per-ticker entry-eligibility strip.
// held: { [SYM]: { enteredOnDate, at } } — the owned (Buy/Hold) set, shared site-wide.
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
    const held = (body.held && typeof body.held === 'object' && !Array.isArray(body.held)) ? body.held : {};
    const sigHistory = {};
    if (body.sigHistory && typeof body.sigHistory === 'object') {
      for (const [sym, entries] of Object.entries(body.sigHistory)) {
        if (!Array.isArray(entries)) continue;
        sigHistory[sym] = entries.slice(-SIG_HIST_CAP).map(e => {
          const out = {
            ts:    +e.ts || Date.now(),
            buy:   !!e.buy,    // all 5 entry gates green that session
            cross: !!e.cross,  // 50/200 death-cross exit that session
          };
          // price snapshot at the time of the scan
          const p = +e.price;
          if (Number.isFinite(p) && p > 0) out.price = p;
          return out;
        });
      }
    }
    await setWatchState({ flags, demoted, activity, sigHistory, held });
    return Response.json({ flags, demoted, activity, sigHistory, held });
  }
  return new Response("Method not allowed", { status: 405 });
};

export const config = { path: "/api/watch-state" };
