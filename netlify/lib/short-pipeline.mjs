/* ---------- Short Term (1wk-3mo swing trading) pipeline ----------
   Pure FMP — zero Anthropic calls. Scores each ticker on a 10-check
   momentum/quality/catalyst factor stack tuned for 2-12 week holds.

   Each check returns { verdict: 'good' | 'bad' | 'na', summary, value }.
   - good/bad → green/red chip
   - na → purple chip (only when underlying data couldn't be fetched)
*/
import { getShortFmpCache, putShortFmpCache, deleteShortFmpCache } from "./store.mjs";

const FMP = "https://financialmodelingprep.com/stable";

/* ---------- FMP fetch helper ---------- */
async function fmp(endpoint, ticker, extra = "") {
  const key = process.env.FMP_API_KEY;
  const url = `${FMP}/${endpoint}?symbol=${ticker}&apikey=${key}${extra}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`FMP ${endpoint} ${ticker} → ${r.status}`);
  return r.json();
}

async function safe(endpoint, ticker, extra = "") {
  try {
    const d = await fmp(endpoint, ticker, extra);
    return Array.isArray(d) ? d : (d && !d["Error Message"] ? [d] : []);
  } catch { return []; }
}

const delay = ms => new Promise(r => setTimeout(r, ms));

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

/* ---------- Per-check scoring functions ---------- */

// 1. Trend: Price > 50DMA > 200DMA
function checkTrend(hist) {
  if (!hist || hist.length < 200) return { verdict: "na", summary: "Need 200 days of price history", value: null };
  // FMP returns newest first; closes in `price` field
  const closes = hist.slice(0, 220).map(d => d.price ?? d.close).filter(p => p != null);
  if (closes.length < 200) return { verdict: "na", summary: "Insufficient price history", value: null };
  const sma = (n) => closes.slice(0, n).reduce((s, x) => s + x, 0) / n;
  const price = closes[0];
  const sma50 = sma(50);
  const sma200 = sma(200);
  const up = price > sma50 && sma50 > sma200;
  return {
    verdict: up ? "good" : "bad",
    summary: up
      ? `Uptrend: $${price.toFixed(2)} > 50DMA $${sma50.toFixed(2)} > 200DMA $${sma200.toFixed(2)}`
      : `No uptrend: price $${price.toFixed(2)}, 50DMA $${sma50.toFixed(2)}, 200DMA $${sma200.toFixed(2)}`,
    value: { price, sma50, sma200 },
  };
}

// 2. 3M Momentum: 3-month return positive (proxy for "top 30%" — true ranking
//    requires a universe scan that's too expensive per ticker; a positive 3M
//    return above ~5% is a reasonable single-ticker proxy)
function check3MMomentum(hist) {
  if (!hist || hist.length < 65) return { verdict: "na", summary: "Need 3 months of price history", value: null };
  const closes = hist.slice(0, 70).map(d => d.price ?? d.close).filter(p => p != null);
  if (closes.length < 63) return { verdict: "na", summary: "Insufficient price history", value: null };
  const now = closes[0];
  const then = closes[62]; // ~63 trading days ≈ 3 months
  if (!then || then <= 0) return { verdict: "na", summary: "Bad reference price", value: null };
  const ret = (now / then) - 1;
  const pass = ret >= 0.05;
  return {
    verdict: pass ? "good" : "bad",
    summary: pass
      ? `3-month return +${(ret * 100).toFixed(1)}% (strong momentum)`
      : `3-month return ${(ret * 100).toFixed(1)}% (lagging)`,
    value: ret,
  };
}

// 3. Near High: within 15% of 52-week high
function checkNearHigh(hist) {
  if (!hist || hist.length < 200) return { verdict: "na", summary: "Need 52 weeks of price history", value: null };
  const window = hist.slice(0, 260);
  const closes = window.map(d => d.price ?? d.close).filter(p => p != null);
  if (closes.length < 200) return { verdict: "na", summary: "Insufficient price history", value: null };
  const high = Math.max(...closes);
  const now = closes[0];
  const pctOff = (high - now) / high;
  const pass = pctOff <= 0.15;
  return {
    verdict: pass ? "good" : "bad",
    summary: pass
      ? `Within ${(pctOff * 100).toFixed(1)}% of 52w high ($${high.toFixed(2)})`
      : `${(pctOff * 100).toFixed(1)}% off 52w high ($${high.toFixed(2)}) — trend may be broken`,
    value: { high, pctOff },
  };
}

// 4. Liquidity: 20-day avg $-volume ≥ $20M
function checkLiquidity(hist, quote) {
  if (!hist || hist.length < 20) return { verdict: "na", summary: "Need 20 days of price history", value: null };
  const window = hist.slice(0, 20);
  const dollarVols = window.map(d => (d.price ?? d.close ?? 0) * (d.volume ?? 0)).filter(v => v > 0);
  if (!dollarVols.length) return { verdict: "na", summary: "No volume data", value: null };
  const avgDollarVol = dollarVols.reduce((s, x) => s + x, 0) / dollarVols.length;
  const pass = avgDollarVol >= 20_000_000;
  const fmt = (n) => n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : `$${(n / 1e6).toFixed(1)}M`;
  return {
    verdict: pass ? "good" : "bad",
    summary: pass
      ? `20-day avg $-volume ${fmt(avgDollarVol)} (liquid)`
      : `20-day avg $-volume ${fmt(avgDollarVol)} (too thin)`,
    value: avgDollarVol,
  };
}

// 5. Analyst Revisions — uses FMP's price-target-summary + grades-historical,
//    both available immediately for every covered ticker (no snapshot warm-up).
//    Two signals, averaged:
//      a) Price-target drift: lastMonth avg PT vs lastQuarter avg PT
//      b) Rating drift:       latest month buy ratio vs ~3 months ago buy ratio
//    Pass if the average of the two normalized deltas is positive.
function checkAnalystRevisions(ptSummary, grades) {
  const s = (ptSummary || [])[0] || null;
  const g = Array.isArray(grades) ? grades : [];
  // Only use PT signal when there are actual recent price-target updates.
  // lastMonthAvgPriceTarget=0 means no PTs filed that month, not a price target of $0.
  const ptCount = s?.lastMonthCount ?? 0;
  const ptNow  = ptCount >= 1 ? s?.lastMonthAvgPriceTarget  : null;
  const ptThen = s?.lastQuarterAvgPriceTarget;
  const havePT = ptNow != null && ptNow > 0 && ptThen != null && ptThen > 0;

  // Grades are newest-first. Compute buy ratio = (StrongBuy+Buy) / total.
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
  const brThen = buyRatio(g[3]); // ~3 months back (monthly snapshots)
  const haveBR = brNow != null && brThen != null;

  if (!havePT && !haveBR) {
    return { verdict: "na", summary: "No analyst coverage data (price targets or rating history)", value: null };
  }

  const ptDelta = havePT ? (ptNow - ptThen) / ptThen : null;       // fractional change
  const brDelta = haveBR ? (brNow - brThen) : null;                  // pp change
  // Combine: average available signals (PT delta and BR delta on similar scale already)
  const signals = [];
  if (ptDelta != null) signals.push(ptDelta);
  if (brDelta != null) signals.push(brDelta);
  const composite = signals.reduce((a, b) => a + b, 0) / signals.length;
  const pass = composite > 0;

  const parts = [];
  if (havePT) parts.push(`PT $${ptThen.toFixed(0)}→$${ptNow.toFixed(0)} (${ptDelta >= 0 ? "+" : ""}${(ptDelta * 100).toFixed(1)}%)`);
  if (haveBR) parts.push(`Buy ratio ${(brThen * 100).toFixed(0)}%→${(brNow * 100).toFixed(0)}%`);
  return {
    verdict: pass ? "good" : "bad",
    summary: pass
      ? `Analysts more bullish: ${parts.join(" · ")}`
      : `Analysts cooling: ${parts.join(" · ")}`,
    value: { ptNow, ptThen, brNow, brThen, composite },
  };
}

// 6. Valuation: Forward P/E ≤ sector 75th percentile (not egregiously expensive)
function checkValuation(price, fwdEps, industry) {
  if (!price || !fwdEps || fwdEps <= 0) {
    return { verdict: "na", summary: "No forward P/E (negative or missing fwd EPS)", value: null };
  }
  const fwdPe = price / fwdEps;
  const threshold = sectorPe75th(industry);
  const pass = fwdPe <= threshold;
  return {
    verdict: pass ? "good" : "bad",
    summary: pass
      ? `Fwd P/E ${fwdPe.toFixed(1)}x ≤ ${industry || "sector"} 75th pct (${threshold}x)`
      : `Fwd P/E ${fwdPe.toFixed(1)}x exceeds ${industry || "sector"} 75th pct (${threshold}x) — egregiously expensive`,
    value: { fwdPe, threshold, industry },
  };
}

// 7. Quality: TTM FCF > 0 AND (ROE > sector median).
// FMP keeps `returnOnEquity` on /key-metrics, NOT /ratios.
function checkQuality(cf, keyMetrics, industry) {
  const cfTTM = (cf || []).slice(0, 4).reduce((s, q) => s + (q.freeCashFlow ?? 0), 0);
  const km0 = (keyMetrics || [])[0];
  const roe = km0?.returnOnEquity;
  const median = sectorRoeMedian(industry);
  if (!cf || cf.length < 1 || roe == null) {
    return { verdict: "na", summary: "Missing FCF or ROE data", value: null };
  }
  const fcfOk = cfTTM > 0;
  const roeOk = roe > median;
  const pass = fcfOk && roeOk;
  return {
    verdict: pass ? "good" : "bad",
    summary: pass
      ? `Quality: TTM FCF $${(cfTTM / 1e6).toFixed(0)}M (+), ROE ${(roe * 100).toFixed(1)}% > ${industry || "sector"} median ${(median * 100).toFixed(0)}%`
      : `Quality fails: FCF ${fcfOk ? "+" : "−"}$${Math.abs(cfTTM / 1e6).toFixed(0)}M, ROE ${(roe * 100).toFixed(1)}% vs sector median ${(median * 100).toFixed(0)}%`,
    value: { fcfTTM: cfTTM, roe, sectorMedian: median },
  };
}

// 8. Leverage: Net debt / EBITDA < 3x
function checkLeverage(bs, inc) {
  const bs0 = (bs || [])[0];
  if (!bs0) return { verdict: "na", summary: "No balance sheet data", value: null };
  const totalDebt = bs0.totalDebt ?? 0;
  const cash = bs0.cashAndShortTermInvestments ?? 0;
  const netDebt = totalDebt - cash;
  // EBITDA = operating income + D&A from latest 4 quarters
  const incLast4 = (inc || []).slice(0, 4);
  if (incLast4.length < 1) return { verdict: "na", summary: "No income statement data", value: null };
  const ebitda = incLast4.reduce((s, q) => s + (q.operatingIncome ?? 0) + (q.depreciationAndAmortization ?? 0), 0);
  if (ebitda <= 0) {
    // Negative EBITDA — only fails leverage if also net debt positive
    if (netDebt > 0) {
      return { verdict: "bad", summary: `Net debt $${(netDebt / 1e9).toFixed(2)}B with negative EBITDA — high risk`, value: { netDebt, ebitda } };
    }
    return { verdict: "good", summary: `Net cash position $${(-netDebt / 1e9).toFixed(2)}B (EBITDA negative but no debt burden)`, value: { netDebt, ebitda } };
  }
  const ratio = netDebt / ebitda;
  const pass = ratio < 3;
  return {
    verdict: pass ? "good" : "bad",
    summary: pass
      ? `Net Debt / EBITDA ${ratio.toFixed(2)}x (healthy, < 3x)`
      : `Net Debt / EBITDA ${ratio.toFixed(2)}x (over-levered, ≥ 3x)`,
    value: { netDebt, ebitda, ratio },
  };
}

// 9. Catalyst: Earnings within 1wk-3mo window
function checkCatalyst(earningsHist) {
  if (!earningsHist || !earningsHist.length) return { verdict: "na", summary: "No earnings calendar data", value: null };
  const today = new Date().toISOString().slice(0, 10);
  const future = earningsHist
    .filter(e => e.epsActual == null && e.date > today)
    .sort((a, b) => a.date.localeCompare(b.date));
  const next = future[0];
  if (!next) return { verdict: "bad", summary: "No upcoming earnings catalyst in calendar", value: null };
  const daysUntil = Math.ceil((new Date(next.date) - Date.now()) / 86400000);
  const inWindow = daysUntil >= 7 && daysUntil <= 90;
  return {
    verdict: inWindow ? "good" : "bad",
    summary: inWindow
      ? `Earnings catalyst in ${daysUntil}d (${next.date}) — within 1wk-3mo window`
      : daysUntil < 7
        ? `Earnings in ${daysUntil}d (${next.date}) — too soon (< 1 week)`
        : `Earnings in ${daysUntil}d (${next.date}) — outside 3-month window`,
    value: { date: next.date, daysUntil },
  };
}

// 10. Volume Surge: today's volume ≥ 1.5× the 20-day average.
// (Replaces the original Short-Squeeze chip — FMP's /short-interest endpoint
//  returns no data on the current plan tier. Volume surge is a stronger
//  leading indicator for swing-trade timing anyway: unusual volume nearly
//  always precedes a meaningful price move.)
function checkVolumeSurge(quote, hist) {
  const q0 = (quote || [])[0];
  const todayVol = q0?.volume;
  if (todayVol == null) return { verdict: "na", summary: "No current volume reading", value: null };
  if (!hist || hist.length < 20) return { verdict: "na", summary: "Need 20 days of volume history", value: null };
  // Skip today's bar (often the same as `quote.volume`) so we get a true comparison baseline
  const vols = hist.slice(1, 21).map(d => d.volume).filter(v => v != null && v > 0);
  if (vols.length < 15) return { verdict: "na", summary: "Volume history too sparse", value: null };
  const avg20 = vols.reduce((s, x) => s + x, 0) / vols.length;
  const rv = todayVol / avg20;
  const pass = rv >= 1.5;
  return {
    verdict: pass ? "good" : "bad",
    summary: pass
      ? `Volume ${rv.toFixed(2)}× the 20-day avg — unusual activity, often precedes a move`
      : `Volume only ${rv.toFixed(2)}× the 20-day avg — no surge`,
    value: { rv, todayVol, avg20 },
  };
}

/* ---------- Main scorer ---------- */
export async function scoreTickerShort(ticker, { skipCache = false } = {}) {
  const sym = ticker.toUpperCase();

  // Cache check
  if (!skipCache) {
    const cached = await getShortFmpCache(sym);
    if (cached && cached._v === 2) {
      return cached.row;
    }
  } else {
    await deleteShortFmpCache(sym).catch(() => {});
  }

  // Fetch FMP data (sequential with small delay to stay under rate limits)
  let hist, quote, keyMetrics, estimates, cf, bs, inc, profile, earningsHist, ptSummary, grades;
  try {
    hist          = await safe("historical-price-eod/light", sym, "&limit=260"); await delay(200);
    quote         = await safe("quote", sym);                                     await delay(200);
    keyMetrics    = await safe("key-metrics", sym, "&period=annual&limit=2");     await delay(200);
    estimates     = await safe("analyst-estimates", sym, "&period=annual&limit=3"); await delay(200);
    cf            = await safe("cash-flow-statement", sym, "&period=quarter&limit=4"); await delay(200);
    bs            = await safe("balance-sheet-statement", sym, "&period=quarter&limit=1"); await delay(200);
    inc           = await safe("income-statement", sym, "&period=quarter&limit=4"); await delay(200);
    profile       = await safe("profile", sym);                                   await delay(200);
    earningsHist  = await safe("earnings", sym, "&limit=6");                     await delay(200);
    ptSummary     = await safe("price-target-summary", sym);                     await delay(200);
    grades        = await safe("grades-historical", sym, "&limit=6");
  } catch (e) {
    console.error(`[short] ${sym} fetch error:`, e?.message || e);
  }

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

  const score = checks.filter(c => c.verdict === "good").length;
  const total = 10;

  const row = {
    sym,
    name,
    price,
    sector,
    industry,
    score: `${score}/${total}`,
    v: checks.map(c => c.verdict === "good"),
    reasons: checks.map(c => c.summary),
    raw: checks.map(c => c.value),
    verdicts: checks.map(c => c.verdict), // exposes 'na' to frontend for purple chips
    scored_at: new Date().toISOString(),
  };

  await putShortFmpCache(sym, { _v: 2, row }).catch(() => {});
  return row;
}
