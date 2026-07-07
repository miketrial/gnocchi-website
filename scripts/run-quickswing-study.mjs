/* ===== QUICK SWING — study runner (offline, run locally with `node`) =====
   Fetches ~2y EOD for a broad liquid universe, runs the factor-attribution and
   exit-grid studies (netlify/lib/quickswing-study.mjs), and prints both — once
   for the whole universe, once for a watchlist subset (the overfitting guard).

   Usage:
     node scripts/run-quickswing-study.mjs                 # full universe
     node scripts/run-quickswing-study.mjs --limit=8       # first N tickers (smoke test)
     node scripts/run-quickswing-study.mjs --watchlist=KLAC,POWL,LRCX,AMAT,ASYS
     node scripts/run-quickswing-study.mjs --horizon=3 --bars=500

   Requires FMP_API_KEY in the environment (source .env first). Writes a JSON
   report to scratchpad/quickswing-study-report.json. Ships nothing to the site. */
import { safe, delay } from "../netlify/lib/fmp-client.mjs";
import { cleanHist } from "../netlify/lib/quickswing-pipeline.mjs";
import {
  labelTicker, attributionReport, exitGridReport, FACTOR_KEYS,
} from "../netlify/lib/quickswing-study.mjs";
import { writeFileSync } from "node:fs";

/* ~90 liquid US large/mid-caps across sectors. Static list = deterministic and
   avoids a survivorship-prone "current constituents" fetch — but note it IS
   today's survivors, so read the universe numbers as indicative, and lean on the
   watchlist cross-check for what actually applies to your names. */
const UNIVERSE = [
  // Mega tech / software
  "AAPL","MSFT","GOOGL","AMZN","META","NVDA","TSLA","AVGO","ORCL","CRM","ADBE","NOW","SNOW","PLTR","PANW","CRWD","DDOG","NET","SHOP","UBER","NFLX",
  // Semis
  "AMD","INTC","MU","QCOM","TXN","AMAT","LRCX","KLAC","NXPI","ON","MRVL","ADI","MCHP","ASYS",
  // Financials
  "JPM","BAC","WFC","GS","MS","C","SCHW","AXP","V","MA","BLK","COF",
  // Health
  "UNH","JNJ","LLY","PFE","MRK","ABBV","TMO","ISRG","AMGN","GILD","BMY",
  // Consumer / retail
  "WMT","COST","HD","LOW","NKE","SBUX","MCD","TGT","DIS","BKNG","CMG",
  // Energy / industrials / materials
  "XOM","CVX","COP","SLB","OXY","BA","CAT","DE","GE","HON","UPS","LMT","FCX",
  // Comms / other liquid movers
  "CMCSA","T","VZ","PYPL","COIN","MRNA","SMCI","DELL","MRVL",
];

const MIN_BARS = 200;      // history warmup so the SPY-200DMA regime is defined
const HORIZON_DEFAULT = 3; // forward-return horizon (trading days) for attribution
const LIQ_MIN_DOLLAR_VOL = 20e6; // ~$20M median daily $-volume floor (eligibility)

function parseArgs() {
  const a = { limit: null, horizon: HORIZON_DEFAULT, bars: 500, watchlist: ["KLAC","POWL","LRCX","AMAT","ASYS"] };
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--(\w+)=(.*)$/);
    if (!m) continue;
    if (m[1] === "limit") a.limit = Number(m[2]);
    else if (m[1] === "horizon") a.horizon = Number(m[2]);
    else if (m[1] === "bars") a.bars = Number(m[2]);
    else if (m[1] === "watchlist") a.watchlist = m[2].split(",").map(s => s.trim().toUpperCase()).filter(Boolean);
  }
  return a;
}

function medianDollarVol(hist) {
  const dv = hist.slice(0, 60).map(b => (b.close || 0) * (b.volume || 0)).filter(x => x > 0).sort((a, b) => a - b);
  return dv.length ? dv[Math.floor(dv.length / 2)] : 0;
}

/* Eligibility "checks": enough history, liquid enough, clean prices. Returns a
   reason string when a ticker is dropped (logged, never silently skipped). */
function ineligibleReason(sym, hist, bars) {
  if (!hist || hist.length < MIN_BARS + 5) return `only ${hist?.length ?? 0} bars (<${MIN_BARS + 5})`;
  if (hist.some(b => !(b.close > 0) || !(b.high >= b.low))) return "bad OHLC bar";
  const mdv = medianDollarVol(hist);
  if (mdv < LIQ_MIN_DOLLAR_VOL) return `illiquid ($${(mdv / 1e6).toFixed(1)}M median $-vol < $${LIQ_MIN_DOLLAR_VOL / 1e6}M)`;
  return null;
}

async function fetchTicker(sym, bars) {
  const rawHist = await safe("historical-price-eod/full", sym, `&limit=${bars}`); await delay(120);
  const earnings = await safe("earnings", sym, "&limit=24"); await delay(120);
  return { hist: cleanHist(rawHist), earnings };
}

const pct = (x, d = 2) => (x == null ? "  n/a" : `${x >= 0 ? " " : ""}${x.toFixed(d)}`);
const pctS = (x) => (x == null ? "n/a" : `${(x * 100).toFixed(0)}%`);

function printAttribution(title, report) {
  console.log(`\n── Factor attribution — ${title} (avg fwd return % by points-at-entry bucket) ──`);
  console.log("factor  n      IC     pts0            pts1            pts2            pts3");
  for (const key of FACTOR_KEYS) {
    const r = report[key]; if (!r) continue;
    const b = (k) => { const c = r.buckets[k]; return c && c.n ? `${pct(c.avgRet)} (${c.n},${pctS(c.winRate)})` : "     —      "; };
    console.log(`${key.padEnd(6)} ${String(r.n).padStart(5)}  ${pct(r.ic, 3)}   ${b(0).padEnd(15)} ${b(1).padEnd(15)} ${b(2).padEnd(15)} ${b(3)}`);
  }
  console.log("  IC = points→forward-return correlation. A factor whose pts3 avg return isn't clearly > pts0 isn't earning its weight.");
}

function printExitGrid(title, rows) {
  console.log(`\n── Exit-rule grid — ${title} (ranked by return-per-day-held) ──`);
  console.log("rule            n      exp%    exp/day  win     PF     avgHold");
  for (const r of rows) {
    const pf = r.profitFactor == null ? "n/a" : r.profitFactor === Infinity ? "inf" : r.profitFactor.toFixed(2);
    console.log(`${r.rule.padEnd(14)} ${String(r.n).padStart(5)}  ${pct(r.expectancy)}   ${pct(r.expPerDay, 3)}  ${pctS(r.winRate).padStart(4)}  ${pf.padStart(5)}  ${r.avgHold == null ? "n/a" : r.avgHold.toFixed(1)}d`);
  }
}

async function main() {
  const args = parseArgs();
  if (!process.env.FMP_API_KEY) { console.error("FMP_API_KEY not set — run `set -a && . ./.env && set +a` first."); process.exit(1); }

  let universe = [...new Set(UNIVERSE)];
  if (args.limit) universe = universe.slice(0, args.limit);
  const watchSet = new Set(args.watchlist);
  for (const w of args.watchlist) if (!universe.includes(w)) universe.push(w); // ensure cross-check names are fetched

  console.log(`Fetching ${universe.length} tickers (${args.bars} bars each), horizon=${args.horizon}d …`);

  // SPY + VIX once (shared regime legs).
  const spyHist = cleanHist(await safe("historical-price-eod/full", "SPY", `&limit=${args.bars}`)); await delay(120);
  const vixHist = cleanHist(await safe("historical-price-eod/full", "^VIX", `&limit=${args.bars}`)); await delay(120);
  console.log(`  SPY ${spyHist.length} bars · VIX ${vixHist.length} bars`);

  const allRecords = [], watchRecords = [];
  const dropped = [];
  let done = 0;
  for (const sym of universe) {
    try {
      const { hist, earnings } = await fetchTicker(sym, args.bars);
      const reason = ineligibleReason(sym, hist, args.bars);
      if (reason) { dropped.push(`${sym}: ${reason}`); continue; }
      const recs = labelTicker(sym, hist, spyHist, earnings, { minBars: MIN_BARS, maxHorizon: 10, vixHist });
      allRecords.push(...recs);
      if (watchSet.has(sym)) watchRecords.push(...recs);
    } catch (e) {
      dropped.push(`${sym}: fetch error ${e?.message || e}`);
    }
    if (++done % 15 === 0) console.log(`  …${done}/${universe.length}`);
  }

  console.log(`\nEligible entries: universe=${allRecords.length}  watchlist=${watchRecords.length}`);
  if (dropped.length) console.log(`Dropped (${dropped.length}): ${dropped.join(" · ")}`);

  const uniAttr = attributionReport(allRecords, { horizon: args.horizon });
  const uniGrid = exitGridReport(allRecords);
  printAttribution(`UNIVERSE (${allRecords.length} entries)`, uniAttr);
  printExitGrid(`UNIVERSE (${allRecords.length} entries)`, uniGrid);

  let watchAttr = null, watchGrid = null;
  if (watchRecords.length >= 20) {
    watchAttr = attributionReport(watchRecords, { horizon: args.horizon });
    watchGrid = exitGridReport(watchRecords);
    printAttribution(`WATCHLIST (${watchRecords.length} entries)`, watchAttr);
    printExitGrid(`WATCHLIST (${watchRecords.length} entries)`, watchGrid);
  } else {
    console.log(`\n(Watchlist cross-check skipped — only ${watchRecords.length} entries, need ≥20 for a stable read.)`);
  }

  const out = {
    generatedFor: { horizon: args.horizon, bars: args.bars, universeSize: universe.length },
    counts: { universeEntries: allRecords.length, watchlistEntries: watchRecords.length, dropped: dropped.length },
    dropped,
    universe: { attribution: uniAttr, exitGrid: uniGrid },
    watchlist: watchRecords.length >= 20 ? { attribution: watchAttr, exitGrid: watchGrid } : null,
  };
  writeFileSync(new URL("../scratchpad/quickswing-study-report.json", import.meta.url), JSON.stringify(out, null, 2));
  console.log("\nFull report → scratchpad/quickswing-study-report.json");
}

main().catch(e => { console.error(e); process.exit(1); });
