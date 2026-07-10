/* ===== P1 — best-effort point-in-time universe builder (offline study) ========
   Extends the 90-name survivor cache with the REACHABLE delisted pool so the
   survivorship gap can be measured. FMP reality (curl-verified 2026-07-10):
     - delisted-companies?page=0 → 100 rows; page>=1 → 402 (paywalled).
     - historical-price-eod/full works for delisted names (full history to the
       delist date) and is SPLIT-ADJUSTED (NVDA reads ~120 across its 2024 10:1).
     - historical index constituents are 402 → a FULLY clean PIT universe is
       blocked; this is the best effort under the current plan (see report §P1).

   Writes scratchpad/swing-validate/pit-cache.json with the same shape as the
   survivor cache PLUS:
     - membership[sym] = { ipoDate, delistedDate } for the as-of gate
     - vixHist for the regime axis
   Reuses the survivor cache's spyHist + sector-ETF histories unchanged so the
   survivors-only vs survivors+delisted comparison is apples-to-apples.

   Usage:  set -a && . ./.env && set +a ; node scripts/swing-validate/pit-universe.mjs */
import { safe, delay } from "../../netlify/lib/fmp-client.mjs";
import { cleanHist } from "../../netlify/lib/quickswing-pipeline.mjs";
import { loadSurvivorCache, etfFor } from "./lib.mjs";
import { writeFileSync, mkdirSync } from "node:fs";

const US_EXCH = new Set(["NASDAQ", "NYSE", "AMEX", "NASDAQ Global Select", "NASDAQ Capital Market", "New York Stock Exchange"]);
const BARS = 1300; // match survivor depth (~5y)

async function main() {
  if (!process.env.FMP_API_KEY) { console.error("FMP_API_KEY not set — `set -a && . ./.env && set +a`."); process.exit(1); }
  const survivor = loadSurvivorCache();
  const survivorSyms = new Set(Object.keys(survivor.histBySym));

  // 1. Reachable delisted pool (page 0 only — page>=1 is 402).
  const delisted = await safe("delisted-companies", "", "&page=0").catch(() => []);
  // note: safe() puts symbol on the querystring; delisted-companies ignores it and returns the page.
  const raw = Array.isArray(delisted) ? delisted : [];
  const pool = raw.filter(d => d.symbol && d.delistedDate && US_EXCH.has(d.exchange) && !survivorSyms.has(d.symbol));
  console.log(`delisted page0: ${raw.length} rows · US-exchange w/ delistedDate & not a survivor: ${pool.length}`);

  // 2. VIX for the regime axis.
  const vixHist = cleanHist(await safe("historical-price-eod/full", "^VIX", `&limit=${BARS}`)); await delay(150);
  console.log(`^VIX bars: ${vixHist.length}`);

  // 3. Pull each delisted name's EOD + profile (for its sector ETF).
  const histBySym = {}, etfBySym = {}, membership = {}, profileMiss = [];
  const etfHistBySym = { ...survivor.etfHistBySym }; // start from survivors' ETFs
  let f = 0, kept = 0;
  for (const d of pool) {
    const sym = d.symbol;
    try {
      const hist = cleanHist(await safe("historical-price-eod/full", sym, `&limit=${BARS}`)); await delay(110);
      if (!hist || hist.length < 205) { continue; } // too short to score
      const profile = await safe("profile", sym); await delay(90);
      const p0 = profile?.[0] || {};
      const etf = etfFor(p0.sector, p0.industry);
      if (!p0.sector) profileMiss.push(sym);
      histBySym[sym] = hist;
      etfBySym[sym] = etf;
      membership[sym] = { ipoDate: d.ipoDate || p0.ipoDate || null, delistedDate: d.delistedDate };
      if (etf && !etfHistBySym[etf]) {
        etfHistBySym[etf] = cleanHist(await safe("historical-price-eod/full", etf, `&limit=${BARS}`)); await delay(120);
      }
      kept++;
    } catch (e) { /* skip */ }
    if (++f % 10 === 0) console.log(`  …fetched ${f}/${pool.length}  (kept ${kept})`);
  }
  console.log(`delisted kept (>=205 bars): ${kept} · profiles missing sector: ${profileMiss.length} [${profileMiss.join(",")}]`);

  // 4. Combined PIT cache = survivors + delisted (survivor SPY/ETF unchanged).
  const pit = {
    builtFrom: "survivor-cache + delisted page0",
    survivorCount: survivorSyms.size,
    delistedCount: kept,
    spyHist: survivor.spyHist,
    vixHist,
    etfBySym: { ...survivor.etfBySym, ...etfBySym },
    etfHistBySym,
    histBySym: { ...survivor.histBySym, ...histBySym },
    membership,          // only delisted names carry membership; survivors default to "always in"
    delistedSyms: Object.keys(histBySym),
  };
  mkdirSync(new URL("../../scratchpad/swing-validate/", import.meta.url), { recursive: true });
  const out = new URL("../../scratchpad/swing-validate/pit-cache.json", import.meta.url);
  writeFileSync(out, JSON.stringify(pit));
  console.log(`\nPIT cache → scratchpad/swing-validate/pit-cache.json`);
  console.log(`  survivors ${survivorSyms.size} + delisted ${kept} = ${Object.keys(pit.histBySym).length} names · VIX ${vixHist.length} bars`);
  console.log(`  delisted names: ${pit.delistedSyms.join(", ")}`);
}
main().catch(e => { console.error(e); process.exit(1); });
