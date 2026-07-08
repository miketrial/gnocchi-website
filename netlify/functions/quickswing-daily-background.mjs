/* ===== QUICK SWING FEATURE =====
   Daily "Top 500 Most-Active" morning scan → auto Top-N for the Bounce tab.

   Once each morning (fired ~9:45 ET by quickswing-daily-cron.mjs, or on demand
   from the "Scan Top N now" button), this:
     1. Resolves the ~500 most-active US companies (getTop500MostActive → one
        company-screener call ranked by dollar-volume).
     2. Fetches the market regime once (SPY/VIX, cached 6h) and scores every name
        through the SAME Bounce pipeline the manual watchlist uses, under a bounded
        concurrency pool. FMP pacing is enforced globally by the token bucket in
        fmp-client.mjs (~270/min), so ~2,000 calls land in ~7-8 min, inside the
        15-min background-fn ceiling.
     3. Ranks by buy score, keeps the top N, and REPLACES the qs-daily list
        wholesale (yesterday's picks are dropped).
     4. Sends ONE separate Telegram message (its own header/time — never touches
        the hourly watchlist summary or the 5-min alerts).

   The kept top-N then ride the existing 5-min alert loop (see
   quickswing-alert-background.mjs) for live rescoring + verdict alerts until the
   next morning's scan replaces them. Removable with the QUICK SWING FEATURE block. */
import { scoreTickerQuickSwing, getMarketRegime } from "../lib/quickswing-pipeline.mjs";
import { getTop500MostActive } from "../lib/qs-universe.mjs";
import { replaceQsDaily, acquireLock, releaseLock } from "../lib/store.mjs";
import { fmpCallCount } from "../lib/fmp-client.mjs";
import { sendTelegram } from "../lib/telegram.mjs";
import { formatDailyTop } from "../lib/quickswing-summary.mjs";
import { etDateStr, etClockLabel } from "../lib/quickswing-alert.mjs";

const TOP_N = Number(process.env.QS_DAILY_TOP_N || 15);   // picks kept + alerted
const POOL = Number(process.env.QS_DAILY_POOL || 10);     // symbols in flight (FMP paced globally)
const LOCK_MS = 16 * 60 * 1000;                           // > 15-min bg ceiling, so no stacked fan-out

const numBuy = (row) => {
  const n = parseInt(String(row?.buyScore ?? "").split("/")[0], 10);
  return Number.isFinite(n) ? n : -1;
};
const numSell = (row) => {
  const n = parseInt(String(row?.sellScore ?? "").split("/")[0], 10);
  return Number.isFinite(n) ? n : 0;
};

// Bounded concurrency pool: `size` workers each pull from a shared cursor. The
// real per-second FMP rate is capped by fmp-client's global token bucket — this
// only limits how many symbols sit mid-flight (vs. holding 500 promises at once).
async function pooled(items, worker, size) {
  const results = new Array(items.length);
  let idx = 0;
  async function run() {
    while (idx < items.length) {
      const i = idx++;
      try { results[i] = await worker(items[i], i); }
      catch { results[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(size, items.length)) }, run));
  return results;
}

export default async (req) => {
  const body = await req.json().catch(() => ({}));
  const force = !!body.force;
  const topN = Number(body.n) > 0 ? Number(body.n) : TOP_N;
  // Universe size — defaults to the full 500. A small value (e.g. {universe:8})
  // lets a manual/test run exercise the whole path without a ~2,000-call fan-out.
  const universeN = Number(body.universe) > 0 ? Number(body.universe) : 500;

  const jobId = `qs-daily-${Date.now()}`;
  const gotLock = await acquireLock("qs-daily-scan", jobId, LOCK_MS);
  if (!gotLock) {
    console.log("[qs-daily] a daily scan is already in progress — skipping");
    return new Response("", { status: 202 });
  }

  const started = Date.now();
  const callsBefore = fmpCallCount();
  try {
    const day = etDateStr(new Date());
    const [universe, regime] = await Promise.all([
      getTop500MostActive({ n: universeN, day, forceRefresh: force }).catch(() => []),
      getMarketRegime().catch(() => null),
    ]);

    if (!universe.length) {
      console.error("[qs-daily] empty universe — aborting (screener returned nothing)");
      return new Response("", { status: 202 });
    }

    const rows = await pooled(
      universe,
      (sym) => scoreTickerQuickSwing(sym, { skipCache: true, marketRegime: regime }).catch(() => null),
      POOL,
    );

    const scored = rows.filter(Boolean);
    // Rank by buy score (desc); tie-break by lower sell score so a cleaner
    // one-sided bullish read wins the tie. Keep the top N.
    const top = scored
      .slice()
      .sort((a, b) => numBuy(b) - numBuy(a) || numSell(a) - numSell(b))
      .slice(0, topN);

    await replaceQsDaily(top).catch((e) => console.error("[qs-daily] replaceQsDaily failed:", e?.message || e));

    try {
      await sendTelegram(formatDailyTop({
        rows: top, regime, label: etClockLabel(new Date()), scanned: scored.length,
      }));
    } catch (e) { console.error("[qs-daily] telegram failed:", e?.message || e); }

    const elapsedS = (Date.now() - started) / 1000;
    const calls = fmpCallCount() - callsBefore;
    const rate = elapsedS > 0 ? (calls / (elapsedS / 60)) : 0;
    console.log(`[qs-daily] day=${day} universe=${universe.length} scored=${scored.length} kept=${top.length} `
      + `calls=${calls} elapsed=${elapsedS.toFixed(0)}s rate=${rate.toFixed(0)}/min`);
  } catch (e) {
    console.error("[qs-daily] scan failed:", e?.message || e);
  } finally {
    await releaseLock("qs-daily-scan", jobId);
  }

  return new Response("", { status: 202 });
};
