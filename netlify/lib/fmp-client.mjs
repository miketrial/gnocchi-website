/* ---------- Shared FMP fetch plumbing ----------
   Used by both short-pipeline.mjs and quickswing-pipeline.mjs so retry/
   backoff behavior can't drift between the two scoring engines. */

export const FMP = "https://financialmodelingprep.com/stable";

export const delay = ms => new Promise(r => setTimeout(r, ms));

/* ---------- Global rate limiter (token bucket) ----------
   FMP's plan allows 300 calls/min. The daily Most-Active 500 scan fires ~2,000
   calls through a concurrency pool; without pacing those would burst far past
   300/min and get 429-throttled (or silently return empty data). This shared
   bucket caps EVERY fmp() call — across all tabs and the daily scan — at
   ~4.5/sec = 270/min, leaving headroom under the 300 ceiling. It's a near no-op
   for the small manual rescans (already paced by 200ms delays); only the
   500-scan actually saturates it. Override the rate via FMP_RATE_PER_SEC.
   Token accounting is serialized through a promise chain so concurrent callers
   can't double-spend the same token. */
const RATE_PER_SEC = Number(process.env.FMP_RATE_PER_SEC || 4.5);
let _tokens = RATE_PER_SEC;
let _lastRefill = Date.now();
let _gate = Promise.resolve();
let _callCount = 0;
function _refill() {
  const now = Date.now();
  _tokens = Math.min(RATE_PER_SEC, _tokens + ((now - _lastRefill) / 1000) * RATE_PER_SEC);
  _lastRefill = now;
}
export function rateLimit() {
  _callCount++;
  _gate = _gate.then(async () => {
    _refill();
    if (_tokens < 1) {
      const waitMs = ((1 - _tokens) / RATE_PER_SEC) * 1000;
      await delay(waitMs);
      _refill();
    }
    _tokens -= 1;
  });
  return _gate;
}
// Cumulative count of rate-limited FMP requests since process start (every
// fmp() call + the screener fetch). Lets the daily scan log its real call total.
export function fmpCallCount() { return _callCount; }

export async function fmp(endpoint, ticker, extra = "") {
  await rateLimit();
  const key = process.env.FMP_API_KEY;
  const url = `${FMP}/${endpoint}?symbol=${ticker}&apikey=${key}${extra}`;
  const r = await fetch(url);
  if (!r.ok) {
    const err = new Error(`FMP ${endpoint} ${ticker} → ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

// Retry on 429 rate-limit (up to 2 retries, 3s/6s backoff).
// With dozens of tickers × several FMP calls each, late tickers in a full
// rescan can hit FMP's per-minute limit — without retry they silently get
// empty data and score all-purple/na.
export async function safe(endpoint, ticker, extra = "") {
  for (let attempt = 0; attempt <= 2; attempt++) {
    try {
      const d = await fmp(endpoint, ticker, extra);
      return Array.isArray(d) ? d : (d && !d["Error Message"] ? [d] : []);
    } catch (e) {
      if (e.status === 429 && attempt < 2) {
        await delay(3000 * (attempt + 1)); // 3s then 6s
        continue;
      }
      return [];
    }
  }
  return [];
}
