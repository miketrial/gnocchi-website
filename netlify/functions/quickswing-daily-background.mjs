/* ===== QUICK SWING FEATURE =====
   Daily "Top 500 Most-Active" morning scan → auto Top-N for the Bounce tab.

   Once each morning (fired ~9:45 ET by quickswing-daily-cron.mjs, or on demand
   from the "Scan now" button), this:
     1. Resolves the universe (getBounceUniverse → one company-screener call:
        price≥$10, cap≥$2B, beta≥1.0, ranked by dollar-volume, top ~250) with
        today's quality biggest-LOSERS tilted to the front (oversold → BUY-bounce
        candidates get a guaranteed slot even if they're not top-by-volume).
     2. Fetches the market regime once (SPY/VIX, cached 6h) and scores every name
        through the SAME Bounce pipeline the manual watchlist uses, under a bounded
        concurrency pool. FMP pacing is enforced globally by the token bucket in
        fmp-client.mjs (~270/min), so ~1,000 calls land in ~4 min, inside the
        15-min background-fn ceiling.
     3. Ranks by buy score, EXCLUDES names already on the manual watchlist (pure
        discovery), caps picks per sector for diversity, keeps the top N, and
        REPLACES the qs-daily list wholesale (yesterday's picks are dropped).
     4. Sends ONE separate Telegram message (its own header/time — never touches
        the hourly watchlist summary or the 5-min alerts).

   The kept top-N then ride the existing 5-min alert loop (see
   quickswing-alert-background.mjs) for live rescoring + verdict alerts until the
   next morning's scan replaces them.

   DELIBERATELY NOT recorded into the paper-trade BACKTEST LOG (qs-trades): the
   backtest is scoped to the hand-curated watchlist only (written solely by
   quickswing-rescan-background.mjs + quickswing-backtest-seed.mjs, both iterating
   listQuickswingRows). This worker must NEVER call recordQuickswingTransition /
   putQuickswingTrades — folding 500 names in would swamp the Backtest Log. If you
   ever add backtest recording to a Bounce scan, gate it to the manual list.
   Removable with the QUICK SWING FEATURE block. */
import { scoreTickerQuickSwing, getMarketRegime } from "../lib/quickswing-pipeline.mjs";
import { getBounceUniverse } from "../lib/qs-universe.mjs";
import { replaceQsDaily, acquireLock, releaseLock, listQuickswingRows, putQsLastScan, listQsStopMarks } from "../lib/store.mjs";
import { previousTradingDay } from "../lib/market-calendar.mjs";
import { fmpCallCount } from "../lib/fmp-client.mjs";
import { sendTelegram } from "../lib/telegram.mjs";
import { formatDailyTop } from "../lib/quickswing-summary.mjs";
import { etDateStr, etClockLabel } from "../lib/quickswing-alert.mjs";

const TOP_N = Number(process.env.QS_DAILY_TOP_N || 15);   // picks kept + alerted
const UNIVERSE_N = Number(process.env.QS_DAILY_UNIVERSE_N || 250); // names scanned (quality-filtered most-active)
const SECTOR_CAP = Number(process.env.QS_DAILY_SECTOR_CAP || 4);   // max kept picks per sector (0 = no cap)
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
  // Universe size — defaults to UNIVERSE_N (250). A small value (e.g. {universe:8})
  // lets a manual/test run exercise the whole path without the full fan-out; such
  // a test must NOT persist its truncated list as the day's real universe cache.
  const universeN = Number(body.universe) > 0 ? Number(body.universe) : UNIVERSE_N;
  const isSmallTest = Number(body.universe) > 0 && Number(body.universe) < UNIVERSE_N;

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
    const [uni, regime, manualRows, stopMarks] = await Promise.all([
      getBounceUniverse({ n: universeN, day, forceRefresh: force, persist: !isSmallTest }).catch(() => ({ symbols: [], sectors: {} })),
      getMarketRegime().catch(() => null),
      listQuickswingRows().catch(() => []),
      listQsStopMarks().catch(() => ({})),
    ]);
    const universe = uni.symbols || [];
    const sectorBySym = uni.sectors || {};
    // Names already on the manual watchlist — excluded from the kept list so the
    // daily section surfaces NEW ideas, not echoes of what you already track.
    const manualSet = new Set(manualRows.map(r => String(r?.sym || "").toUpperCase()).filter(Boolean));
    // A6 — withhold names the live loop stopped out of within the last ~3 sessions
    // so the list doesn't keep re-buying a falling knife.
    let cutoff = day; for (let i = 0; i < 3; i++) cutoff = previousTradingDay(cutoff);
    const recentlyStopped = new Set(
      Object.entries(stopMarks).filter(([, d]) => d && d > cutoff).map(([s]) => s.toUpperCase())
    );

    if (!universe.length) {
      console.error("[qs-daily] empty universe — aborting (screener returned nothing)");
      return new Response("", { status: 202 });
    }

    const rows = await pooled(
      universe,
      async (sym) => {
        const r = await scoreTickerQuickSwing(sym, { skipCache: true, marketRegime: regime }).catch(() => null);
        if (r) r.sector = sectorBySym[sym] || null; // for the per-sector cap below
        return r;
      },
      POOL,
    );

    const scored = rows.filter(Boolean);
    // Rank by buy score (desc); tie-break by lower sell score so a cleaner
    // one-sided bullish read wins the tie. Exclude watchlist names (pure
    // discovery), then greedily keep the top N under a per-sector cap so the
    // list isn't all one hot sector.
    const ranked = scored
      .filter(r => !manualSet.has(String(r.sym).toUpperCase()) && !recentlyStopped.has(String(r.sym).toUpperCase()))
      .sort((a, b) => numBuy(b) - numBuy(a) || numSell(a) - numSell(b));

    const perSector = {};
    const top = [];
    for (const r of ranked) {
      if (top.length >= topN) break;
      const sec = r.sector || "Unknown";
      if (SECTOR_CAP > 0 && (perSector[sec] || 0) >= SECTOR_CAP) continue;
      perSector[sec] = (perSector[sec] || 0) + 1;
      top.push(r);
    }
    // Backfill if the sector cap left us short of N (few sectors represented).
    if (top.length < topN) {
      const have = new Set(top.map(r => r.sym));
      for (const r of ranked) {
        if (top.length >= topN) break;
        if (!have.has(r.sym)) top.push(r);
      }
    }

    await replaceQsDaily(top).catch((e) => console.error("[qs-daily] replaceQsDaily failed:", e?.message || e));

    // Health snapshot for the close-of-day summary footer: how many of the
    // UNIVERSE came back with no usable data. Count vs. the universe (not vs.
    // `scored`) so names whose scoring THREW — dropped to null and excluded from
    // `scored` — are counted as na; otherwise a mass FMP outage would look "OK".
    const usable = scored.filter(r => r.price != null && r.verdict).length;
    const na = Math.max(0, universe.length - usable);
    const degraded = uni.stale || (universe.length > 0 && na / universe.length > 0.5);
    await putQsLastScan({ day, scanned: scored.length, universe: universe.length, na, degraded }).catch(() => {});

    try {
      await sendTelegram(formatDailyTop({
        rows: top, regime, label: etClockLabel(new Date()), scanned: scored.length,
        stale: !!uni.stale, asOfDay: uni.day,
      }));
    } catch (e) { console.error("[qs-daily] telegram failed:", e?.message || e); }

    const elapsedS = (Date.now() - started) / 1000;
    const calls = fmpCallCount() - callsBefore;
    const rate = elapsedS > 0 ? (calls / (elapsedS / 60)) : 0;
    const sectorsKept = new Set(top.map(r => r.sector || "Unknown")).size;
    console.log(`[qs-daily] day=${day} universe=${universe.length} scored=${scored.length} `
      + `excludedManual=${manualSet.size} kept=${top.length} sectors=${sectorsKept} `
      + `calls=${calls} elapsed=${elapsedS.toFixed(0)}s rate=${rate.toFixed(0)}/min`);
  } catch (e) {
    console.error("[qs-daily] scan failed:", e?.message || e);
  } finally {
    await releaseLock("qs-daily-scan", jobId);
  }

  return new Response("", { status: 202 });
};
