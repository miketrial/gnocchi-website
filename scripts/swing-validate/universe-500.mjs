/* ===== #3 — build the broad ~500-name live universe cache (transferability) ====
   company-screener (cap≥$2B, price≥$10, vol≥1M, US NASDAQ/NYSE, no ETF/fund) →
   ~772 names; take the top 500 by market cap. Pull ~1300 EOD bars + profile each;
   reuse the survivor cache's SPY, add any missing sector ETFs. Writes
   universe500-cache.json (same shape as short-study-cache.json so the harness's
   labelUniverse works unchanged).

   Usage: set -a && . ./.env && set +a ; node scripts/swing-validate/universe-500.mjs */
import { safe, delay, FMP } from "../../netlify/lib/fmp-client.mjs";
import { cleanHist } from "../../netlify/lib/quickswing-pipeline.mjs";
import { loadSurvivorCache, etfFor } from "./lib.mjs";
import { writeFileSync, mkdirSync } from "node:fs";

const BARS = 1300, TARGET = 500;

async function screener() {
  const key = process.env.FMP_API_KEY;
  const url = `${FMP}/company-screener?marketCapMoreThan=2000000000&priceMoreThan=10&volumeMoreThan=1000000&isEtf=false&isFund=false&isActivelyTrading=true&exchange=NASDAQ,NYSE&country=US&limit=1000&apikey=${key}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`screener ${r.status}`);
  return r.json();
}

async function main() {
  if (!process.env.FMP_API_KEY) { console.error("FMP_API_KEY not set."); process.exit(1); }
  const survivor = loadSurvivorCache();

  const all = await screener();
  const names = all
    .filter(x => x.symbol && !x.isEtf && !x.isFund && x.marketCap)
    .sort((a, b) => b.marketCap - a.marketCap)
    .slice(0, TARGET);
  console.log(`screener → ${all.length} names · taking top ${names.length} by market cap`);

  const etfHistBySym = { ...survivor.etfHistBySym };
  const histBySym = {}, etfBySym = {}, profileMiss = [];
  let f = 0, kept = 0;
  for (const n of names) {
    const sym = n.symbol;
    try {
      // reuse survivor EOD where we already have it (identical pull)
      let hist = survivor.histBySym[sym];
      if (!hist) { hist = cleanHist(await safe("historical-price-eod/full", sym, `&limit=${BARS}`)); await delay(90); }
      if (!hist || hist.length < 205) continue;
      const etf = etfFor(n.sector, n.industry);
      if (!n.sector) profileMiss.push(sym);
      histBySym[sym] = hist;
      etfBySym[sym] = etf;
      if (etf && !etfHistBySym[etf]) {
        etfHistBySym[etf] = cleanHist(await safe("historical-price-eod/full", etf, `&limit=${BARS}`)); await delay(120);
      }
      kept++;
    } catch (e) { /* skip */ }
    if (++f % 25 === 0) console.log(`  …fetched ${f}/${names.length}  (kept ${kept})`);
  }
  console.log(`kept ${kept} names (≥205 bars) · profiles missing sector: ${profileMiss.length}`);

  const out = {
    builtFrom: "company-screener top-500-by-cap",
    count: kept,
    spyHist: survivor.spyHist,
    vixHist: null,
    etfBySym, etfHistBySym, histBySym,
    meta: names.reduce((m, n) => { m[n.symbol] = { sector: n.sector, industry: n.industry, marketCap: n.marketCap }; return m; }, {}),
  };
  mkdirSync(new URL("../../scratchpad/swing-validate/", import.meta.url), { recursive: true });
  writeFileSync(new URL("../../scratchpad/swing-validate/universe500-cache.json", import.meta.url), JSON.stringify(out));
  console.log(`\nuniverse500 cache → scratchpad/swing-validate/universe500-cache.json  (${kept} names, ETFs: ${Object.keys(etfHistBySym).join(",")})`);
}
main().catch(e => { console.error(e); process.exit(1); });
