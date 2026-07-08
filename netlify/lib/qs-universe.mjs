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

// US common stocks, actively trading, on the two major exchanges, above $1 and
// with real volume. limit=3000 comfortably covers the top-500-by-dollar-volume
// cut (only ~2,600 names clear the volume floor, and we only need the top 500).
const SCREENER_QUERY =
  "isEtf=false&isFund=false&isActivelyTrading=true" +
  "&exchange=NASDAQ,NYSE&priceMoreThan=1&volumeMoreThan=500000&limit=3000";

// Permissive ticker shape — allow dotted/hyphenated classes (BRK.B, RDS-A) but
// drop anything with whitespace or odd characters the FMP symbol= param chokes on.
const TICKER_RE = /^[A-Z][A-Z.\-]*$/;

/* Return up to `n` most-active symbols (by dollar-volume), newest cache first.
   `day` = ET trading day (YYYY-MM-DD); a cached list from a different day is a
   miss so the universe rolls forward each morning. On a screener failure we fall
   back to the last cached list (even if stale) rather than run an empty scan. */
export async function getTop500MostActive({ n = 500, forceRefresh = false, day = null } = {}) {
  if (!forceRefresh) {
    const cached = await getQsUniverse(day).catch(() => null);
    if (cached && cached.length) return cached.slice(0, n);
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
    const stale = await getQsUniverse().catch(() => null);
    return (stale || []).slice(0, n);
  }

  const ranked = rows
    .filter(x => x && x.symbol && typeof x.price === "number" && typeof x.volume === "number"
                 && x.price > 0 && x.volume > 0)
    .map(x => ({ sym: String(x.symbol).toUpperCase(), dv: x.price * x.volume }))
    .filter(x => TICKER_RE.test(x.sym))
    .sort((a, b) => b.dv - a.dv);

  const seen = new Set();
  const symbols = [];
  for (const x of ranked) {
    if (seen.has(x.sym)) continue;
    seen.add(x.sym);
    symbols.push(x.sym);
    if (symbols.length >= n) break;
  }

  // Only persist a FULL-size resolution (n >= 500). A small test/manual run
  // (e.g. n=8) must never overwrite the day's real universe cache — otherwise a
  // later full run would read back the truncated list and scan only 8 names.
  if (symbols.length && n >= 500) await putQsUniverse(symbols, day).catch(() => {});
  return symbols;
}
