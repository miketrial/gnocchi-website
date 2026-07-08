/* ===== QUICK SWING FEATURE =====
   Resolve the "Top 500 Most-Active" universe for the daily Bounce discovery scan.

   Phase-0 verification (curl-tested against the live FMP stable API):
     - `most-actives` returns only 50 rows AND includes leveraged ETFs (SOXS …),
       so it can't be the source of a 500-COMPANY universe.
     - `batch-quote` / comma-separated `quote` are 402/empty on this plan, so
       there is no bulk shortcut — the scan pays 4 calls/symbol, paced by the
       global rate limiter in fmp-client.mjs.
     - `company-screener` returns ~2,600 US common stocks (ETFs/funds excluded)
       with a `volume` field. Ranking those by dollar-volume (price × volume) and
       taking the top N gives a real, tradeable "most active" list — #1 MU, the
       500th name still trades ~$235M/day.

   So: ONE screener call → rank by dollar-volume → top N symbols, cached for the
   day in the `qs-universe` blob so a same-day manual re-run reuses it.
   Removable with the rest of the QUICK SWING FEATURE block. */
import { FMP, rateLimit } from "./fmp-client.mjs";
import { getQsUniverse, putQsUniverse } from "./store.mjs";

// Default size of the daily Bounce universe (names actually scanned). 250 liquid
// mid-cap+ movers ≈ 1,000 FMP calls (~4 min) — about half the old top-500 cost,
// and a cleaner group. Override via QS_DAILY_UNIVERSE_N in the worker.
export const DEFAULT_UNIVERSE_N = 250;

// Quality pre-filters, ALL satisfied by the single screener call (free), chosen
// to mirror the Bounce pipeline's own Liquidity + ADR gates so we don't spend 4
// calls each on names that would fail those gates anyway:
//   priceMoreThan=10        — drop penny / low-price noise
//   marketCapMoreThan=2e9   — liquid, clean-technical mid-caps and up
//   betaMoreThan=1.0        — actually moves enough for a 1-2 day snap-back
//                             (beta is the cheap proxy; the pipeline still
//                             computes real ADR% per name as the accurate gate)
//   volumeMoreThan=1e6      — real turnover
// ~540 US common stocks clear this; we keep the top N by dollar-volume.
const SCREENER_QUERY =
  "isEtf=false&isFund=false&isActivelyTrading=true&exchange=NASDAQ,NYSE" +
  "&priceMoreThan=10&marketCapMoreThan=2000000000&betaMoreThan=1.0" +
  "&volumeMoreThan=1000000&limit=3000";

// Permissive ticker shape — allow dotted/hyphenated classes (BRK.B, RDS-A) but
// drop anything with whitespace or odd characters the FMP symbol= param chokes on.
const TICKER_RE = /^[A-Z][A-Z.\-]*$/;

// Today's biggest LOSERS, quality-filtered — the oversold-down names that are
// prime 1-2 day BUY-bounce candidates. FMP's biggest-losers list is 50 raw rows
// dominated by leveraged ETFs / penny SPACs, so we keep only symbols that also
// clear the quality screen (intersection). Gainers are deliberately NOT pulled:
// they're overbought SELL setups that wouldn't surface in a buy-ranked list.
async function fetchQualityLosers(key, qualitySet) {
  try {
    await rateLimit();
    const r = await fetch(`${FMP}/biggest-losers?apikey=${key}`);
    if (!r.ok) { console.error(`[qs-universe] biggest-losers → ${r.status}`); return []; }
    const losers = await r.json();
    if (!Array.isArray(losers)) return [];
    return losers
      .map(l => String(l?.symbol || "").toUpperCase())
      .filter(s => qualitySet.has(s));
  } catch (e) {
    console.error("[qs-universe] biggest-losers fetch failed:", e?.message || e);
    return [];
  }
}

/* Resolve the daily universe → { symbols:[...up to n], sectors:{SYM:sector} }.
   Names are the quality-filtered pool ranked by dollar-volume, but today's
   quality-filtered biggest LOSERS are prioritized into the front so stretched-
   down names get a slot even if they're not top-by-volume. `day` = ET trading
   day; a cached list from another day is a miss so the universe rolls forward.
   On a screener failure we fall back to the last cached list over an empty scan. */
export async function getBounceUniverse({ n = DEFAULT_UNIVERSE_N, forceRefresh = false, day = null, persist = true } = {}) {
  if (!forceRefresh) {
    const cached = await getQsUniverse(day).catch(() => null);
    if (cached && cached.symbols?.length) return { symbols: cached.symbols.slice(0, n), sectors: cached.sectors || {}, day: cached.day || day, stale: false };
  }

  const key = process.env.FMP_API_KEY;
  let rows = [];
  try {
    await rateLimit();
    const r = await fetch(`${FMP}/company-screener?apikey=${key}&${SCREENER_QUERY}`);
    if (r.ok) rows = await r.json();
    else console.error(`[qs-universe] screener → ${r.status}`);
  } catch (e) {
    console.error("[qs-universe] screener fetch failed:", e?.message || e);
  }

  if (!Array.isArray(rows) || !rows.length) {
    // Screener down — reuse whatever we last resolved (any day) over an empty scan.
    // Flag it stale (unless the fallback happens to be today's) so the daily
    // message can warn the list may be missing today's movers.
    const fallback = await getQsUniverse().catch(() => null);
    return {
      symbols: (fallback?.symbols || []).slice(0, n),
      sectors: fallback?.sectors || {},
      day: fallback?.day || null,
      stale: !!(fallback?.symbols?.length) && fallback?.day !== day,
    };
  }

  const quality = rows
    .filter(x => x && x.symbol && typeof x.price === "number" && typeof x.volume === "number"
                 && x.price > 0 && x.volume > 0)
    .map(x => ({ sym: String(x.symbol).toUpperCase(), dv: x.price * x.volume, sector: x.sector || null }))
    .filter(x => TICKER_RE.test(x.sym));

  const qualitySet = new Map(quality.map(q => [q.sym, q]));
  const sectors = {};
  for (const q of quality) sectors[q.sym] = q.sector;

  // Movers tilt: quality biggest-losers FIRST (guaranteed a slot), then fill the
  // remaining slots by dollar-volume, deduped, capped at n.
  const loserSyms = await fetchQualityLosers(key, qualitySet);
  const byDollarVol = quality.slice().sort((a, b) => b.dv - a.dv).map(q => q.sym);

  const seen = new Set();
  const symbols = [];
  for (const s of [...loserSyms, ...byDollarVol]) {
    if (seen.has(s)) continue;
    seen.add(s);
    symbols.push(s);
    if (symbols.length >= n) break;
  }

  // Persist for real runs so a same-day "Scan now" reuses one screener call and
  // the screener-down fallback has yesterday's list to serve. Caller passes
  // persist=false for a small explicit test; the n>=50 floor is a belt-and-braces
  // guard so a tiny test (e.g. n=8) can never poison the day's real cache even if
  // persist is mis-passed. (Previously gated on n>=250, which silently disabled
  // the cache whenever QS_DAILY_UNIVERSE_N was lowered below 250.)
  if (symbols.length && persist && n >= 50) await putQsUniverse({ symbols, sectors }, day).catch(() => {});
  return { symbols, sectors, day, stale: false };
}
