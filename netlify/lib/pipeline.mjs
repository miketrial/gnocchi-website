import Anthropic from "@anthropic-ai/sdk";
import { getFmpCache, putFmpCache, deleteFmpCache, getLayer2Cache, putLayer2Cache, deleteLayer2Cache, getHaikuUsage, incrHaikuUsage, haikuCap } from "./store.mjs";

// Haiku only — used for the 3 event columns that require live web search.
const GATHER_MODEL = "claude-haiku-4-5";
const FMP = "https://financialmodelingprep.com/stable";

async function createWithRetry(client, params, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      return await client.messages.create(params);
    } catch (e) {
      const status = e && (e.status || e.statusCode);
      if (status === 429 && i < tries - 1) {
        const waitMs = (e.headers && Number(e.headers["retry-after"]) * 1000) || 35000;
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
      throw e;
    }
  }
}

/* ---------- FMP REST helper ---------- */
async function fmp(endpoint, ticker, extra = "") {
  const key = process.env.FMP_API_KEY;
  const url = `${FMP}/${endpoint}?symbol=${ticker}&apikey=${key}${extra}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`FMP ${endpoint} ${ticker} → ${r.status}`);
  return r.json();
}

function ttm(arr, field) {
  return arr.slice(0, 4).reduce((s, q) => s + (q[field] || 0), 0);
}

/* ---------- Sanity range gates — catch FMP data quality issues before scoring ---------- */
// Returns value if within a plausible real-world range; null otherwise.
const SANITY_RANGES = {
  revenueGrowth:    { min: -0.99, max: 49.0  },  // -99% to +4900%
  grossMarginAbs:   { min: -0.50, max: 1.00  },  // as fraction (0–1)
  grossMarginDelta: { min: -0.50, max: 0.50  },  // fraction change per quarter
  debtToEquity:     { min: 0,     max: 50.0  },
  interestCoverage: { min: -100,  max: 5000  },
  peRatio:          { min: 0.5,   max: 500   },
  psRatio:          { min: 0.05,  max: 200   },
  fwdPE:            { min: 1.0,   max: 500   },
};
function sanity(value, field) {
  if (value == null || !isFinite(value)) return null;
  const r = SANITY_RANGES[field];
  if (!r) return value;
  return (value >= r.min && value <= r.max) ? value : null;
}

/* ---------- Company name mismatch check — catches sym-flips that priceDiverged misses
   (when both /profile and /quote return the same wrong price from the same CDN node).
   Strategy: if every distinctive word in the known name is absent from the fresh name,
   it's almost certainly a different company's data. */
function nameMismatch(known, fresh) {
  const GENERIC = new Set([
    'corp', 'inc', 'ltd', 'llc', 'co', 'corporation', 'incorporated',
    'holdings', 'group', 'company', 'enterprises', 'industries',
    'technologies', 'technology', 'systems', 'services', 'solutions',
    'global', 'national', 'american', 'international',
    'bank', 'data', 'tech', 'fund', 'care', 'life', 'home', 'auto',
  ]);
  const sig = s => s.toLowerCase().replace(/[^a-z]/g, ' ').split(' ')
    .filter(w => w.length >= 4 && !GENERIC.has(w));
  const ks = sig(known);
  if (ks.length === 0) return false; // name too short/generic to validate
  const fs = new Set(sig(fresh));
  return ks.every(w => !fs.has(w)); // ALL known distinctive words absent → wrong company
}

/* ---------- Layer 1a: FMP pull — triple-layer validated (v5) ---------- */
async function layer1a(ticker, { knownName, skipCache } = {}) {
  const delay = ms => new Promise(r => setTimeout(r, ms));

  // A force rescan must bypass the FMP cache entirely. The cache can hold data
  // poisoned by a prior CDN sym-flip (e.g. Applied Digital served for every
  // ticker); reading it would make "force rescan" silently serve stale poison
  // and never hit the healed FMP endpoint. Evict so we refetch fresh below.
  if (skipCache) {
    await deleteFmpCache(ticker).catch(() => {});
  } else {
    const cached = await getFmpCache(ticker);
    if (cached && cached._v === 12) {
      // If we have a known good name, validate the cache entry isn't from a sym-flip
      if (knownName && cached.company_name && nameMismatch(knownName, cached.company_name)) {
        await deleteFmpCache(ticker); // evict poisoned entry, fall through to fresh fetch
      } else {
        return cached;
      }
    }
  }

  // Always return an array; FMP returns {"Error Message":"..."} for bad keys/plans
  const safe = async (ep, extra) => {
    try {
      const d = await fmp(ep, ticker, extra);
      return Array.isArray(d) ? d : (d && !d["Error Message"] ? [d] : []);
    } catch { return []; }
  };

  const runFmp = async () => {
    // Core financials
    const incQ       = await safe("income-statement",         "&period=quarter&limit=5"); await delay(300);
    const incA       = await safe("income-statement",         "&period=annual&limit=2");  await delay(300);
    const bs         = await safe("balance-sheet-statement",  "&period=quarter&limit=2"); await delay(300);
    const cf         = await safe("cash-flow-statement",      "&period=quarter&limit=4"); await delay(300);
    // Layer B: FMP pre-computed YoY growth rates (authoritative, avoids our manual TTM math)
    const incGrowthQ = await safe("income-statement-growth",  "&period=quarter&limit=1"); await delay(300);
    const annGrowth  = await safe("financial-growth",         "&period=annual&limit=1");  await delay(300);
    // Forward estimates
    const estimates  = await safe("analyst-estimates",        "&period=annual&limit=5");  await delay(300);
    // Layer B: Real earnings calendar — actual next date + beat/miss history (replaces +91d estimate)
    const earningsHist = await safe("earnings",               "&limit=6");                await delay(300);
    // Analyst data
    const grades     = await safe("grades-consensus",         "");                        await delay(300);
    const priceTgt   = await safe("price-target-consensus",   "");                        await delay(300);
    const gradesList = await safe("grades",                   "&limit=8");                await delay(300);
    // Profile + FMP pre-computed ratios (primary source for PE/PS/D&E — currency-safe)
    const profile    = await safe("profile",                  "");                        await delay(300);
    const ratios     = await safe("ratios",                   "&period=annual&limit=5");  await delay(300);
    const insider    = await safe("insider-trading",          "&limit=30");
    const shortInfo  = await safe("short-interest",           "&limit=1");
    const quote      = await safe("quote",                    "");
    return { incQ, incA, bs, cf, incGrowthQ, annGrowth, estimates, earningsHist,
             grades, priceTgt, gradesList, profile, ratios, insider, shortInfo, quote };
  };

  let data = await runFmp();
  if (!data.incQ.length && !data.incA.length && !data.profile.length) {
    await delay(5000);
    data = await runFmp();
  }
  // Sym-flip guard: FMP occasionally returns data for the wrong ticker.
  // Checks BOTH profile symbol AND income-statement symbol to catch partial sym-flips
  // (where profile CDN cache returns correctly but financial endpoints return wrong ticker).
  const symFlipped = (d) => {
    const profSym = d.profile[0]?.symbol?.toUpperCase();
    const incSym  = d.incQ[0]?.symbol?.toUpperCase();
    return (profSym && profSym !== ticker.toUpperCase()) ||
           (incSym  && incSym  !== ticker.toUpperCase());
  };
  // Price cross-check: compare profile price against /quote (different CDN path).
  // Catches partial sym-flips where symbol field is correct but price/financials are wrong.
  const priceDiverged = (d) => {
    const profPrice  = d.profile[0]?.price;
    const quotePrice = d.quote[0]?.price;
    if (!profPrice || !quotePrice || profPrice <= 0 || quotePrice <= 0) return false;
    const ratio = profPrice / quotePrice;
    return ratio < 0.7 || ratio > 1.43; // >30% mismatch = likely sym-flip
  };
  if (symFlipped(data) || priceDiverged(data)) {
    await delay(4000);
    data = await runFmp();
    if (symFlipped(data) || priceDiverged(data)) {
      // Clear all data that could bleed wrong ticker's info
      data = { ...data, profile: [], incQ: [], incA: [], bs: [], cf: [],
               incGrowthQ: [], annGrowth: [], ratios: [] };
    }
  }

  const { incQ, incA, bs, cf, incGrowthQ, annGrowth, estimates, earningsHist,
          grades, priceTgt, gradesList, profile, ratios, insider, shortInfo } = data;

  const haveInc = incQ.length >= 4;
  const haveBS  = bs.length >= 1;
  const haveCF  = cf.length >= 1;
  const q0 = incQ[0] || {}, q4 = incQ[4] || {};
  const bs0 = bs[0] || {};

  // r0: FMP pre-computed annual ratios — authoritative for PE/PS/margins/D&E (currency-safe)
  const r0               = ratios[0] || null;
  const reportedCurrency = r0?.reportedCurrency || "USD";
  const todayStr         = new Date().toISOString().slice(0, 10);

  // ── Revenue ──────────────────────────────────────────────────────────────────
  // Primary: FMP income-statement-growth quarterly YoY (most current)
  // Secondary: annual growth; Tertiary: our TTM arithmetic
  const revTTM         = haveInc ? ttm(incQ, "revenue") : (incA[0] ? incA[0].revenue : null);
  const revPriorTTM    = incA.length >= 2 ? incA[1].revenue : null;
  const revGrowthCalc  = (revTTM && revPriorTTM && revPriorTTM !== 0)
    ? sanity((revTTM - revPriorTTM) / Math.abs(revPriorTTM), "revenueGrowth") : null;
  const revGrowthQ     = sanity(incGrowthQ[0]?.growthRevenue     ?? null, "revenueGrowth");
  const revGrowthAnn   = sanity(annGrowth[0]?.revenueGrowth      ?? null, "revenueGrowth");
  // Cross-check: flag large divergence between quarterly FMP and our TTM calc
  const revGrowth      = revGrowthQ ?? revGrowthAnn ?? revGrowthCalc;
  const revCrossWarn   = (revGrowthQ != null && revGrowthCalc != null
    && Math.abs(revGrowthQ - revGrowthCalc) / (Math.abs(revGrowthCalc) || 0.01) > 0.5);

  // ── Margins — all stored as fraction (0–1); multiply ×100 in display strings ─
  // Primary: FMP ratios annual (consistent local currency)
  // Delta: FMP income-statement-growth quarterly (most current YoY change)
  const grossMarginLatest    = sanity(r0?.grossProfitMargin    ?? (haveInc && q0.revenue ? q0.grossProfit / q0.revenue : null), "grossMarginAbs");
  const grossMarginPriorYrQ  = sanity(haveInc && incQ.length >= 5 && q4.revenue ? q4.grossProfit / q4.revenue : null, "grossMarginAbs");
  const opMarginLatest       = sanity(r0?.operatingProfitMargin ?? (haveInc && q0.revenue ? q0.operatingIncome / q0.revenue : null), "grossMarginAbs");
  const opMarginPriorYrQ     = sanity(haveInc && incQ.length >= 5 && q4.revenue ? q4.operatingIncome / q4.revenue : null, "grossMarginAbs");
  // FMP pre-computed quarterly margin delta (primary for col_C scoring)
  const grossMarginDeltaFMP  = sanity(incGrowthQ[0]?.growthGrossProfitRatio ?? null, "grossMarginDelta");
  const opMarginDeltaFMP     = sanity(incGrowthQ[0]?.growthOperatingIncome  ?? null, "grossMarginDelta");
  const grossMarginDeltaCalc = (grossMarginLatest != null && grossMarginPriorYrQ != null)
    ? grossMarginLatest - grossMarginPriorYrQ : null;

  // ── Debt — primary from FMP ratios (handles non-USD reporters correctly) ──────
  const debtToEquityRatio  = sanity(r0?.debtToEquityRatio ?? null, "debtToEquity");
  // Interest coverage: treat zero from FMP as "no interest expense" (fine); use only positive values
  const icRaw              = r0?.interestCoverageRatio;
  const interestCoverage   = (icRaw != null && icRaw > 0) ? sanity(icRaw, "interestCoverage") : null;
  const netCash            = haveBS ? (bs0.cashAndShortTermInvestments ?? 0) - (bs0.totalDebt ?? 0) : null;
  const debtGrowthYoY      = annGrowth[0]?.debtGrowth ?? null;

  // ── Guidance: real EPS beat/miss from /earnings (was hardcoded "unknown") ─────
  const reportedEarnings = (earningsHist || [])
    .filter(e => e.epsActual != null && e.date <= todayStr)
    .sort((a, b) => b.date.localeCompare(a.date));
  const latestReported = reportedEarnings[0] || null;
  let guidanceSummary = "unknown";
  if (latestReported && latestReported.epsEstimated != null) {
    const beat = latestReported.epsActual >= latestReported.epsEstimated;
    const diff = latestReported.epsEstimated !== 0
      ? ((latestReported.epsActual - latestReported.epsEstimated) / Math.abs(latestReported.epsEstimated) * 100).toFixed(1)
      : "N/A";
    guidanceSummary = beat
      ? `beat — reported $${latestReported.epsActual.toFixed(2)} vs $${latestReported.epsEstimated.toFixed(2)} est (+${diff}%)`
      : `missed — reported $${latestReported.epsActual.toFixed(2)} vs $${latestReported.epsEstimated.toFixed(2)} est (${diff}%)`;
  }

  // ── Real next earnings date (replaces last_date + 91d estimate) ──────────────
  const futureEarnings  = (earningsHist || [])
    .filter(e => e.epsActual == null && e.date > todayStr)
    .sort((a, b) => a.date.localeCompare(b.date));
  const nextEarningsDate  = futureEarnings[0]?.date || null;
  const lastEarningsDate  = reportedEarnings[0]?.date || (incQ[0]?.date) || null;

  // ── Forward P/E ───────────────────────────────────────────────────────────────
  const mktCap         = (profile[0] && (profile[0].marketCap ?? profile[0].mktCap)) || null;
  const price          = (profile[0] && profile[0].price) || null;
  const sortedEst      = [...(estimates || [])].sort((a, b) => (a.date || "") > (b.date || "") ? 1 : -1);
  const fwdEst         = sortedEst.find(e => (e.date || "") > todayStr) || sortedEst[sortedEst.length - 1] || null;
  const estEps         = fwdEst ? (fwdEst.epsAvg ?? null) : null;
  const ttmEpsPerShare  = r0?.netIncomePerShare || null;
  let fwdPE = null;
  if (reportedCurrency === "USD") {
    fwdPE = (price && estEps && estEps > 0) ? price / estEps : null;
  } else {
    // Non-USD ADRs (e.g. TSM/TWD): scale TTM P/E by TTM_EPS/fwd_EPS — both from same source,
    // same currency, so no conversion needed.
    fwdPE = (r0?.priceToEarningsRatio && ttmEpsPerShare && estEps && estEps > 0)
      ? r0.priceToEarningsRatio * (ttmEpsPerShare / estEps) : null;
  }
  fwdPE = sanity(fwdPE, "fwdPE");

  // TTM P/E — computed from current price / FMP TTM EPS (netIncomePerShare).
  // Do NOT use r0.priceToEarningsRatio — FMP computes that ratio using the stock price at
  // the filing date, not today's price, so it drifts badly when stocks move between reports.
  const ttmEps   = r0?.netIncomePerShare ?? null;
  const rawTtmPE = (price && ttmEps && ttmEps !== 0) ? price / ttmEps : null;
  const isLossPE = ttmEps != null && ttmEps < 0;
  const ttmPE    = isLossPE ? null : sanity(rawTtmPE, "peRatio");

  // 5-year avg P/E
  const validPEs = (ratios || [])
    .map(r => r.priceToEarningsRatio)
    .filter(pe => sanity(pe, "peRatio") != null)
    .slice(0, 5);
  const pe5yrAvg = validPEs.length >= 2
    ? validPEs.reduce((s, v) => s + v, 0) / validPEs.length : null;

  // P/S — primary from FMP ratios
  const psRatio = sanity(r0?.priceToSalesRatio > 0 ? r0.priceToSalesRatio : null, "psRatio")
    ?? (mktCap && revTTM && reportedCurrency === "USD" ? sanity(mktCap / revTTM, "psRatio") : null);

  // ── Analyst price target upside ───────────────────────────────────────────────
  const pt        = priceTgt[0] || null;
  const ptUpside  = (pt?.targetConsensus && price)
    ? ((pt.targetConsensus - price) / price * 100) : null;

  // ── Insider transactions ───────────────────────────────────────────────────────
  const ITYPE = { P: "P", S: "S", A: "A", F: "F", M: "M" };
  const parsedInsider = (insider || []).map(t => {
    const raw = (t.transactionType || "").charAt(0).toUpperCase();
    return {
      type: ITYPE[raw] || null,
      date: t.transactionDate || t.filingDate || null,
      value_usd: Math.abs((t.securitiesTransacted || 0) * (t.price || 0)),
    };
  }).filter(t => t.type && t.date);

  const ocfTTM = haveCF ? ttm(cf, "operatingCashFlow") : null;
  const fcfTTM = haveCF ? ttm(cf, "freeCashFlow")      : null;

  const result = {
    _v: 12, // bump → all cached entries with older versions are refreshed
    company_name:               (profile[0]?.companyName) || ticker,
    sector_raw:                 (profile[0]?.sector)      || null,
    industry_raw:               (profile[0]?.industry)    || null,
    // Revenue
    revenue_ttm:                revTTM,
    revenue_prior_ttm:          revPriorTTM,
    revenue_growth:             revGrowth,          // primary: FMP quarterly YoY (most current)
    revenue_growth_warned:      revCrossWarn,       // true = FMP quarterly vs TTM calc diverged >50%
    // Margins (all 0–1 fraction; ×100 in display)
    gross_margin_latest_q:      grossMarginLatest,
    gross_margin_prior_year_q:  grossMarginPriorYrQ,
    gross_margin_delta_fmp:     grossMarginDeltaFMP,    // FMP quarterly delta (primary for col_C)
    gross_margin_delta_calc:    grossMarginDeltaCalc,   // derived (secondary)
    operating_margin_latest_q:  opMarginLatest,
    operating_margin_prior_year_q: opMarginPriorYrQ,
    op_margin_delta_fmp:        opMarginDeltaFMP,
    // Debt — from FMP ratios (currency-safe)
    debt_to_equity:             debtToEquityRatio,
    interest_coverage:          interestCoverage,
    net_cash:                   netCash,
    debt_growth_yoy:            debtGrowthYoY,
    operating_cash_flow:        ocfTTM,
    fcf_positive:               fcfTTM === null ? null : fcfTTM > 0,
    // Guidance — real EPS beat/miss from /earnings (was always "unknown")
    guidance_vs_consensus:      guidanceSummary,
    // Valuation
    estimated_eps_next:         estEps,
    forward_pe:                 fwdPE,
    ttm_pe:                     ttmPE,
    is_loss:                    isLossPE,
    pe_5yr_avg:                 pe5yrAvg,
    ps_ratio:                   psRatio,
    market_cap:                 mktCap,
    price,
    // Analyst
    analyst_rating_raw:         grades[0] || null,
    analyst_grades_list:        gradesList.slice(0, 5),
    price_target:               pt,
    price_target_upside:        ptUpside,
    insider_transactions:       parsedInsider,
    // Earnings calendar
    next_earnings_date:         nextEarningsDate,
    last_earnings_date:         lastEarningsDate,
    // Short interest
    short_float_pct: shortInfo[0]?.shortPercent ?? shortInfo[0]?.shortPercentOfFloat ?? null,
    // Beta (from profile — already fetched)
    beta: profile[0]?.beta ?? null,
    // Volume (for relative volume — from profile since it's already fetched)
    volume:     profile[0]?.volume        ?? null,
    avg_volume: profile[0]?.averageVolume ?? null,
  };

  // Name-mismatch guard: if the company name FMP returned doesn't match the name we
  // have on record for this ticker, the CDN served another company's data.
  // Don't cache it (so the next rescan re-fetches when FMP has healed), and clear
  // the financial fields so we don't score with another company's numbers.
  const hasNameFlip = knownName && result.company_name
    ? nameMismatch(knownName, result.company_name)
    : false;

  if (profile.length && incQ.length && !priceDiverged(data) && !hasNameFlip) {
    await putFmpCache(ticker, result).catch(() => {});
  }

  if (hasNameFlip) {
    // Return a bare shell — deliberately do NOT spread `result` here.
    // `result` contains pre-computed financial fields (revenue_growth, gross margins, D/E, etc.)
    // derived from the wrong company's raw data. Spreading them would let the wrong
    // company's numbers flow into scoreLocally even though the raw arrays are cleared.
    // All absent fields → undefined → null-safe guards in scoring treat them as null/BAD.
    //
    // Use result.company_name (FMP's returned name) rather than knownName here.
    // This is critical for self-healing: when the blob is poisoned with APLD data and FMP
    // heals, each ticker gets its own correct name → dedup doesn't fire → bare shells are
    // written → avg_volume=null forces full rescore next rescan → heals in 2 passes.
    // If we used knownName (= "Applied Digital Corp" from poisoned blob), all bare shells
    // would share that name → dedup would fire → no writes → permanent deadlock.
    return {
      _v: 12,
      _flipGuarded:         true,
      company_name:         result.company_name,
      price:                null,
      market_cap:           null,
      beta:                 null,
      volume:               null,
      avg_volume:           null,  // null avg_volume forces full rescore on next rescan
      analyst_grades_list:  [],
      analyst_rating_raw:   null,
      price_target:         null,
      price_target_upside:  null,
      insider_transactions: [],
      profile: [], incQ: [], bs: [], cf: [], incGrowthQ: [], annGrowth: [], ratios: [],
    };
  }

  return result;
}

/* ---------- Layer 2: Haiku call for event columns only ----------
   Contracts (Col D), Departures (Col F), Disruption (Col H) require live web search.
   Haiku returns verdicts + summaries so JS scoring can consume them directly. */
async function gatherLayer2(client, ticker, companyName, runDate) {
  // Spend circuit-breaker: hard daily cap on paid Haiku web-search calls.
  // Once the cap is hit, return safe defaults instead of calling the API so a
  // runaway scan loop can never blow past the daily ceiling. Reflects col_D=BAD
  // (no verified contracts) and departures/disruption=GOOD (no evidence of harm).
  const used = await getHaikuUsage().catch(() => 0);
  if (used >= haikuCap()) {
    const note = "Skipped — daily AI research cap reached";
    return {
      contracts:  { summary: note, verdict: "BAD"  },
      departures: { summary: note, verdict: "GOOD" },
      disruption: { summary: note, verdict: "GOOD" },
    };
  }
  await incrHaikuUsage().catch(() => {});

  const prompt = `Today is ${runDate}. Research ${ticker} (${companyName}).
Return ONLY this JSON object:
{
  "contracts":  {"summary": "<one sentence>", "verdict": "GOOD or BAD"},
  "departures": {"summary": "<one sentence>", "verdict": "GOOD or BAD"},
  "disruption": {"summary": "<one sentence>", "verdict": "GOOD or BAD"}
}
Rules:
- contracts: GOOD = signed contracts/awards this quarter, or backlog grew ≥10%, or government awards. BAD = no new contracts, MOU-only with no revenue, flat/shrinking backlog.
- departures: GOOD = no CEO/CFO/COO/CTO/President exit in last 90 days, or named permanent successor exists. BAD = such an exit without permanent successor, multiple exits, or "effective immediately".
- disruption: GOOD = no NEW material external threat (regulation/ban/competing product/tech shift) in last 6 months. BAD = such a threat emerged ≤6 months ago. Structural long-standing competition is GOOD.
When borderline, default to BAD. JSON only, no prose.`;

  try {
    const res = await createWithRetry(client, {
      model: GATHER_MODEL,
      max_tokens: 350,
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 1 }],
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content.filter(b => b.type === "text").map(b => b.text).join("\n");
    const m = text.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
  } catch { /* fall through to defaults */ }

  // Safe defaults on error: unknown event data → BAD for Col D (contracts always unknown without search).
  return {
    contracts:  { summary: "No data", verdict: "BAD" },
    departures: { summary: "No data", verdict: "GOOD" },
    disruption: { summary: "No data", verdict: "GOOD" },
  };
}

/* ---------- Sector P/E baselines (maps FMP industry/sector strings) ---------- */
const SECTOR_PE_MAP = {
  // Technology
  "Semiconductors": 36,
  "Software-Application": 35,
  "Software-Infrastructure": 35,
  "Internet Content & Information": 22,
  "Consumer Electronics": 20,
  "Electronic Gaming & Multimedia": 20,
  "Communication Equipment": 18,
  "Computer Hardware": 22,
  "Electronic Components": 22,
  "Scientific & Technical Instruments": 22,
  "Information Technology Services": 28,
  // Industrials
  "Electrical Equipment & Parts": 29,
  "Aerospace & Defense": 22,
  "Specialty Industrial Machinery": 20,
  "Agricultural & Farm Machinery": 20,
  "Engineering & Construction": 24,
  "Waste Management": 28,
  "Conglomerates": 20,
  "Staffing & Employment Services": 18,
  // Energy / Utilities
  "Utilities-Regulated Electric": 18,
  "Utilities-Regulated Gas": 18,
  "Utilities-Renewable": 22,
  "Renewable Utilities": 22,        // FMP alternate string for GEV etc.
  "Independent Power Producers": 20,
  "Oil & Gas E&P": 12,
  "Oil & Gas Integrated": 12,
  "Oil & Gas Midstream": 16,
  "Oil & Gas Equipment & Services": 14,
  // Healthcare
  "Drug Manufacturers-General": 16,
  "Drug Manufacturers-Specialty & Generic": 16,
  "Healthcare Plans": 17,
  "Medical Distribution": 17,
  "Medical Devices": 22,
  "Biotechnology": 20,
  "Diagnostics & Research": 24,
  // Chemicals / Materials
  "Specialty Chemicals": 27,
  "Uranium": 65,
  "Gold": 18,
  "Steel": 12,
  "Aluminum": 12,
  // Financials
  "Insurance-Property & Casualty": 14,
  "Insurance-Diversified": 14,
  "Insurance-Life": 13,
  "Credit Services": 26,
  "Asset Management": 18,
  "Banks-Diversified": 12,
  "Banks-Regional": 11,
  "Capital Markets": 16,
  // Consumer
  "Beverages-Non-Alcoholic": 21,
  "Beverages-Brewers": 21,
  "Tobacco": 21,
  "Internet Retail": 25,
  "Specialty Retail": 25,
  "Discount Stores": 25,
  "Luxury Goods": 28,
  "Restaurants": 26,
  "Packaged Foods": 20,
  // Real Estate
  "REIT-Industrial": 22,
  "REIT-Retail": 18,
  "REIT-Residential": 20,
  "REIT-Office": 14,
  "REIT-Diversified": 18,
  // Broad sector fallbacks (FMP sector strings)
  "Technology": 30,
  "Healthcare": 17,
  "Utilities": 18,
  "Industrials": 22,
  "Consumer Cyclical": 25,
  "Consumer Defensive": 21,
  "Financial Services": 14,
  "Communication Services": 22,
  "Basic Materials": 15,
  "Energy": 12,
  "Real Estate": 18,
};

function lookupSectorPE(industry, sector) {
  if (SECTOR_PE_MAP[industry]) return { pe: SECTOR_PE_MAP[industry], label: industry };
  if (SECTOR_PE_MAP[sector])   return { pe: SECTOR_PE_MAP[sector],   label: sector };
  return { pe: null, label: null };
}

/* ---------- Hardcoded JS scoring (triple-layer validated) ---------- */
function scoreLocally(l1a, layer2, runDate) {
  const today = new Date(runDate);
  const daysAgo = d => d ? (today - new Date(d)) / 86400000 : Infinity;

  // 1. Revenue — primary: FMP quarterly YoY growth; fallback: TTM > prior TTM
  const col_B = l1a.revenue_growth != null
    ? (l1a.revenue_growth > 0 ? "GOOD" : "BAD")
    : (l1a.revenue_ttm && l1a.revenue_prior_ttm && l1a.revenue_ttm > l1a.revenue_prior_ttm ? "GOOD" : "BAD");

  // 2. Margin — primary: FMP income-statement-growth quarterly delta; fallback: derived from quarters
  const grossDelta = l1a.gross_margin_delta_fmp ?? l1a.gross_margin_delta_calc;
  const opDelta    = l1a.op_margin_delta_fmp;
  const grossUp = grossDelta != null ? grossDelta > 0
    : (l1a.gross_margin_latest_q != null && l1a.gross_margin_prior_year_q != null
       && l1a.gross_margin_latest_q > l1a.gross_margin_prior_year_q);
  const opUp = opDelta != null ? opDelta > 0
    : (l1a.operating_margin_latest_q != null && l1a.operating_margin_prior_year_q != null
       && l1a.operating_margin_latest_q > l1a.operating_margin_prior_year_q);
  const col_C = (grossUp || opUp) ? "GOOD" : "BAD";

  // 3. Contract — from Layer 2 web search
  const col_D = (layer2.contracts?.verdict || "BAD").toUpperCase() === "GOOD" ? "GOOD" : "BAD";

  // 4. Debt — primary from FMP ratios D/E (currency-safe); also uses annual debt direction
  const netCashPos  = l1a.net_cash != null && l1a.net_cash > 0;
  const coverageBad = l1a.interest_coverage != null && l1a.interest_coverage < 2;
  const debtFell    = l1a.debt_growth_yoy != null && l1a.debt_growth_yoy < 0;
  const de          = l1a.debt_to_equity;
  let col_E = "BAD";
  if (netCashPos)                    col_E = "GOOD";
  else if (coverageBad)              col_E = "BAD";
  else if (debtFell)                 col_E = "GOOD";
  else if (de != null && de < 1.0)   col_E = "GOOD";

  // 5. Departures — from Layer 2 web search
  const col_F = (layer2.departures?.verdict || "GOOD").toUpperCase() === "GOOD" ? "GOOD" : "BAD";

  // 6. Forecast — real EPS beat/miss from /earnings (was always BAD due to hardcoded "unknown")
  const guidance = (l1a.guidance_vs_consensus || "unknown").toLowerCase();
  const col_G = guidance.includes("beat") ? "GOOD" : "BAD";

  // 7. Disruption — from Layer 2 web search
  const col_H = (layer2.disruption?.verdict || "GOOD").toUpperCase() === "GOOD" ? "GOOD" : "BAD";

  // 8. Insider — open-market buys/sales from FMP /insider-trading
  const txns       = l1a.insider_transactions || [];
  const recentBuy  = txns.find(t => t.type === "P" && daysAgo(t.date) <= 30);
  const recentSale = txns.find(t => t.type === "S" && daysAgo(t.date) <= 60);
  const netSelling = txns
    .filter(t => t.type === "S" && daysAgo(t.date) <= 365)
    .reduce((s, t) => s + (t.value_usd || 0), 0);
  const col_I = (recentSale || netSelling > 50_000_000) ? "BAD" : "GOOD";

  const verdicts      = [col_B, col_C, col_D, col_E, col_F, col_G, col_H, col_I];
  const goodCount     = verdicts.filter(v => v === "GOOD").length;
  const hasInsiderBuy = !!recentBuy;
  const scoreStr      = hasInsiderBuy ? `-${goodCount + 1}/8` : `${goodCount}/8`;
  const absScore      = hasInsiderBuy ? goodCount + 1 : goodCount;
  const scoreColor    = absScore >= 7 ? "Green" : absScore >= 5 ? "Yellow" : "Red";

  // ── Tooltip reasons ───────────────────────────────────────────────────────────
  const _fmtM = v => {
    if (v == null) return "N/A";
    const a = Math.abs(v);
    if (a >= 1e12) return `$${(v / 1e12).toFixed(1)}T`;
    if (a >= 1e9)  return `$${(v / 1e9).toFixed(1)}B`;
    if (a >= 1e6)  return `$${(v / 1e6).toFixed(0)}M`;
    return `$${v.toFixed(0)}`;
  };

  const revReason = (() => {
    const parts = [];
    if (l1a.revenue_ttm != null && l1a.revenue_prior_ttm != null) {
      const pct = (l1a.revenue_ttm - l1a.revenue_prior_ttm) / Math.abs(l1a.revenue_prior_ttm) * 100;
      parts.push(`TTM ${_fmtM(l1a.revenue_ttm)} vs prior ${_fmtM(l1a.revenue_prior_ttm)} (${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%)`);
    }
    if (l1a.revenue_growth != null) {
      const pct = (l1a.revenue_growth * 100).toFixed(1);
      parts.push(`Latest Q YoY: ${l1a.revenue_growth >= 0 ? "+" : ""}${pct}%${l1a.revenue_growth_warned ? " ⚠ cross-check" : ""}`);
    }
    return parts.length ? parts.join("; ") : "Revenue data unavailable";
  })();

  const marginReason = (() => {
    const parts = [];
    const gd = l1a.gross_margin_delta_fmp ?? l1a.gross_margin_delta_calc;
    if (l1a.gross_margin_latest_q != null) {
      const m = (l1a.gross_margin_latest_q * 100).toFixed(1);
      if (gd != null) {
        parts.push(`Gross ${m}% (${gd >= 0 ? "+" : ""}${(gd * 100).toFixed(1)}pp YoY)`);
      } else if (l1a.gross_margin_prior_year_q != null) {
        const d = (l1a.gross_margin_latest_q - l1a.gross_margin_prior_year_q) * 100;
        parts.push(`Gross ${m}% (${d >= 0 ? "+" : ""}${d.toFixed(1)}pp YoY)`);
      } else {
        parts.push(`Gross ${m}%`);
      }
    }
    if (l1a.operating_margin_latest_q != null) {
      const om = (l1a.operating_margin_latest_q * 100).toFixed(1);
      const od = l1a.op_margin_delta_fmp;
      if (od != null) {
        parts.push(`Op ${om}% (${od >= 0 ? "+" : ""}${(od * 100).toFixed(1)}pp YoY)`);
      } else if (l1a.operating_margin_prior_year_q != null) {
        const d = (l1a.operating_margin_latest_q - l1a.operating_margin_prior_year_q) * 100;
        parts.push(`Op ${om}% (${d >= 0 ? "+" : ""}${d.toFixed(1)}pp)`);
      }
    }
    return parts.length ? parts.join("; ") : "Margin data unavailable";
  })();

  const debtReason = (() => {
    const parts = [];
    if (l1a.net_cash != null) parts.push(l1a.net_cash > 0 ? `Net cash ${_fmtM(l1a.net_cash)}` : `Net debt ${_fmtM(-l1a.net_cash)}`);
    if (de != null) parts.push(`D/E ${de.toFixed(2)}x`);
    if (l1a.interest_coverage != null) parts.push(`Cov ${l1a.interest_coverage.toFixed(1)}x`);
    if (l1a.debt_growth_yoy != null) parts.push(`Debt ${l1a.debt_growth_yoy >= 0 ? "+" : ""}${(l1a.debt_growth_yoy * 100).toFixed(0)}% YoY`);
    return parts.length ? parts.join("; ") : "Debt data unavailable";
  })();

  const insiderReason = recentBuy
    ? `Open-market buy ${_fmtM(recentBuy.value_usd)} on ${recentBuy.date}`
    : recentSale
      ? `Open-market sale ${_fmtM(recentSale.value_usd)} on ${recentSale.date}`
      : netSelling > 50_000_000
        ? `Net selling ${_fmtM(netSelling)} (12mo)`
        : "No open-market sales in 60d";

  const reasons = [
    revReason,
    marginReason,
    layer2.contracts?.summary  || "No contract data",
    debtReason,
    layer2.departures?.summary || "No departure data",
    l1a.guidance_vs_consensus  || "unknown",
    layer2.disruption?.summary || "No disruption data",
    insiderReason,
  ];

  return { col_B, col_C, col_D, col_E, col_F, col_G, col_H, col_I, scoreStr, scoreColor, reasons };
}

/* ---------- Valuation columns (hardcoded from FMP data, sanity-gated) ---------- */
function buildValuation(l1a) {
  const fwdPE      = l1a.forward_pe;   // already sanity-gated in layer1a
  const ttmPE      = l1a.ttm_pe;       // already sanity-gated, null if loss
  const isLoss     = !!l1a.is_loss;
  const pe5yr      = l1a.pe_5yr_avg;
  const { pe: sectorBase, label: sectorLabel } = lookupSectorPE(l1a.industry_raw, l1a.sector_raw);

  const refPE = fwdPE || ttmPE;

  // Col K: vs sector P/E
  let vsSecVal = "N/M", vsSecColor = "Neutral";
  if (refPE && sectorBase) {
    const pct = (refPE - sectorBase) / sectorBase * 100;
    vsSecVal   = `${pct >= 0 ? "+" : ""}${Math.round(pct)}%`;
    vsSecColor = pct <= 0 ? "Green" : pct < 50 ? "Yellow" : "Red";
  }

  // Col L: forward P/E
  const fwdPEStr = fwdPE ? `${fwdPE.toFixed(1)}x` : (isLoss ? "N/M (loss)" : "N/M");

  // Col M: TTM P/E
  const ttmPEStr = (ttmPE && ttmPE > 0) ? `${ttmPE.toFixed(1)}x` : (isLoss ? "N/M (loss)" : "N/M");

  // Col N: 5-year avg P/E
  const pe5yrStr = pe5yr ? `~${Math.round(pe5yr)}x` : "N/M";

  // Col O: forward vs TTM
  let fwdVsTtm = "—";
  if (fwdPE && ttmPE && ttmPE > 0) {
    fwdVsTtm = fwdPE < ttmPE ? "Bullish" : "Red Flag";
  } else if (isLoss) {
    fwdVsTtm = "Unprofitable";
  }

  // Col S: P/S ratio
  const psStr = l1a.ps_ratio ? `~${l1a.ps_ratio.toFixed(1)}x` : "N/M";

  // Col T: Analyst rating + price target upside from /price-target-consensus
  const ar        = l1a.analyst_rating_raw;
  const buyTotal  = (ar?.strongBuy || 0) + (ar?.buy || 0);
  const sellTotal = (ar?.sell || 0) + (ar?.strongSell || 0);
  let arStr = "N/M";
  if (ar?.consensus) {
    const uptxt = (l1a.price_target_upside != null)
      ? ` · ${l1a.price_target_upside >= 0 ? "+" : ""}${l1a.price_target_upside.toFixed(0)}% PT`
      : "";
    arStr = `${ar.consensus}\n${buyTotal}B · ${ar.hold || 0}H · ${sellTotal}S${uptxt}`;
  }

  return { vsSecVal, vsSecColor, fwdPEStr, ttmPEStr, pe5yrStr, fwdVsTtm, psStr, arStr, sectorLabel, sectorBase };
}

/* ---------- Analysis text (derived from FMP data — no LLM needed) ---------- */
function buildAnalysis(l1a, valuation) {
  // Col P: Trend — primary: FMP quarterly YoY growth; fallback: TTM arithmetic
  let trend = "→ Insufficient data";
  const revGrowthPct = l1a.revenue_growth != null
    ? l1a.revenue_growth * 100
    : (l1a.revenue_ttm && l1a.revenue_prior_ttm
        ? (l1a.revenue_ttm - l1a.revenue_prior_ttm) / Math.abs(l1a.revenue_prior_ttm) * 100
        : null);
  if (revGrowthPct != null) {
    const revSym = revGrowthPct > 5 ? "↑" : revGrowthPct < -5 ? "↓" : "→";
    const revPct = `${revGrowthPct >= 0 ? "+" : ""}${revGrowthPct.toFixed(0)}%`;
    // Margin direction — prefer FMP quarterly delta; fallback: derived from stored margins
    const gd = l1a.gross_margin_delta_fmp ?? l1a.gross_margin_delta_calc;
    const grossDir = gd != null
      ? (gd > 0.001 ? "↑" : gd < -0.001 ? "↓" : "→")
      : (l1a.gross_margin_latest_q != null && l1a.gross_margin_prior_year_q != null
          ? (l1a.gross_margin_latest_q > l1a.gross_margin_prior_year_q ? "↑"
             : l1a.gross_margin_latest_q < l1a.gross_margin_prior_year_q ? "↓" : "→")
          : null);
    trend = grossDir
      ? `${revSym} Rev ${revPct} YoY; ${grossDir} margins`
      : `${revSym} Revenue ${revPct} YoY`;
  }

  // Col Q: Expectations — valuation vs sector + fwd/TTM signal
  let exp = "Fair — insufficient valuation data";
  if (valuation.vsSecVal !== "N/M") {
    const pct  = parseInt(valuation.vsSecVal, 10);
    const rich = pct >= 30 ? "Rich" : pct >= 5 ? "Slight premium" : pct <= -20 ? "Cheap" : "Fair";
    const sig  = valuation.fwdVsTtm === "Bullish" ? "earnings growth expected"
               : valuation.fwdVsTtm === "Red Flag" ? "earnings decline expected" : null;
    exp = sig ? `${rich} vs sector; ${sig}` : `${rich} vs sector P/E`;
  }

  // Col R: Catalysts — real next earnings date from /earnings calendar; fallback: +91d estimate
  let cat = "";
  if (l1a.next_earnings_date) {
    const d  = new Date(l1a.next_earnings_date);
    const mo = d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
    cat = `${mo} — Earnings`;
  } else if (l1a.last_earnings_date) {
    const next = new Date(l1a.last_earnings_date);
    next.setDate(next.getDate() + 91);
    const mo = next.toLocaleDateString("en-US", { month: "short", year: "numeric" });
    cat = `${mo} — Earnings (est.)`;
  }

  return { trend, exp, cat };
}

/* ---------- Map structured outputs to the frontend row shape ---------- */
function toRow(ticker, scoring, valuation, analysis, l1a) {
  const pillFor = c => ({ Green: "g", Yellow: "y", Red: "r", Neutral: "n" }[c] || "n");
  const verdict = v => v === "GOOD" ? 1 : 0;
  return {
    sym:       ticker.toUpperCase(),
    name:      l1a.company_name || ticker,
    v: [
      verdict(scoring.col_B), verdict(scoring.col_C), verdict(scoring.col_D),
      verdict(scoring.col_E), verdict(scoring.col_F), verdict(scoring.col_G),
      verdict(scoring.col_H), verdict(scoring.col_I),
    ],
    score:     scoring.scoreStr,
    vs:        valuation.vsSecVal,
    vsc:       pillFor(valuation.vsSecColor),
    vsSector:  valuation.sectorLabel || null,
    vsSectorPE: valuation.sectorBase || null,
    fwd:       valuation.fwdPEStr,
    ttm:       valuation.ttmPEStr,
    yr5:       valuation.pe5yrStr,
    ft:        valuation.fwdVsTtm,
    ftc:       valuation.fwdVsTtm === "Bullish" ? "g" : valuation.fwdVsTtm === "Red Flag" ? "r" : "x",
    trend:     analysis.trend,
    exp:       analysis.exp,
    cat:       analysis.cat,
    ps:        valuation.psStr,
    ar:        valuation.arStr,
    arGrades:  l1a.analyst_grades_list || [],
    reasons:         scoring.reasons || [],
    flags:           [],
    price:              l1a.price ?? null,
    next_earnings_date: l1a.next_earnings_date ?? null,
    short_float_pct:    l1a.short_float_pct ?? null,
    beta:               l1a.beta ?? null,
    volume:             l1a.volume ?? null,
    avg_volume:         l1a.avg_volume ?? null,
    price_updated_at:   new Date().toISOString(),
    scored_at:          new Date().toISOString(),
    _flipGuarded:       l1a._flipGuarded ?? false,
  };
}

/* ---------- Lightweight price-only fetch (for fresh rows) ---------- */
export async function fetchLivePrice(ticker) {
  const key = process.env.FMP_API_KEY;
  const url = `${FMP}/quote?symbol=${ticker}&apikey=${key}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const data = await r.json();
    const q = Array.isArray(data) ? data[0] : data;
    if (!q || q.price == null) return null;
    return { price: q.price, volume: q.volume ?? null, avgVolume: q.avgVolume ?? null };
  } catch { return null; }
}

/* ---------- Orchestrate one ticker ---------- */
export async function scoreTicker(ticker, { knownName, skipCache } = {}) {
  const client  = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const runDate = new Date().toISOString().slice(0, 10);

  const l1a = await layer1a(ticker, { knownName, skipCache });

  // Layer 2 (Haiku + web search) is expensive — cache for 7 days.
  // skipCache (force rescan) evicts and refetches so the user always gets
  // fresh event data when they explicitly ask for it.
  const stripHtml = s => (s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  let layer2;
  if (!skipCache) {
    layer2 = await getLayer2Cache(ticker).catch(() => null);
  }
  if (!layer2) {
    if (skipCache) await deleteLayer2Cache(ticker).catch(() => {});
    layer2 = await gatherLayer2(client, ticker, l1a.company_name, runDate);
    for (const key of ['contracts', 'departures', 'disruption']) {
      if (layer2[key]?.summary) layer2[key].summary = stripHtml(layer2[key].summary);
    }
    await putLayer2Cache(ticker, layer2).catch(() => {});
  }

  const scoring   = scoreLocally(l1a, layer2, runDate);
  const valuation = buildValuation(l1a);
  const analysis  = buildAnalysis(l1a, valuation);

  return toRow(ticker, scoring, valuation, analysis, l1a);
}
