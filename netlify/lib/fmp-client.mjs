/* ---------- Shared FMP fetch plumbing ----------
   Used by both short-pipeline.mjs and quickswing-pipeline.mjs so retry/
   backoff behavior can't drift between the two scoring engines. */

export const FMP = "https://financialmodelingprep.com/stable";

export async function fmp(endpoint, ticker, extra = "") {
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

export const delay = ms => new Promise(r => setTimeout(r, ms));

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
