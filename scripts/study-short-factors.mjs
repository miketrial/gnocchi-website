/* ===== SWING — Sector Relative Strength offline study =====
   Analysis only, not deployed. Calibrates thresholds for a proposed new
   Swing (short-pipeline.mjs) factor against real forward returns, the same
   way Bounce's RS-vs-SPY/hold-floor thresholds were calibrated in
   quickswing-study.mjs / scripts/ab-rev.mjs. Swing has no backtest harness of
   its own, so this is a fresh, minimal one — not the full transition-sampling
   replay Bounce uses (bidirectional, EOD-only verdicts), just point-in-time
   factor values vs forward N-day returns on a long-only basis, matching how
   Swing itself is long-only today.

   RESULTS (n≈4880, 40-ticker sample, 2026-07-07):
     - Sector RS delta: IC +0.066 (10d) / +0.059 (21d), monotonically higher
       forward return in higher quintiles (Q5 avg +4.23% vs Q1 +1.63% at 21d).
       Validated as a MOMENTUM-CONFIRMATION factor (ride strong sectors), NOT
       a rotation-early-warning signal — its 3-12mo weighted window barely
       moved during the actual June-July 2026 semi rotation (AVGO's delta sat
       at +50-86% through the entire drawdown). Shipped as Factor 11 using
       quintile-derived thresholds (0.15 / 0.08 / -0.03).
     - CMF(20) money-flow factor was also tested here and DROPPED: ~zero IC
       (-0.005 / +0.004) across the general universe, and inconsistent even
       within the semis case (led NVDA's decline by ~2wk, lagged AVGO/MU/
       INTC/AMD). Not shipped — see git history on this file for the removed
       CMF code path if revisiting.

   This script still answers two things:
     1. Correlation study — across ~90 tickers, does Sector RS delta at date D
        predict the ticker's forward 10d/21d return? Bucketed by quintile so
        we don't have to guess bucket cutoffs up front.
     2. Rotation sanity check — replayed on the actual semiconductor names
        that triggered this work (AVGO, MU, AMD, NVDA, INTC) against an
        industrials/financials/healthcare comparison set through the
        May-July 2026 rotation, to confirm the factor's actual lead/lag
        behavior rather than assume it.

   Usage: node scripts/study-short-factors.mjs [--limit=N] [--bars=600] [--stride=5]
*/
import { safe, delay } from "../netlify/lib/fmp-client.mjs";
import { cleanHist, strengthFactor } from "../netlify/lib/quickswing-pipeline.mjs";
import { UNIVERSE } from "./universe.mjs";

/* ---------- Sector -> ETF map (mirrors the table going into short-pipeline.mjs) ----------
   Industry-level override for Semiconductors checked first (more precise than
   the broad Technology sector for the case this study exists to validate);
   everything else falls back to its GICS SPDR sector ETF. */
const INDUSTRY_ETF = { "Semiconductors": "SMH" };
const SECTOR_ETF = {
  "Technology": "XLK", "Healthcare": "XLV", "Utilities": "XLU", "Industrials": "XLI",
  "Consumer Cyclical": "XLY", "Consumer Defensive": "XLP", "Financial Services": "XLF",
  "Communication Services": "XLC", "Basic Materials": "XLB", "Energy": "XLE", "Real Estate": "XLRE",
};
function etfFor(sector, industry) {
  return INDUSTRY_ETF[industry] || SECTOR_ETF[sector] || null;
}

function args() {
  const a = { limit: null, bars: 600, stride: 5 };
  for (const s of process.argv.slice(2)) {
    const m = s.match(/^--(\w+)=(.*)$/);
    if (m?.[1] === "limit") a.limit = Number(m[2]);
    if (m?.[1] === "bars") a.bars = Number(m[2]);
    if (m?.[1] === "stride") a.stride = Number(m[2]);
  }
  return a;
}

/* Newest-first hist sliced to only bars on/before `date` — same "as of"
   convention as quickswing-pipeline.mjs's histAsOf. */
function histAsOf(hist, date) {
  const idx = hist.findIndex(d => d.date <= date);
  return idx === -1 ? null : hist.slice(idx);
}

/* ---------- Stats helpers (same shape as quickswing-study.mjs) ---------- */
function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
function winRate(a) { return a.length ? a.filter(x => x > 0).length / a.length : null; }
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; num += a * b; dx += a * a; dy += b * b; }
  const den = Math.sqrt(dx * dy);
  return den > 0 ? num / den : null;
}
function quintileBuckets(xs, ys) {
  const paired = xs.map((x, i) => [x, ys[i]]).sort((a, b) => a[0] - b[0]);
  const n = paired.length;
  const out = [];
  for (let q = 0; q < 5; q++) {
    const lo = Math.floor((q / 5) * n), hi = Math.floor(((q + 1) / 5) * n);
    const slice = paired.slice(lo, hi);
    const xVals = slice.map(p => p[0]), yVals = slice.map(p => p[1]);
    out.push({
      q: q + 1, n: slice.length,
      xMin: xVals.length ? Math.min(...xVals) : null, xMax: xVals.length ? Math.max(...xVals) : null,
      avgRet: mean(yVals), winRate: winRate(yVals),
    });
  }
  return out;
}

/* ---------- Sector RS delta at index i of `hist` (sector ETF trailing return
   minus SPY trailing return, both "as of" hist[i].date) ---------- */
function sectorRsDeltaAt(sectorHist, spyHist, date) {
  const sAsOf = histAsOf(sectorHist, date);
  const spyAsOf = histAsOf(spyHist, date);
  if (!sAsOf || !spyAsOf) return null;
  const sStrength = strengthFactor(sAsOf);
  const spyStrength = strengthFactor(spyAsOf);
  if (sStrength == null || spyStrength == null) return null;
  return sStrength - spyStrength;
}

/* ---------- Main correlation study ---------- */
async function main() {
  if (!process.env.FMP_API_KEY) { console.error("FMP_API_KEY not set — source .env first."); process.exit(1); }
  const a = args();
  let universe = [...new Set(UNIVERSE)];
  if (a.limit) universe = universe.slice(0, a.limit);

  console.log(`Fetching SPY + sector ETF histories (bars=${a.bars})...`);
  const spyHist = cleanHist(await safe("historical-price-eod/full", "SPY", `&limit=${a.bars}`)); await delay(120);
  const sectorHistCache = new Map();
  async function getSectorHist(etf) {
    if (!etf) return null;
    if (!sectorHistCache.has(etf)) {
      const h = cleanHist(await safe("historical-price-eod/full", etf, `&limit=${a.bars}`)); await delay(120);
      sectorHistCache.set(etf, h.length ? h : null);
    }
    return sectorHistCache.get(etf);
  }

  const H10 = { rs: { xs: [], ys: [] } };
  const H21 = { rs: { xs: [], ys: [] } };

  let done = 0;
  for (const sym of universe) {
    try {
      const prof = (await safe("profile", sym))?.[0] || {}; await delay(110);
      const etf = etfFor(prof.sector, prof.industry);
      const sectorHist = await getSectorHist(etf);
      const hist = cleanHist(await safe("historical-price-eod/full", sym, `&limit=${a.bars}`)); await delay(110);
      if (!sectorHist || hist.length < 280) { done++; continue; }

      // Walk backward over the ticker's own history at a stride, skipping the
      // most recent 21 bars (need forward bars to exist) and anything without
      // 260+ trailing bars (strengthFactor's longest leg).
      for (let i = 21; i + 260 < hist.length; i += a.stride) {
        const date = hist[i].date;
        const rsDelta = sectorRsDeltaAt(sectorHist, spyHist, date);
        const entryClose = hist[i].close;
        const fwd10 = hist[i - 10]?.close, fwd21 = hist[i - 21]?.close;
        if (fwd10 != null && entryClose > 0 && rsDelta != null) {
          const ret10 = (fwd10 - entryClose) / entryClose * 100;
          H10.rs.xs.push(rsDelta); H10.rs.ys.push(ret10);
        }
        if (fwd21 != null && entryClose > 0 && rsDelta != null) {
          const ret21 = (fwd21 - entryClose) / entryClose * 100;
          H21.rs.xs.push(rsDelta); H21.rs.ys.push(ret21);
        }
      }
    } catch (e) {
      console.warn(`  ${sym} skipped: ${e?.message || e}`);
    }
    if (++done % 15 === 0) console.log(`  ...${done}/${universe.length}`);
  }

  function report(label, { xs, ys }) {
    console.log(`\n  ${label}: n=${xs.length}  IC (pearson) = ${pearson(xs, ys)?.toFixed(3) ?? "n/a"}`);
    for (const b of quintileBuckets(xs, ys)) {
      console.log(`    Q${b.q} [${b.xMin?.toFixed(3)} .. ${b.xMax?.toFixed(3)}]  n=${String(b.n).padStart(4)}  avgRet=${b.avgRet?.toFixed(2)}%  winRate=${(b.winRate * 100).toFixed(1)}%`);
    }
  }
  console.log("\n=== 10-trading-day forward return ===");
  report("Sector RS delta", H10.rs);
  console.log("\n=== 21-trading-day forward return ===");
  report("Sector RS delta", H21.rs);

  await rotationSanityCheck(a.bars);
}

/* ---------- Rotation sanity check ----------
   Replays Sector RS delta weekly from 2026-05-01 through 2026-07-07 for the
   semiconductor names that triggered this work vs a comparison set from the
   sectors capital rotated INTO, to confirm whether the factor actually LEADS
   the late-June/early-July drawdown rather than just reflecting it. (Result:
   it doesn't lead — AVGO's delta sat at +50-86% the whole way down — but it
   still validated as a general momentum-confirmation signal in the
   correlation study above, which is how it shipped.) */
async function rotationSanityCheck(bars) {
  const SEMIS = ["AVGO", "MU", "AMD", "NVDA", "INTC"];
  const COMPARISON = { CAT: "Industrials", JPM: "Financial Services", UNH: "Healthcare" };
  const CHECK_DATES = ["2026-05-01", "2026-05-15", "2026-06-01", "2026-06-15", "2026-06-22", "2026-06-29", "2026-07-07"];

  console.log("\n\n=== Rotation sanity check (2026-05-01 .. 2026-07-07) ===");
  const spyHist = cleanHist(await safe("historical-price-eod/full", "SPY", `&limit=${bars}`)); await delay(120);
  const smhHist = cleanHist(await safe("historical-price-eod/full", "SMH", `&limit=${bars}`)); await delay(120);
  const sectorHistCache = new Map([["SMH", smhHist]]);
  async function getSectorHist(etf) {
    if (!sectorHistCache.has(etf)) {
      const h = cleanHist(await safe("historical-price-eod/full", etf, `&limit=${bars}`)); await delay(120);
      sectorHistCache.set(etf, h);
    }
    return sectorHistCache.get(etf);
  }

  const rows = [];
  for (const sym of SEMIS) {
    const hist = cleanHist(await safe("historical-price-eod/full", sym, `&limit=${bars}`)); await delay(110);
    for (const date of CHECK_DATES) {
      const hAsOf = histAsOf(hist, date);
      if (!hAsOf) continue;
      const rsDelta = sectorRsDeltaAt(smhHist, spyHist, date);
      rows.push({ sym, sector: "Semiconductors (SMH)", date, close: hAsOf[0].close, rsDelta });
    }
  }
  for (const [sym, sector] of Object.entries(COMPARISON)) {
    const SECTOR_ETF = { Industrials: "XLI", "Financial Services": "XLF", Healthcare: "XLV" };
    const sectorHist = await getSectorHist(SECTOR_ETF[sector]);
    const hist = cleanHist(await safe("historical-price-eod/full", sym, `&limit=${bars}`)); await delay(110);
    for (const date of CHECK_DATES) {
      const hAsOf = histAsOf(hist, date);
      if (!hAsOf) continue;
      const rsDelta = sectorRsDeltaAt(sectorHist, spyHist, date);
      rows.push({ sym, sector, date, close: hAsOf[0].close, rsDelta });
    }
  }

  console.log("sym    sector                  date        close     sectorRSdelta");
  for (const r of rows) {
    console.log(
      `${r.sym.padEnd(6)} ${r.sector.padEnd(23)} ${r.date}  ${String(r.close.toFixed(2)).padStart(8)}   ${r.rsDelta == null ? "n/a".padStart(13) : (r.rsDelta * 100).toFixed(2).padStart(12) + "%"}`
    );
  }
}

main().catch(e => { console.error(e); process.exit(1); });
