/* ---------- Short Term (1wk-3mo swing trading) pipeline ----------
   Pure FMP — zero Anthropic calls. Scores each ticker on a 10-factor
   momentum/quality/catalyst stack tuned for 2-12 week holds.

   Each check returns { points: 0-3 | null, verdict, summary, value }.
   - points 3 → "good"  (green chip)
   - points 2 → "ok"    (muted green chip)
   - points 1 → "weak"  (amber chip)
   - points 0 → "bad"   (red chip)
   - points null → "na" (purple chip — data unavailable)

   Score = sum of points across all 10 checks, out of 30.
   Thresholds: 20+ strong, 12-19 mixed, <12 weak.
*/
import { getShortFmpCache, putShortFmpCache, deleteShortFmpCache } from "./store.mjs";

const FMP = "https://financialmodelingprep.com/stable";

/* ---------- FMP fetch helper ---------- */
async function fmp(endpoint, ticker, extra = "") {
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
// With 39+ tickers × 11 FMP calls each, late tickers in a full rescan
// can hit FMP's per-minute limit — without retry they silently get empty
// data and score all-purple.
async function safe(endpoint, ticker, extra = "") {
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

const delay = ms => new Promise(r => setTimeout(r, ms));

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
function validateShortData(sym, { quote, profile, hist, inc }) {
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
  // hist[0].price is YESTERDAY'S close (today's EOD bar hasn't formed yet), so
  // including it would flag every >6% intraday mover as a "divergence" and
  // blank all data. Use it only as a soft sanity floor (must be > 0).
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

/* ---------- Per-check scoring functions ----------
   Each returns { points: 0-3 | null, verdict, summary, value }.
   points null = "na" (data unavailable); 0 = bad, 1 = weak, 2 = ok, 3 = good.
   Score = sum of points across all 10 checks, out of 30. */

function na(summary) {
  return { points: null, verdict: "na", summary, value: null };
}
function scored(points, summary, value) {
  const verdict = points >= 3 ? "good" : points >= 2 ? "ok" : points >= 1 ? "weak" : "bad";
  return { points, verdict, summary, value };
}

// 1. Trend: how cleanly price is above its moving averages
function checkTrend(hist) {
  if (!hist || hist.length < 200) return na("Need 200 days of price history");
  const closes = hist.slice(0, 220).map(d => d.price ?? d.close).filter(p => p != null);
  if (closes.length < 200) return na("Insufficient price history");
  const sma = (n) => closes.slice(0, n).reduce((s, x) => s + x, 0) / n;
  const price = closes[0];
  const sma50 = sma(50);
  const sma200 = sma(200);
  const pctAbove50 = (price - sma50) / sma50;
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
  return scored(points, `$${price.toFixed(2)} vs 50DMA $${sma50.toFixed(2)} / 200DMA $${sma200.toFixed(2)} — ${label}`, { price, sma50, sma200 });
}

// 2. 3M Momentum: graduated by return magnitude
function check3MMomentum(hist) {
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
function checkNearHigh(hist) {
  if (!hist || hist.length < 200) return na("Need 52 weeks of price history");
  const closes = hist.slice(0, 260).map(d => d.price ?? d.close).filter(p => p != null);
  if (closes.length < 200) return na("Insufficient price history");
  const high = Math.max(...closes);
  const now = closes[0];
  const pctOff = (high - now) / high;
  let points;
  if (pctOff <= 0.05)       points = 3;
  else if (pctOff <= 0.15)  points = 2;
  else if (pctOff <= 0.30)  points = 1;
  else                      points = 0;
  const label = points === 3 ? "at/near 52w high" : points === 2 ? "near high" : points === 1 ? "recovering" : "far from high";
  return scored(points, `${(pctOff * 100).toFixed(1)}% off 52w high ($${high.toFixed(2)}) — ${label}`, { high, pctOff });
}

// 4. Liquidity: 20-day avg $-volume — graduated by how tradeable
function checkLiquidity(hist, quote) {
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
function checkAnalystRevisions(ptSummary, grades) {
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
  const brNow = buyRatio(g[0]);
  const brThen = buyRatio(g[3]);
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
function checkValuation(price, fwdEps, industry) {
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
function checkQuality(cf, keyMetrics, industry) {
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
function checkLeverage(bs, inc) {
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
function checkCatalyst(earningsHist) {
  if (!earningsHist || !earningsHist.length) return na("No earnings calendar data");
  const today = new Date().toISOString().slice(0, 10);
  const future = earningsHist
    .filter(e => e.epsActual == null && e.date > today)
    .sort((a, b) => a.date.localeCompare(b.date));
  const next = future[0];
  if (!next) return scored(0, "No upcoming earnings catalyst in calendar", null);
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

// 10. Volume Surge: today vs 20-day avg, direction-aware.
// Big volume on an UP day = accumulation (institutions buying) → reward.
// Big volume on a DOWN day = distribution (institutions selling) → penalize.
// Volume alone is direction-blind — pairing it with intraday direction
// turns a noisy "lots happened today" signal into a buy-vs-sell signal.
function checkVolumeSurge(quote, hist) {
  const q0 = (quote || [])[0];
  const todayVol = q0?.volume;
  if (todayVol == null) return na("No current volume reading");
  if (!hist || hist.length < 20) return na("Need 20 days of volume history");
  const vols = hist.slice(1, 21).map(d => d.volume).filter(v => v != null && v > 0);
  if (vols.length < 15) return na("Volume history too sparse");
  const avg20 = vols.reduce((s, x) => s + x, 0) / vols.length;
  const rv = shortSane(todayVol / avg20, "volRv");
  if (rv == null) return na("Volume ratio out of plausible range — data suspect");

  // Direction: prefer FMP's intraday % change; fall back to quote.price vs prior close
  const pctChange = q0?.changePercentage ?? q0?.changesPercentage ?? null;
  const priorClose = hist?.[1]?.price ?? hist?.[1]?.close ?? null;
  const livePrice  = q0?.price ?? null;
  const dir = pctChange != null
    ? Math.sign(pctChange)
    : (livePrice != null && priorClose != null ? Math.sign(livePrice - priorClose) : 0);
  const isUp = dir > 0;
  const isDown = dir < 0;
  const dirLabel = isUp ? "up" : isDown ? "down" : "flat";

  let points, label;
  if (rv >= 1.5 && isDown) {
    // High volume + price down = institutional distribution. This is a warning,
    // not a buy signal. Force red regardless of how big the surge is.
    points = 0;
    label = `distribution — heavy selling pressure`;
  } else if (rv >= 2.5 && isUp) {
    points = 3; label = "strong accumulation";
  } else if (rv >= 1.5 && isUp) {
    points = 2; label = "above-average buying";
  } else if (rv >= 2.5) {
    // Big volume on a flat day — usually news pending, treat as ok
    points = 2; label = "elevated activity (flat)";
  } else if (rv >= 1.5) {
    points = 1; label = "elevated but inconclusive";
  } else if (rv >= 0.8) {
    points = 1; label = "normal";
  } else {
    points = 0; label = "below average — stock being ignored";
  }
  return scored(points,
    `Volume ${rv.toFixed(2)}× the 20-day avg, price ${dirLabel} — ${label}`,
    { rv, todayVol, avg20, dir, isUp, isDown });
}

/* ---------- Main scorer ---------- */
export async function scoreTickerShort(ticker, { skipCache = false } = {}) {
  const sym = ticker.toUpperCase();

  // Cache check
  if (!skipCache) {
    const cached = await getShortFmpCache(sym);
    if (cached && cached._v === 6) {
      return cached.row;
    }
  } else {
    await deleteShortFmpCache(sym).catch(() => {});
  }

  // Fetch FMP data (sequential with small delay to stay under rate limits).
  // Wrapped in a closure so the 3-step integrity check can retry it once.
  const runFmp = async () => {
    const d = {};
    d.hist          = await safe("historical-price-eod/light", sym, "&limit=260"); await delay(200);
    d.quote         = await safe("quote", sym);                                     await delay(200);
    d.keyMetrics    = await safe("key-metrics", sym, "&period=annual&limit=2");     await delay(200);
    d.estimates     = await safe("analyst-estimates", sym, "&period=annual&limit=3"); await delay(200);
    d.cf            = await safe("cash-flow-statement", sym, "&period=quarter&limit=4"); await delay(200);
    d.bs            = await safe("balance-sheet-statement", sym, "&period=quarter&limit=1"); await delay(200);
    d.inc           = await safe("income-statement", sym, "&period=quarter&limit=4"); await delay(200);
    d.profile       = await safe("profile", sym);                                   await delay(200);
    d.earningsHist  = await safe("earnings", sym, "&limit=6");                     await delay(200);
    d.ptSummary     = await safe("price-target-summary", sym);                     await delay(200);
    d.grades        = await safe("grades-historical", sym, "&limit=6");
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
  const todayStr = new Date().toISOString().slice(0, 10);
  const future = (estimates || []).filter(e => e.date && e.date >= todayStr)
                                  .sort((a, b) => a.date.localeCompare(b.date));
  const fwdEps = future[0]?.epsAvg ?? (estimates || [])[0]?.epsAvg ?? null;

  // Run all 10 checks
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
  ];

  // Graduated score: sum of points (0-3 per check) out of 30.
  // na checks contribute 0 points (data unavailable, not a pass or fail).
  const score = checks.reduce((s, c) => s + (c.points ?? 0), 0);
  const total = 30;

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
    warnings,
    scored_at: new Date().toISOString(),
  };

  await putShortFmpCache(sym, { _v: 6, row }).catch(() => {});
  return row;
}
