/* ===== QUICK SWING — REV removal A/B (offline) =====
   Re-scores the whole history with REV ON (production) vs REV OFF (masked) and
   compares the realized trades under the shipped v11 exit (firstUp + 3-session
   time stop). Answers the only question that matters: does dropping REV actually
   improve the strategy, not just its isolated correlation?
     node scripts/ab-rev.mjs [--limit=N] [--bars=500] */
import { safe, delay } from "../netlify/lib/fmp-client.mjs";
import { cleanHist } from "../netlify/lib/quickswing-pipeline.mjs";
import { labelTicker, aggregateRule } from "../netlify/lib/quickswing-study.mjs";
import { UNIVERSE } from "./universe.mjs";

const RULE = { target: "firstUp", timeStop: 3, useAtrStop: true, useFlip: true, label: "firstUp+3d" };
const WATCH = new Set(["KLAC", "POWL", "LRCX", "AMAT", "ASYS"]);

function args() { const a = { limit: null, bars: 500 }; for (const s of process.argv.slice(2)) { const m = s.match(/^--(\w+)=(.*)$/); if (m?.[1] === "limit") a.limit = Number(m[2]); if (m?.[1] === "bars") a.bars = Number(m[2]); } return a; }
const p = (x, d = 2) => (x == null ? "n/a" : `${x >= 0 ? " " : ""}${x.toFixed(d)}`);

function line(label, base, off) {
  const dW = (off.winRate - base.winRate) * 100, dE = off.expectancy - base.expectancy, dEd = (off.expPerDay ?? 0) - (base.expPerDay ?? 0);
  console.log(`  ${label}`);
  console.log(`    REV on : n=${String(base.n).padStart(5)}  win ${(base.winRate * 100).toFixed(1)}%  exp ${p(base.expectancy)}%  exp/day ${p(base.expPerDay, 3)}`);
  console.log(`    REV off: n=${String(off.n).padStart(5)}  win ${(off.winRate * 100).toFixed(1)}%  exp ${p(off.expectancy)}%  exp/day ${p(off.expPerDay, 3)}`);
  console.log(`    Δ off−on:            win ${dW >= 0 ? "+" : ""}${dW.toFixed(1)}pp   exp ${dE >= 0 ? "+" : ""}${dE.toFixed(3)}%   exp/day ${dEd >= 0 ? "+" : ""}${dEd.toFixed(3)}`);
}

async function main() {
  if (!process.env.FMP_API_KEY) { console.error("FMP_API_KEY not set — source .env first."); process.exit(1); }
  const a = args();
  let universe = [...new Set(UNIVERSE)];
  if (a.limit) universe = universe.slice(0, a.limit);

  const spyHist = cleanHist(await safe("historical-price-eod/full", "SPY", `&limit=${a.bars}`)); await delay(120);
  const vixHist = cleanHist(await safe("historical-price-eod/full", "^VIX", `&limit=${a.bars}`)); await delay(120);

  const on = { uni: [], watch: [] }, off = { uni: [], watch: [] };
  let done = 0;
  for (const sym of universe) {
    try {
      const hist = cleanHist(await safe("historical-price-eod/full", sym, `&limit=${a.bars}`)); await delay(110);
      const earn = await safe("earnings", sym, "&limit=24"); await delay(110);
      const recOn = labelTicker(sym, hist, spyHist, earn, { vixHist });
      const recOff = labelTicker(sym, hist, spyHist, earn, { vixHist, maskFactors: new Set(["REV"]) });
      on.uni.push(...recOn); off.uni.push(...recOff);
      if (WATCH.has(sym)) { on.watch.push(...recOn); off.watch.push(...recOff); }
    } catch { /* skip */ }
    if (++done % 15 === 0) console.log(`  …${done}/${universe.length}`);
  }

  console.log(`\n=== REV removal A/B under ${RULE.label} exit ===`);
  line(`UNIVERSE`, aggregateRule(on.uni, RULE), aggregateRule(off.uni, RULE));
  line(`WATCHLIST`, aggregateRule(on.watch, RULE), aggregateRule(off.watch, RULE));
  console.log(`\n  (Positive Δ = removing REV helped. Fewer entries off-vs-on = REV was pulling`);
  console.log(`   marginal names over the BUY/SELL line that shouldn't have qualified.)`);
}
main().catch(e => { console.error(e); process.exit(1); });
