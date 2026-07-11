/* ---------- Short Term (1wk-3mo swing trading) pipeline ----------
   Pure FMP — zero Anthropic calls. Scores each ticker on an 11-factor
   momentum/quality/catalyst stack tuned for 2-12 week holds.

   Each check returns { points: 0-3 | null, verdict, summary, value }.
   - points 3 → "good"  (green chip)
   - points 2 → "ok"    (muted green chip)
   - points 1 → "weak"  (amber chip)
   - points 0 → "bad"   (red chip)
   - points null → "na" (purple chip — data unavailable)

   Score = sum of points across all 11 checks, out of 33.
   Thresholds: 22+ strong, 13-21 mixed, <13 weak (same 67%/40% split as the
   prior 10-factor/30-point scale, rescaled).
*/
import { getShortFmpCache, putShortFmpCache, deleteShortFmpCache, getSpyHistCache, putSpyHistCache, getSectorHistCache, putSectorHistCache } from "./store.mjs";
import { round2, na, scored, trueRange, atrFrom } from "./ta-helpers.mjs";
import { fmp, safe, delay } from "./fmp-client.mjs";
import { cleanHist, strengthFactor, adjustSplits } from "./quickswing-pipeline.mjs";
import { computeShortSignal, sessionComplete } from "./short-backtest.mjs"; // SWING BACKTEST FEATURE
import { etDateStr, etParts } from "./quickswing-alert.mjs"; // ET wall clock for the partial-bar guard

/* ---------- Sanity range gates — reject implausible FMP values before they
   reach a chip. A swing trader acts on these numbers fast, so a garbage
   value must show as "data unavailable" (purple), never a confident red/green. */
const SHORT_SANITY = {
  ret3m:     { min: -0.95, max: 10.0 },   // -95% to +1000% over 3 months
  fwdPe:     { min: 0.2,   max: 1000 },   // sub-0.2x or 1000x+ fwd P/E = bad data
  roe:       { min: -3.0,  max: 5.0  },   // -300% to +500% ROE
  levRatio:  { min: -50,   max: 50   },   // net debt / EBITDA
  volRv:     { min: 0,     max: 50   },   // today vs 20-day avg volume
};
function shortSane(value, field) {
  if (value == null || !isFinite(value)) return null;
  const r = SHORT_SANITY[field];
  if (!r) return value;
  return (value >= r.min && value <= r.max) ? value : null;
}

/* ---------- 3-step data-integrity check ----------
   Run BEFORE scoring. Catches the failure modes that would feed a swing
   trader wrong numbers:
     1. Symbol integrity — every endpoint must report the ticker we asked for
        (FMP/CDN occasionally serves another company's data under a sym-flip).
     2. Price cross-check — quote, profile, and latest EOD close must agree
        within 6% (they're all "today's price" via different CDN paths; a wide
        gap means one feed is stale or wrong).
     3. Freshness — the newest historical bar must be recent (≤ 6 calendar
        days old) so momentum/trend aren't computed on a frozen series.
   Returns { ok, warnings[] }. */
export function validateShortData(sym, { quote, profile, hist, inc }) {
  const warnings = [];
  const want = sym.toUpperCase();

  // Step 1 — symbol integrity across every endpoint that carries a symbol
  const symOf = (arr) => arr?.[0]?.symbol?.toUpperCase();
  const checks = { quote: symOf(quote), profile: symOf(profile), hist: symOf(hist), income: symOf(inc) };
  for (const [ep, s] of Object.entries(checks)) {
    if (s && s !== want) warnings.push(`sym-flip: ${ep} returned ${s}, expected ${want}`);
  }

  // Step 2 — price cross-check between feeds representing the SAME point in time.
  // quote.price and profile.price are both current/intraday → comparable.
  // NOTE: during market hours hist[0] is TODAY'S IN-PROGRESS PARTIAL bar (FMP's
  // historical-price-eod/full carries the live session — see cleanHist docs and
  // the swing-validation report). It is NOT a completed session, so it must never
  // be treated as final for the backtest fold (see the partial-bar guard TODO in
  // the SWING BACKTEST FEATURE block). Here it's only a soft sanity floor (>0).
  const livePrices = [quote?.[0]?.price, profile?.[0]?.price]
    .filter(p => typeof p === "number" && p > 0);
  if (livePrices.length >= 2) {
    const lo = Math.min(...livePrices), hi = Math.max(...livePrices);
    if (hi / lo > 1.06) warnings.push(`price divergence: live feeds disagree ${lo} vs ${hi} (>6%)`);
  }

  // Step 3 — freshness of the price series
  const lastBar = hist?.[0]?.date;
  if (lastBar) {
    const ageDays = (Date.now() - new Date(lastBar).getTime()) / 86400000;
    if (ageDays > 6) warnings.push(`stale price series: newest bar ${lastBar} is ${Math.round(ageDays)}d old`);
  }

  return { ok: warnings.length === 0, warnings };
}

/* ---------- Sector ROE/ROIC medians (rough, FMP-derived) ----------
   Static lookup avoids per-rescan fan-out. Numbers are approximate sector
   medians; treat as veto thresholds, not precise benchmarks. */
const SECTOR_ROE_MEDIAN = {
  "Semiconductors":              0.18,
  "Software-Application":        0.15,
  "Software-Infrastructure":     0.16,
  "Internet Content & Information": 0.22,
  "Consumer Electronics":        0.20,
  "Computer Hardware":           0.18,
  "Information Technology Services": 0.16,
  "Electrical Equipment & Parts": 0.14,
  "Aerospace & Defense":         0.16,
  "Specialty Industrial Machinery": 0.15,
  "Conglomerates":               0.12,
  "Utilities-Regulated Electric": 0.09,
  "Utilities-Renewable":         0.08,
  "Renewable Utilities":         0.08,
  "Oil & Gas E&P":               0.18,
  "Oil & Gas Integrated":        0.15,
  "Oil & Gas Midstream":         0.12,
  "Banks-Diversified":           0.11,
  "Banks-Regional":              0.10,
  "Insurance-Diversified":       0.12,
  "Asset Management":            0.14,
  "Credit Services":             0.18,
  "Financial Services":          0.13,
  "Drug Manufacturers-General":  0.18,
  "Drug Manufacturers-Specialty & Generic": 0.10,
  "Biotechnology":               0.08,
  "Medical Devices":             0.14,
  "Healthcare Plans":            0.16,
  "Specialty Retail":            0.20,
  "Internet Retail":             0.18,
  "Restaurants":                 0.22,
  "Apparel Retail":              0.20,
  "Auto Manufacturers":          0.14,
  "Real Estate Services":        0.10,
  "REIT-Industrial":             0.07,
  "Basic Materials":             0.12,
  "Steel":                       0.10,
};
function sectorRoeMedian(industry) {
  return SECTOR_ROE_MEDIAN[industry] ?? 0.12;
}

/* Sector P/E top decile threshold — reuse the SECTOR_PE_MAP from pipeline.mjs
   conceptually; we duplicate a small subset here to keep this file standalone. */
const SECTOR_PE_75TH = {
  "Semiconductors":              45,
  "Software-Application":        45,
  "Software-Infrastructure":     45,
  "Internet Content & Information": 30,
  "Consumer Electronics":        28,
  "Computer Hardware":           28,
  "Information Technology Services": 35,
  "Electrical Equipment & Parts": 38,
  "Aerospace & Defense":         28,
  "Specialty Industrial Machinery": 26,
  "Conglomerates":               26,
  "Utilities-Regulated Electric": 22,
  "Utilities-Renewable":         28,
  "Renewable Utilities":         28,
  "Oil & Gas E&P":               18,
  "Oil & Gas Integrated":        16,
  "Banks-Diversified":           14,
  "Banks-Regional":              14,
  "Drug Manufacturers-General":  22,
  "Biotechnology":               40,
  "Medical Devices":             32,
  "Healthcare Plans":            20,
  "Specialty Retail":            26,
  "Internet Retail":             40,
  "Restaurants":                 32,
  "Auto Manufacturers":          18,
  "REIT-Industrial":             40,
  "Steel":                       18,
};
function sectorPe75th(industry) {
  return SECTOR_PE_75TH[industry] ?? 30;
}

/* ---------- Sector -> ETF map (Sector Relative Strength factor) ----------
   Industry-level override for Semiconductors, checked first — SMH is a
   tighter proxy than the broad Technology sector ETF, and this factor exists
   specifically because of the June-July 2026 semiconductor rotation (see
   scripts/study-short-factors.mjs). Everything else falls back to its GICS
   SPDR sector ETF, keyed off FMP's `sector` field (confirmed strings, same
   as SECTOR_PE_MAP's broad-sector fallback keys in pipeline.mjs). */
const INDUSTRY_ETF = { "Semiconductors": "SMH" };
const SECTOR_ETF = {
  "Technology": "XLK", "Healthcare": "XLV", "Utilities": "XLU", "Industrials": "XLI",
  "Consumer Cyclical": "XLY", "Consumer Defensive": "XLP", "Financial Services": "XLF",
  "Communication Services": "XLC", "Basic Materials": "XLB", "Energy": "XLE", "Real Estate": "XLRE",
};
export function sectorEtfFor(sector, industry) {
  return INDUSTRY_ETF[industry] || SECTOR_ETF[sector] || null;
}

/* ---------- Shared index/ETF history fetch ----------
   SPY and sector ETF history are cached ONCE per symbol via store.mjs
   (getSpyHistCache/getSectorHistCache), not refetched per ticker — a Swing
   rescan of many tickers touches only a handful of distinct sector ETFs, so
   after the first ticker in a batch populates the cache the rest reuse it.
   Mirrors getMarketRegime()'s SPY-fetch pattern in quickswing-pipeline.mjs. */
async function getCachedIndexHist(symbol, getCache, putCache) {
  let hist = await getCache().catch(() => null);
  if (!hist) {
    const raw = await safe("historical-price-eod/full", symbol, "&limit=320");
    hist = cleanHist(raw);
    if (hist.length >= 200) await putCache(hist).catch(() => {});
  }
  return hist;
}
function getSpyHist() {
  return getCachedIndexHist("SPY", getSpyHistCache, putSpyHistCache);
}
function getSectorHist(etfSymbol) {
  return getCachedIndexHist(etfSymbol, () => getSectorHistCache(etfSymbol), h => putSectorHistCache(etfSymbol, h));
}

/* ---------- Per-check scoring functions ----------
   Each returns { points: 0-3 | null, verdict, summary, value }.
   points null = "na" (data unavailable); 0 = bad, 1 = weak, 2 = ok, 3 = good.
   Score = sum of points across all 11 checks, out of 33. */

// na/scored/round2/trueRange/atrFrom live in ta-helpers.mjs — shared with
// quickswing-pipeline.mjs so the ATR math can't drift between the two.

// One price-history point is valid only if it has a well-formed ISO date
// (YYYY-MM-DD, real calendar date) and a finite, strictly-positive close.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validPricePoint(date, close) {
  if (typeof date !== "string" || !ISO_DATE_RE.test(date)) return false;
  const t = new Date(date + "T00:00:00Z").getTime();
  if (Number.isNaN(t)) return false;
  return Number.isFinite(close) && close > 0;
}

// How many trailing trading days the chart plots. 50 gives ~2.5 months of
// context. The hist fetch (limit=320) carries enough history that even the
// oldest of these 50 points has a full 252-session window behind it for an
// accurate rolling 52-week high.
const PRICE_HIST_DAYS = 50;

// Build the rolling, validated N-day series (oldest→newest) from FMP's hist
// feed. Every point is checked; dupes are collapsed; the newest N valid
// sessions win. Each point also carries the trailing 50DMA, 200DMA, and 52w
// high computed AS OF THAT DAY — so the chart can draw them as moving curves
// (they change daily), not flat lines. See the call site for why this makes
// the window self-rolling.
export function buildPriceHist(hist) {
  const seen = new Set();
  const desc = [];                        // newest-first, validated, deduped
  for (const d of hist || []) {
    const date = d?.date;
    const close = d?.price ?? d?.close;
    if (!validPricePoint(date, close)) continue;
    if (seen.has(date)) continue;         // FMP occasionally double-lists a session
    seen.add(date);
    // high/low fall back to close for older cached blobs or feeds without
    // OHLC — degrades ATR to a same-day-only range rather than breaking.
    desc.push({ date, close, high: d?.high ?? close, low: d?.low ?? close });
  }
  desc.sort((a, b) => b.date.localeCompare(a.date)); // newest first
  const closes = desc.map(d => d.close);
  // Trailing average / max of `n` closes starting at index `from` (inclusive),
  // most-recent-first — so `from=i` looks back from day i. Returns null if no
  // data (never happens once we're inside the array), partial near the tail.
  const avgFrom = (from, n) => {
    let s = 0, c = 0;
    for (let k = from; k < from + n && k < closes.length; k++) { s += closes[k]; c++; }
    return c ? s / c : null;
  };
  const maxFrom = (from, n) => {
    let m = -Infinity, c = 0;
    for (let k = from; k < from + n && k < closes.length; k++) { if (closes[k] > m) m = closes[k]; c++; }
    return c ? m : null;
  };
  const count = Math.min(PRICE_HIST_DAYS, desc.length);
  const out = [];
  for (let i = 0; i < count; i++) {
    out.push({
      date:   desc[i].date,
      close:  desc[i].close,
      sma50:  round2(avgFrom(i, 50)),
      sma200: round2(avgFrom(i, 200)),
      high52: round2(maxFrom(i, 252)),
      atr14:  round2(atrFrom(desc, i, 14)),
    });
  }
  return out.reverse();                   // newest 15, oldest→newest
}

// 1. Trend: how cleanly price is above its moving averages
export function checkTrend(hist) {
  if (!hist || hist.length < 200) return na("Need 200 days of price history");
  const closes = hist.slice(0, 220).map(d => d.price ?? d.close).filter(p => p != null);
  if (closes.length < 200) return na("Insufficient price history");
  const sma = (n) => closes.slice(0, n).reduce((s, x) => s + x, 0) / n;
  const price = closes[0];
  const sma50 = sma(50);
  const sma200 = sma(200);
  const pctAbove50 = (price - sma50) / sma50;
  // ATR14 for the trade-card stop distance — computed here (not just in
  // buildPriceHist) so it's available even if the caller never asks for the
  // rolling price-history curve.
  const atr14 = round2(atrFrom(hist, 0, 14));
  let points, label;
  if (price > sma50 && sma50 > sma200 && pctAbove50 >= 0.08) {
    points = 3; label = `strong uptrend — ${(pctAbove50*100).toFixed(1)}% above 50DMA`;
  } else if (price > sma50 && sma50 > sma200) {
    points = 2; label = "clean uptrend";
  } else if (price > sma50) {
    points = 1; label = "above 50DMA but 50DMA still below 200DMA";
  } else {
    points = 0; label = "below 50DMA — downtrend";
  }
  return scored(points, `$${price.toFixed(2)} vs 50DMA $${sma50.toFixed(2)} / 200DMA $${sma200.toFixed(2)} — ${label}`, { price, sma50, sma200, atr14 });
}

// 2. 3M Momentum: graduated by return magnitude
export function check3MMomentum(hist) {
  if (!hist || hist.length < 65) return na("Need 3 months of price history");
  const closes = hist.slice(0, 70).map(d => d.price ?? d.close).filter(p => p != null);
  if (closes.length < 63) return na("Insufficient price history");
  const now = closes[0];
  const then = closes[62];
  if (!then || then <= 0) return na("Bad reference price");
  const ret = shortSane((now / then) - 1, "ret3m");
  if (ret == null) return na("3-month return out of plausible range — data suspect");
  let points;
  if (ret >= 0.15)      points = 3;
  else if (ret >= 0.05) points = 2;
  else if (ret >= 0)    points = 1;
  else                  points = 0;
  const label = points === 3 ? "strong" : points === 2 ? "decent" : points === 1 ? "flat" : "negative";
  return scored(points, `3-month return ${ret >= 0 ? "+" : ""}${(ret * 100).toFixed(1)}% (${label})`, ret);
}

// 3. Near High: how close to the 52-week high
export function checkNearHigh(hist) {
  if (!hist || hist.length < 200) return na("Need 52 weeks of price history");
  const closes = hist.slice(0, 260).map(d => d.price ?? d.close).filter(p => p != null);
  if (closes.length < 200) return na("Insufficient price history");
  const high = Math.max(...closes);
  const now = closes[0];
  const pctOff = (high - now) / high;
  // Re-tuned (2026-07): a 2-year FMP study (scripts/run-short-study.mjs +
  // scratchpad/analyze-factors.mjs) found forward swing returns PEAK 5-18% off the
  // 52w high — the constructive "pullback to strength" — and are weaker for names
  // pinned right at the high, which are extended and mean-revert on a multi-week
  // horizon (8-12%-off names averaged +2.95% fwd-21d vs +1.99% at the high). This
  // reshaped the factor's information coefficient from -0.03 to +0.06. Right at the
  // high is still constructive (2 pts) but the top mark now goes to the pullback
  // zone rather than rewarding chasing an extended breakout.
  let points;
  if (pctOff > 0.05 && pctOff <= 0.18) points = 3;   // near the high with room to run — the sweet spot
  else if (pctOff <= 0.05)             points = 2;   // pinned at the 52w high — extended
  else if (pctOff <= 0.30)             points = 1;
  else                                 points = 0;
  const label = points === 3 ? "constructive pullback below the 52w high"
    : points === 2 ? "pinned at the 52w high (extended)"
    : points === 1 ? "well off the high" : "far from high";
  return scored(points, `${(pctOff * 100).toFixed(1)}% off 52w high ($${high.toFixed(2)}) — ${label}`, { high, pctOff });
}

// 4. Liquidity: 20-day avg $-volume — graduated by how tradeable.
// Window: hist[0..19] — the 20 most recent COMPLETE trading days. (Vol Surge
// uses hist[1..20] because it's comparing hist[0] to its prior 20-day avg.
// Different intents, both correct.)
export function checkLiquidity(hist, quote) {
  if (!hist || hist.length < 20) return na("Need 20 days of price history");
  const dollarVols = hist.slice(0, 20).map(d => (d.price ?? d.close ?? 0) * (d.volume ?? 0)).filter(v => v > 0);
  if (!dollarVols.length) return na("No volume data");
  const avgDollarVol = dollarVols.reduce((s, x) => s + x, 0) / dollarVols.length;
  const fmt = (n) => n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : `$${(n / 1e6).toFixed(1)}M`;
  let points;
  if (avgDollarVol >= 100_000_000)     points = 3;
  else if (avgDollarVol >= 20_000_000) points = 2;
  else if (avgDollarVol >= 10_000_000) points = 1;
  else                                 points = 0;
  const label = points === 3 ? "highly liquid" : points === 2 ? "liquid" : points === 1 ? "marginal" : "too thin";
  return scored(points, `20-day avg $-volume ${fmt(avgDollarVol)} (${label})`, avgDollarVol);
}

// 5. Analyst Revisions — PT drift + rating drift, graduated by composite magnitude
export function checkAnalystRevisions(ptSummary, grades) {
  const s = (ptSummary || [])[0] || null;
  const g = Array.isArray(grades) ? grades : [];
  const ptCount = s?.lastMonthCount ?? 0;
  const ptNow  = ptCount >= 1 ? s?.lastMonthAvgPriceTarget : null;
  const ptThen = s?.lastQuarterAvgPriceTarget;
  const havePT = ptNow != null && ptNow > 0 && ptThen != null && ptThen > 0;

  function buyRatio(row) {
    if (!row) return null;
    const sb = row.analystRatingsStrongBuy ?? 0;
    const b  = row.analystRatingsBuy ?? 0;
    const h  = row.analystRatingsHold ?? 0;
    const se = row.analystRatingsSell ?? 0;
    const ss = row.analystRatingsStrongSell ?? 0;
    const tot = sb + b + h + se + ss;
    return tot > 0 ? (sb + b) / tot : null;
  }
  // "Now" = most recent snapshot. "Then" = closest snapshot ≥ 60 calendar
  // days back. Date-based so we don't depend on the (unspecified) sample
  // cadence FMP uses. Falls back to the oldest record we have if 60d isn't
  // available, so the signal still works for newer coverage.
  const sortedG = g.slice().sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const brNow = buyRatio(sortedG[0]);
  const cutoff60 = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
  let thenRow = sortedG.find(row => row.date && row.date <= cutoff60);
  if (!thenRow && sortedG.length >= 2) thenRow = sortedG[sortedG.length - 1];
  const brThen = buyRatio(thenRow);
  const haveBR = brNow != null && brThen != null;

  if (!havePT && !haveBR) return na("No analyst coverage data (price targets or rating history)");

  const ptDelta = havePT ? (ptNow - ptThen) / ptThen : null;
  const brDelta = haveBR ? (brNow - brThen) : null;
  const signals = [...(ptDelta != null ? [ptDelta] : []), ...(brDelta != null ? [brDelta] : [])];
  const composite = signals.reduce((a, b) => a + b, 0) / signals.length;

  let points;
  if (composite >= 0.05)       points = 3;
  else if (composite >= 0)     points = 2;
  else if (composite >= -0.05) points = 1;
  else                         points = 0;

  const parts = [];
  if (havePT) parts.push(`PT $${ptThen.toFixed(0)}→$${ptNow.toFixed(0)} (${ptDelta >= 0 ? "+" : ""}${(ptDelta * 100).toFixed(1)}%)`);
  if (haveBR) parts.push(`Buy ratio ${(brThen * 100).toFixed(0)}%→${(brNow * 100).toFixed(0)}%`);
  const direction = points >= 2 ? "improving" : points === 1 ? "slightly cooling" : "cooling";
  return scored(points, `Analyst sentiment ${direction}: ${parts.join(" · ")}`, { ptNow, ptThen, brNow, brThen, composite });
}

// 6. Valuation: Fwd P/E vs sector 75th pct — graduated by how cheap/expensive
export function checkValuation(price, fwdEps, industry) {
  if (!price || !fwdEps || fwdEps <= 0) return na("No forward P/E (negative or missing fwd EPS)");
  const fwdPe = shortSane(price / fwdEps, "fwdPe");
  if (fwdPe == null) return na("Forward P/E out of plausible range — data suspect");
  const threshold = sectorPe75th(industry);
  let points;
  if (fwdPe <= threshold * 0.75)      points = 3;
  else if (fwdPe <= threshold)        points = 2;
  else if (fwdPe <= threshold * 1.5)  points = 1;
  else                                points = 0;
  const label = points === 3 ? "cheap vs sector" : points === 2 ? "within range" : points === 1 ? "a bit expensive" : "egregiously expensive";
  return scored(points, `Fwd P/E ${fwdPe.toFixed(1)}x — ${label} (${industry || "sector"} 75th pct ${threshold}x)`, { fwdPe, threshold, industry });
}

// 7. Quality: FCF + ROE vs sector median — graduated by how many pass and by how much
export function checkQuality(cf, keyMetrics, industry) {
  const cfTTM = (cf || []).slice(0, 4).reduce((s, q) => s + (q.freeCashFlow ?? 0), 0);
  const km0 = (keyMetrics || [])[0];
  const roe = shortSane(km0?.returnOnEquity, "roe");
  const median = sectorRoeMedian(industry);
  if (!cf || cf.length < 1 || roe == null) return na("Missing FCF or ROE data (or ROE out of plausible range)");
  const fcfOk = cfTTM > 0;
  const roeOk = roe > median;
  const roeStrong = roe > median * 1.5;
  let points;
  if (fcfOk && roeStrong)  points = 3;
  else if (fcfOk && roeOk) points = 2;
  else if (fcfOk || roeOk) points = 1;
  else                     points = 0;
  const label = points === 3 ? "excellent" : points === 2 ? "solid" : points === 1 ? "mixed" : "weak";
  return scored(points,
    `Quality ${label}: FCF ${fcfOk ? "+" : "−"}$${Math.abs(cfTTM / 1e6).toFixed(0)}M, ROE ${(roe * 100).toFixed(1)}% vs ${(median * 100).toFixed(0)}% sector median`,
    { fcfTTM: cfTTM, roe, sectorMedian: median });
}

// 8. Leverage: Net Debt / EBITDA — graduated by how clean the balance sheet is
export function checkLeverage(bs, inc) {
  const bs0 = (bs || [])[0];
  if (!bs0) return na("No balance sheet data");
  const totalDebt = bs0.totalDebt ?? 0;
  const cash = bs0.cashAndShortTermInvestments ?? 0;
  const netDebt = totalDebt - cash;
  const incLast4 = (inc || []).slice(0, 4);
  if (incLast4.length < 1) return na("No income statement data");
  const ebitda = incLast4.reduce((s, q) => s + (q.operatingIncome ?? 0) + (q.depreciationAndAmortization ?? 0), 0);
  if (ebitda <= 0) {
    if (netDebt > 0) return scored(0, `Net debt $${(netDebt / 1e9).toFixed(2)}B with negative EBITDA — high risk`, { netDebt, ebitda });
    return scored(3, `Net cash $${(-netDebt / 1e9).toFixed(2)}B — no debt burden despite negative EBITDA`, { netDebt, ebitda });
  }
  const ratio = shortSane(netDebt / ebitda, "levRatio");
  if (ratio == null) return na("Leverage ratio out of plausible range — data suspect");
  let points;
  if (ratio < 1)       points = 3;
  else if (ratio < 3)  points = 2;
  else if (ratio < 5)  points = 1;
  else                 points = 0;
  const label = points === 3 ? "very clean" : points === 2 ? "healthy" : points === 1 ? "elevated" : "over-levered";
  return scored(points, `Net Debt / EBITDA ${ratio.toFixed(2)}x — ${label}`, { netDebt, ebitda, ratio });
}

// 9. Catalyst: earnings in 1wk-3mo window, graduated by recent beat streak
export function checkCatalyst(earningsHist) {
  if (!earningsHist || !earningsHist.length) return na("No earnings calendar data");
  const today = new Date().toISOString().slice(0, 10);
  const future = earningsHist
    .filter(e => e.epsActual == null && e.date > today)
    .sort((a, b) => a.date.localeCompare(b.date));
  const next = future[0];
  // No upcoming earnings = data unknown, not a confident "fail". Some calendars
  // simply haven't published the next date yet — flag as na rather than red.
  if (!next) return na("No upcoming earnings date in FMP calendar");
  const daysUntil = Math.ceil((new Date(next.date) - Date.now()) / 86400000);
  if (daysUntil < 7)  return scored(0, `Earnings in ${daysUntil}d (${next.date}) — too soon to position`, { date: next.date, daysUntil });
  if (daysUntil > 90) return scored(0, `Earnings in ${daysUntil}d (${next.date}) — outside 3-month swing window`, { date: next.date, daysUntil });
  // In window — check recent beat streak
  const past = earningsHist.filter(e => e.epsActual != null && e.epsEstimated != null).slice(0, 4);
  const beats = past.filter(e => e.epsActual > e.epsEstimated).length;
  const total = past.length;
  let points, beatSummary;
  if (total === 0)    { points = 1; beatSummary = "no beat history available"; }
  else if (beats >= 3){ points = 3; beatSummary = `beat ${beats}/${total} recent quarters`; }
  else if (beats >= 1){ points = 2; beatSummary = `beat ${beats}/${total} recent quarters`; }
  else                { points = 1; beatSummary = `missed last ${total} quarter${total > 1 ? "s" : ""}`; }
  return scored(points, `Earnings in ${daysUntil}d (${next.date}) — ${beatSummary}`, { date: next.date, daysUntil, beats, total });
}

// 10. Volume Surge — most-recent-complete-day surge + 10-day money flow.
//
// Why not use today's live quote? `quote.volume` is a running intraday total —
// mid-session it's only a fraction of a normal day, so rv = todayVol/20dAvg
// swings wildly and lies. We anchor on the most recent COMPLETE bar
// (hist[0] from FMP's EOD light feed) so the score is stable regardless of
// when the user opens the page.
//
// Two signals combined:
//   • Recent-day surge (rv = hist[0].vol / avg of prior 20 days) + that day's
//     price direction → "is institutional activity firing right now?"
//   • 10-day money flow ((up$-vol − down$-vol) / total$-vol, range [-1,+1])
//     over the 10 most-recent complete days → "what's the multi-day trend?"
// Confluence = real signal. Disagreement = wait.
export function checkVolumeSurge(quote, hist) {
  // Anchor on most recent complete EOD bar. quote.volume is intraday-partial
  // during market hours; using hist[0] guarantees a full session.
  if (!hist || hist.length < 21) return na("Need 21 days of volume history");
  const h0 = hist[0], h1 = hist[1];
  const recentVol   = h0?.volume;
  const recentClose = h0?.price ?? h0?.close;
  const priorClose  = h1?.price ?? h1?.close;
  if (recentVol == null || recentClose == null || priorClose == null)
    return na("Missing recent close/volume bar");

  // 20-day avg volume from the 20 days BEFORE the most recent bar
  const vols = hist.slice(1, 21).map(d => d.volume).filter(v => v != null && v > 0);
  if (vols.length < 15) return na("Volume history too sparse");
  const avg20 = vols.reduce((s, x) => s + x, 0) / vols.length;
  const rv = shortSane(recentVol / avg20, "volRv");
  if (rv == null) return na("Volume ratio out of plausible range — data suspect");

  // Direction of the most recent complete bar
  const recentDir = Math.sign(recentClose - priorClose);
  const isUp   = recentDir > 0;
  const isDown = recentDir < 0;
  const dirLabel = isUp ? "↑" : isDown ? "↓" : "→";

  // 10-day money flow — sum up$/down$ over the 10 most recent complete days.
  // Loop starts at i=0 (yesterday) paired with i+1 (day before) — earlier
  // versions skipped index 0 and missed the most relevant day.
  let upDollar = 0, dnDollar = 0;
  let lookback = 0;
  if (hist.length >= 11) {
    for (let i = 0; i < 10; i++) {
      const today = hist[i], prior = hist[i + 1];
      if (!today || !prior) break;
      const close = today.price ?? today.close;
      const pclose = prior.price ?? prior.close;
      const vol = today.volume;
      if (close == null || pclose == null || vol == null || vol <= 0) continue;
      const dollar = close * vol;
      if (close > pclose)      upDollar += dollar;
      else if (close < pclose) dnDollar += dollar;
      lookback++;
    }
  }
  const haveFlow = lookback >= 6; // need a meaningful sample
  const totalFlow = upDollar + dnDollar;
  const flow = haveFlow && totalFlow > 0 ? (upDollar - dnDollar) / totalFlow : null;
  const flowLabel = flow == null ? "n/a"
    : flow >=  0.3 ? "strong buying"
    : flow >=  0.1 ? "buying"
    : flow >  -0.1 ? "neutral"
    : flow >= -0.3 ? "selling"
    : "strong selling";

  // Score = confluence of today + 10-day flow.
  // Distribution overrides everything else.
  let points, label;
  const sustainedSell = flow != null && flow <= -0.3;
  const sustainedBuy  = flow != null && flow >=  0.3;
  const mildBuy       = flow != null && flow >=  0.1;

  if (rv >= 1.5 && isDown) {
    points = 0; label = "distribution — heavy selling today";
  } else if (sustainedSell) {
    points = 0; label = "10-day flow is selling pressure";
  } else if (rv >= 2.5 && isUp && sustainedBuy) {
    points = 3; label = "strong confluence — today's surge + sustained buying";
  } else if (rv >= 1.5 && isUp && sustainedBuy) {
    points = 3; label = "above-avg surge confirmed by multi-day buying";
  } else if (rv >= 2.5 && isUp) {
    points = 3; label = "strong accumulation today";
  } else if (rv >= 1.5 && isUp && mildBuy) {
    points = 2; label = "above-avg buying today, mild multi-day support";
  } else if (rv >= 1.5 && isUp) {
    points = 2; label = "above-avg today but multi-day flow flat";
  } else if (sustainedBuy && rv >= 0.8) {
    points = 2; label = "sustained 10-day accumulation";
  } else if (rv >= 2.5) {
    points = 1; label = "high volume but direction unclear";
  } else if (mildBuy && rv >= 0.8) {
    points = 1; label = "mild 10-day buying";
  } else if (rv >= 0.8) {
    points = 1; label = "normal activity";
  } else {
    points = 0; label = "below-avg volume — stock being ignored";
  }

  const summary = `Last session ${rv.toFixed(2)}× avg, price ${dirLabel}`
    + (flow != null ? ` · 10d flow ${flow >= 0 ? "+" : ""}${(flow * 100).toFixed(0)}% (${flowLabel})` : "")
    + ` — ${label}`;
  return scored(points, summary, {
    rv, recentVol, avg20, dir: recentDir, isUp, isDown, dirLabel, flow, upDollar, dnDollar
  });
}

// 11. Sector Relative Strength — is the ticker's SECTOR beating the market?
//
// Calibrated in scripts/study-short-factors.mjs against real forward 10d/21d
// returns across ~90 tickers: sector-ETF-vs-SPY delta (same IBD-style
// weighted-ROC math as Bounce's RS-vs-SPY leader gate, strengthFactor() in
// quickswing-pipeline.mjs) has a modest POSITIVE correlation with forward
// return (IC +0.066 / +0.059) — strong sectors keep outperforming.
//
// This is a MOMENTUM-CONFIRMATION factor, not a rotation-early-warning one.
// Its 3-12mo weighted window barely moved during the actual June-July 2026
// semiconductor rotation (AVGO's delta sat at +50 to +86% through the entire
// drawdown) — a high score here means "this sector has been a market
// leader," not "this sector is safe from a rotation."
//
// Thresholds are the study's quintile breakpoints (Q5 starts ~0.15, Q4
// ~0.08, Q1 ends ~-0.03).
export function checkSectorStrength(sectorHist, spyHist) {
  const sectorStrength = sectorHist ? strengthFactor(sectorHist) : null;
  const spyStrength = spyHist ? strengthFactor(spyHist) : null;
  if (sectorStrength == null || spyStrength == null) return na("Need 3+ months of sector ETF and SPY price history");
  const delta = sectorStrength - spyStrength;
  let points;
  if (delta >= 0.15)       points = 3;
  else if (delta >= 0.08)  points = 2;
  else if (delta >= -0.03) points = 1;
  else                     points = 0;
  const label = points === 3 ? "sector strongly leading the market" : points === 2 ? "sector beating the market" : points === 1 ? "sector roughly in line with the market" : "sector lagging the market";
  return scored(points, `Sector ${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}pp vs SPY — ${label}`, { sectorStrength, spyStrength, delta });
}

/* ---------- Main scorer ---------- */
export async function scoreTickerShort(ticker, { skipCache = false } = {}) {
  const sym = ticker.toUpperCase();

  // Cache check
  if (!skipCache) {
    const cached = await getShortFmpCache(sym);
    if (cached && cached._v === 15) {
      return cached.row;
    }
  } else {
    await deleteShortFmpCache(sym).catch(() => {});
  }

  // Fetch FMP data (sequential with small delay to stay under rate limits).
  // Wrapped in a closure so the 3-step integrity check can retry it once.
  const runFmp = async () => {
    const d = {};
    // "full" (not "light") so each bar carries high/low — needed for a real
    // ATR-based stop distance. Same single call/cost as before; every
    // downstream reader already falls back `d.price ?? d.close`, so this
    // swap is a drop-in (light returns `price`, full returns `close`).
    d.hist          = await safe("historical-price-eod/full", sym, "&limit=320"); await delay(200);
    d.splits        = await safe("splits", sym, "&limit=20");                       await delay(200);
    d.quote         = await safe("quote", sym);                                     await delay(200);
    d.keyMetrics    = await safe("key-metrics", sym, "&period=annual&limit=2");     await delay(200);
    d.estimates     = await safe("analyst-estimates", sym, "&period=annual&limit=3"); await delay(200);
    d.cf            = await safe("cash-flow-statement", sym, "&period=quarter&limit=4"); await delay(200);
    d.bs            = await safe("balance-sheet-statement", sym, "&period=quarter&limit=1"); await delay(200);
    d.inc           = await safe("income-statement", sym, "&period=quarter&limit=4"); await delay(200);
    d.profile       = await safe("profile", sym);                                   await delay(200);
    d.earningsHist  = await safe("earnings", sym, "&limit=6");                     await delay(200);
    d.ptSummary     = await safe("price-target-summary", sym);                     await delay(200);
    // grades-historical: pull a wider window so we can pick a snapshot
    // ~60 calendar days back by date rather than guessing at the sample rate.
    d.grades        = await safe("grades-historical", sym, "&limit=180");
    return d;
  };

  let hist, quote, keyMetrics, estimates, cf, bs, inc, profile, earningsHist, ptSummary, grades;
  let warnings = [];
  try {
    let data = await runFmp();
    // 3-step integrity check — symbol / price / freshness
    let v = validateShortData(sym, data);
    if (!v.ok) {
      // One retry after a pause — transient CDN sym-flips usually heal quickly
      await delay(3000);
      const retry = await runFmp();
      const v2 = validateShortData(sym, retry);
      if (v2.ok) { data = retry; v = v2; }
      else {
        // Still bad — surface the warning and blank the company-identity feeds
        // so identity-dependent chips go purple (na) rather than show wrong data.
        warnings = v2.warnings;
        const symBad = v2.warnings.some(w => w.startsWith("sym-flip") || w.startsWith("price divergence"));
        if (symBad) {
          data = { ...retry, hist: [], quote: [], inc: [], bs: [], cf: [],
                   keyMetrics: [], estimates: [], profile: [], earningsHist: [],
                   ptSummary: [], grades: [] };
        } else {
          data = retry; // freshness-only warning: keep data, just flag it
        }
      }
    }
    ({ hist, quote, keyMetrics, estimates, cf, bs, inc, profile, earningsHist, ptSummary, grades } = data);
    // Split/corporate-action back-adjust the RAW EOD feed before ANY factor or the
    // backtest signal reads it — otherwise a stock split (e.g. HON 1:2 on 2026-06-29)
    // reads as a phantom ~50% overnight gap and books a spurious −47% swing "trade".
    if (Array.isArray(hist) && hist.length && Array.isArray(data.splits) && data.splits.length) {
      hist = adjustSplits(hist, data.splits);
    }
  } catch (e) {
    console.error(`[short] ${sym} fetch error:`, e?.message || e);
  }
  if (warnings.length) console.warn(`[short] ${sym} integrity warnings:`, warnings.join("; "));

  const p0 = profile?.[0] || {};
  const q0 = quote?.[0] || {};
  const name = p0.companyName || sym;
  const price = q0.price ?? p0.price ?? null;
  const industry = p0.industry || null;
  const sector = p0.sector || null;
  // Forward EPS — analyst-estimates returns rows with field `epsAvg`
  // (FMP's own naming, NOT estimatedEpsAvg). Take the nearest future row.
  // Critical: do NOT fall back to estimates[0] — that's a HISTORICAL annual
  // estimate that would produce a totally wrong "forward" P/E. If no future
  // estimate exists, return null so Valuation goes purple (na) — honest.
  const todayStr = new Date().toISOString().slice(0, 10);
  const future = (estimates || []).filter(e => e.date && e.date >= todayStr)
                                  .sort((a, b) => a.date.localeCompare(b.date));
  const fwdEps = future[0]?.epsAvg ?? null;

  // Sector RS delta needs the ticker's sector ETF + SPY history — fetched
  // (and cached per-symbol, see getSectorHist/getSpyHist) only once we know
  // the sector/industry from the profile fetch above.
  const etfSymbol = sectorEtfFor(sector, industry);
  const [sectorHist, spyHist] = etfSymbol
    ? await Promise.all([getSectorHist(etfSymbol), getSpyHist()])
    : [null, null];

  // Run all 11 checks
  const checks = [
    checkTrend(hist),                              // 1
    check3MMomentum(hist),                         // 2
    checkNearHigh(hist),                           // 3
    checkLiquidity(hist, quote),                   // 4
    checkAnalystRevisions(ptSummary, grades),      // 5
    checkValuation(price, fwdEps, industry),       // 6
    checkQuality(cf, keyMetrics, industry),        // 7
    checkLeverage(bs, inc),                        // 8
    checkCatalyst(earningsHist),                   // 9
    checkVolumeSurge(quote, hist),                 // 10 (was Short Squeeze — no data on plan)
    checkSectorStrength(sectorHist, spyHist),      // 11
  ];

  // Graduated score: sum of points (0-3 per check) out of 33.
  // na checks contribute 0 points (data unavailable, not a pass or fail).
  const score = checks.reduce((s, c) => s + (c.points ?? 0), 0);
  const total = 33;

  // Last PRICE_HIST_DAYS (50) trading days, oldest→newest, for the trade-card
  // price path + moving-average curves. hist is already fetched for scoring
  // (320d, most-recent-first) so this is free — no extra FMP call.
  //
  // Built to be self-correcting and rolling:
  //   1. Validate EVERY point — a valid ISO date and a finite, positive
  //      close. Garbage rows (nulls, zeros, NaN, malformed dates) are
  //      dropped rather than poisoning the chart's min/max scaling.
  //   2. Dedupe by date (FMP occasionally double-lists a session).
  //   3. Sort by date DESC and take the N most-recent valid days. Because
  //      this runs on every rescan against a freshly fetched 320-day window,
  //      the set rolls forward automatically: a new session enters at the
  //      front and the oldest drops off. The 50/200DMA, price target, and
  //      stop are recomputed from the same fresh feed, so they roll in
  //      lockstep.
  const priceHist = buildPriceHist(hist);

  // SWING BACKTEST FEATURE — reconstruct the EOD-computable swing signal (the
  // trend/momentum core of the score) for the as-if trade log. Uses the same
  // fetched hist + already-cached SPY/sector history, so no extra FMP call. The
  // rescan loop folds row.bt into the ticker's trade log via recordShortTransition.
  //
  // COMPLETED-SESSION GUARD: historical-price-eod/full carries today's IN-PROGRESS
  // partial bar during market hours. Fold that and the persisted trade log becomes
  // look-ahead-contaminated + non-deterministic (the entry depends on which minute
  // the rescan fires, and then wins the seed merge — see swing-validation report
  // P3). So the fold signal is built from COMPLETED bars only: drop hist[0] until
  // the ET session closes, making row.bt byte-identical to the seed replay's
  // completed-bar signal. (The chart/score chips above may still use the live bar.)
  let cleanedHist = cleanHist(hist);
  if (cleanedHist.length && !sessionComplete(cleanedHist[0].date, etDateStr(), etParts().minutesOfDay)) {
    cleanedHist = cleanedHist.slice(1);
  }
  const btSignal = computeShortSignal(cleanedHist, {
    spyStrength: spyHist ? strengthFactor(spyHist) : null,
    sectorStrength: sectorHist ? strengthFactor(sectorHist) : null,
  });

  const row = {
    sym,
    name,
    price,
    sector,
    industry,
    score: `${score}/${total}`,
    v: checks.map(c => (c.points ?? 0) >= 2), // backward-compat boolean (ok or good = true)
    reasons: checks.map(c => c.summary),
    raw: checks.map(c => c.value),
    verdicts: checks.map(c => c.verdict), // "good"|"ok"|"weak"|"bad"|"na" for chip colors
    priceHist,
    bt: btSignal, // SWING BACKTEST FEATURE — signal detail for the paper-trade log
    warnings,
    scored_at: new Date().toISOString(),
  };

  await putShortFmpCache(sym, { _v: 15, row }).catch(() => {});
  return row;
}
