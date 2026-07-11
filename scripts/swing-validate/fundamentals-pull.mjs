/* ===== #1 — pull DATED fundamentals for the 90 survivors (PIT reconstruction) ==
   For each survivor, pull the dated endpoints that let us reconstruct 4 of the 5
   fundamental factors AS OF a past bar (using acceptedDate/date ≤ D — the moment
   the data became public, so no filing-lag look-ahead):
     - Analyst-Revisions  ← grades-historical (dated rating snapshots)
     - Quality (FCF+ROE)  ← cash-flow / income / balance-sheet (quarterly, acceptedDate)
     - Leverage           ← balance-sheet / income (quarterly, acceptedDate)
     - Catalyst           ← earnings (dated calendar)
   Plus a light CURRENT set (analyst-estimates, profile) for the look-ahead-biased
   snapshot proxy and the Valuation factor (whose forward-EPS vintage isn't dated).
   Writes fundamentals-cache.json. Usage: set -a && . ./.env && set +a ; node scripts/swing-validate/fundamentals-pull.mjs */
import { safe, delay } from "../../netlify/lib/fmp-client.mjs";
import { UNIVERSE } from "../universe.mjs";
import { writeFileSync, mkdirSync } from "node:fs";

async function main() {
  if (!process.env.FMP_API_KEY) { console.error("FMP_API_KEY not set."); process.exit(1); }
  const universe = [...new Set(UNIVERSE)];
  const data = {};
  let f = 0;
  for (const sym of universe) {
    try {
      const grades   = await safe("grades-historical", sym, "&limit=400");                 await delay(70);
      const cf       = await safe("cash-flow-statement", sym, "&period=quarter&limit=24");  await delay(70);
      const bs       = await safe("balance-sheet-statement", sym, "&period=quarter&limit=24"); await delay(70);
      const inc       = await safe("income-statement", sym, "&period=quarter&limit=24");     await delay(70);
      const earnings = await safe("earnings", sym, "&limit=24");                             await delay(70);
      const estimates= await safe("analyst-estimates", sym, "&period=annual&limit=6");       await delay(70);
      const profile  = await safe("profile", sym);                                           await delay(70);
      data[sym] = { grades, cf, bs, inc, earnings, estimates, profile: profile?.[0] || {} };
    } catch (e) { data[sym] = { error: String(e?.message || e) }; }
    if (++f % 10 === 0) console.log(`  …${f}/${universe.length}`);
  }
  mkdirSync(new URL("../../scratchpad/swing-validate/", import.meta.url), { recursive: true });
  writeFileSync(new URL("../../scratchpad/swing-validate/fundamentals-cache.json", import.meta.url), JSON.stringify(data));
  const ok = Object.values(data).filter(d => !d.error).length;
  console.log(`\nfundamentals cache → scratchpad/swing-validate/fundamentals-cache.json  (${ok}/${universe.length} names)`);
  // quick availability audit
  const withGrades = Object.values(data).filter(d => (d.grades || []).length >= 3).length;
  const withCf = Object.values(data).filter(d => (d.cf || []).length >= 4).length;
  console.log(`  dated coverage: grades≥3 ${withGrades}/${universe.length} · cf-quarters≥4 ${withCf}/${universe.length}`);
}
main().catch(e => { console.error(e); process.exit(1); });
