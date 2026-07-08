/* ===== SWING study runner (offline, run locally with `node`) ===============
   Fetches ~2y EOD for the shared liquid universe, reconstructs the 6 EOD-
   computable swing factors at every bar, and answers two questions the live
   swing backtest needs settled:

     1. LONG-ONLY vs BIDIRECTIONAL — does opening paper shorts on weak
        trend-breakers add expectancy, or just bleed?
     2. Which EXIT rule fits the multi-week swing horizon best?

   Usage:
     set -a && . ./.env && set +a
     node scripts/run-short-study.mjs                    # full universe
     node scripts/run-short-study.mjs --limit=12         # smoke test
     node scripts/run-short-study.mjs --longTh=13 --shortTh=13 --horizon=21

   Writes scratchpad/short-study-report.json. Ships nothing to the site. */
import { safe, delay } from "../netlify/lib/fmp-client.mjs";
import { cleanHist } from "../netlify/lib/quickswing-pipeline.mjs";
import {
  labelShortTicker, strengthSeries, shortExitGridReport, shortAttributionReport,
  mean, winRate, FACTOR_KEYS,
} from "../netlify/lib/short-study.mjs";
import { UNIVERSE } from "./universe.mjs";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

/* Disk cache of the raw FMP fetch (profiles + histories + SPY + ETFs) so the
   study can be re-run with different thresholds/exit rules in ~1s instead of
   re-hitting FMP for 3 minutes. Delete scratchpad/short-study-cache.json (or pass
   --refresh) to force a fresh pull. */
const CACHE_URL = new URL("../scratchpad/short-study-cache.json", import.meta.url);

const MIN_BARS = 200;
const LIQ_MIN_DOLLAR_VOL = 10e6;

/* Sector -> ETF map — identical to short-pipeline.mjs's sectorEtfFor(). */
const INDUSTRY_ETF = { "Semiconductors": "SMH" };
const SECTOR_ETF = {
  "Technology": "XLK", "Healthcare": "XLV", "Utilities": "XLU", "Industrials": "XLI",
  "Consumer Cyclical": "XLY", "Consumer Defensive": "XLP", "Financial Services": "XLF",
  "Communication Services": "XLC", "Basic Materials": "XLB", "Energy": "XLE", "Real Estate": "XLRE",
};
const etfFor = (sector, industry) => INDUSTRY_ETF[industry] || SECTOR_ETF[sector] || null;

function parseArgs() {
  const a = { limit: null, longTh: 12, shortTh: 12, horizon: 21, bars: 500, maxHorizon: 63 };
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--(\w+)=(.*)$/); if (!m) continue;
    if (m[1] in a) a[m[1]] = Number(m[2]);
  }
  return a;
}
function medianDollarVol(hist) {
  const dv = hist.slice(0, 60).map(b => (b.close || 0) * (b.volume || 0)).filter(x => x > 0).sort((a, b) => a - b);
  return dv.length ? dv[Math.floor(dv.length / 2)] : 0;
}
function ineligible(sym, hist) {
  if (!hist || hist.length < MIN_BARS + 5) return `only ${hist?.length ?? 0} bars`;
  if (hist.some(b => !(b.close > 0) || !(b.high >= b.low))) return "bad OHLC bar";
  const mdv = medianDollarVol(hist);
  if (mdv < LIQ_MIN_DOLLAR_VOL) return `illiquid ($${(mdv / 1e6).toFixed(1)}M)`;
  return null;
}

const pct = (x, d = 2) => (x == null ? "  n/a" : `${x >= 0 ? " " : ""}${x.toFixed(d)}`);
const pctS = (x) => (x == null ? "n/a" : `${(x * 100).toFixed(0)}%`);

function printGrid(title, rows) {
  console.log(`\n── Exit-rule grid — ${title} (ranked by per-trade expectancy) ──`);
  console.log("rule            n     exp%    edgeSPY  win    PF     worst   avgHold");
  for (const r of rows) {
    const pf = r.profitFactor == null ? "n/a" : r.profitFactor === Infinity ? "inf" : r.profitFactor.toFixed(2);
    console.log(
      `${r.rule.padEnd(14)} ${String(r.n).padStart(4)}  ${pct(r.expectancy)}  ${pct(r.edge)}  ` +
      `${pctS(r.winRate).padStart(4)}  ${pf.padStart(5)}  ${pct(r.worst)}  ${r.avgHold == null ? "n/a" : r.avgHold.toFixed(0)}d`
    );
  }
}
function printAttribution(title, report) {
  console.log(`\n── Factor attribution — ${title} (avg fwd return % by entry-side points) ──`);
  console.log("factor   n     IC      pts0            pts1            pts2            pts3");
  for (const key of FACTOR_KEYS) {
    const r = report[key]; if (!r) continue;
    const b = k => { const c = r.buckets[k]; return c && c.n ? `${pct(c.avgRet)}(${c.n},${pctS(c.winRate)})` : "     —      "; };
    console.log(`${key.padEnd(7)} ${String(r.n).padStart(5)} ${pct(r.ic, 3)}   ${b(0).padEnd(15)} ${b(1).padEnd(15)} ${b(2).padEnd(15)} ${b(3)}`);
  }
}

async function main() {
  const args = parseArgs();
  if (!process.env.FMP_API_KEY) { console.error("FMP_API_KEY not set — run `set -a && . ./.env && set +a`."); process.exit(1); }

  let universe = [...new Set(UNIVERSE)];
  if (args.limit) universe = universe.slice(0, args.limit);
  console.log(`Swing study · ${universe.length} tickers · ${args.bars} bars · longTh=${args.longTh} shortTh=${args.shortTh} · fwd horizon ${args.horizon}d`);

  // ---- Raw FMP fetch (or disk cache) ----
  const refresh = process.argv.includes("--refresh");
  let raw;
  if (!refresh && existsSync(CACHE_URL)) {
    raw = JSON.parse(readFileSync(CACHE_URL, "utf8"));
    console.log(`  (using cached FMP data — pass --refresh to re-pull)`);
  } else {
    console.log(`  fetching from FMP…`);
    const spyHist = cleanHist(await safe("historical-price-eod/full", "SPY", `&limit=${args.bars}`)); await delay(120);
    const profileOf = {};
    for (const sym of universe) {
      try { const p = await safe("profile", sym); profileOf[sym] = p?.[0] || {}; } catch { profileOf[sym] = {}; }
      await delay(90);
    }
    const etfBySym = {}, etfSet = new Set();
    for (const sym of universe) {
      const etf = etfFor(profileOf[sym].sector, profileOf[sym].industry);
      etfBySym[sym] = etf; if (etf) etfSet.add(etf);
    }
    const etfHistBySym = {};
    for (const etf of etfSet) {
      etfHistBySym[etf] = cleanHist(await safe("historical-price-eod/full", etf, `&limit=${args.bars}`)); await delay(120);
    }
    const histBySym = {};
    let f = 0;
    for (const sym of universe) {
      try { histBySym[sym] = cleanHist(await safe("historical-price-eod/full", sym, `&limit=${args.bars}`)); } catch { histBySym[sym] = []; }
      await delay(110);
      if (++f % 15 === 0) console.log(`  …fetched ${f}/${universe.length}`);
    }
    raw = { spyHist, etfBySym, etfHistBySym, histBySym };
    writeFileSync(CACHE_URL, JSON.stringify(raw));
    console.log(`  cached FMP data → scratchpad/short-study-cache.json`);
  }

  const { spyHist, etfBySym, etfHistBySym, histBySym } = raw;
  const spyStr = strengthSeries(spyHist);
  console.log(`  SPY ${spyHist.length} bars · sector ETFs: ${Object.keys(etfHistBySym).join(", ")}`);
  const etfStr = {};
  for (const [etf, h] of Object.entries(etfHistBySym)) etfStr[etf] = strengthSeries(h);

  // Label every ticker under BOTH modes so long-only and bidirectional draw from
  // the exact same entries (bidirectional just adds the short leg).
  const longOnly = [], bidir = [];
  const dropped = [];
  for (const sym of universe) {
    const hist = histBySym[sym] || [];
    const reason = ineligible(sym, hist);
    if (reason) { dropped.push(`${sym}: ${reason}`); continue; }
    const secStr = etfBySym[sym] ? etfStr[etfBySym[sym]] : [];
    longOnly.push(...labelShortTicker(sym, hist, spyStr, secStr, {
      minBars: MIN_BARS, maxHorizon: args.maxHorizon, longTh: args.longTh, shortTh: args.shortTh, bidirectional: false,
    }));
    bidir.push(...labelShortTicker(sym, hist, spyStr, secStr, {
      minBars: MIN_BARS, maxHorizon: args.maxHorizon, longTh: args.longTh, shortTh: args.shortTh, bidirectional: true,
    }));
  }

  const shortsOnly = bidir.filter(r => r.side === "short");
  console.log(`\nEntries — long-only=${longOnly.length}  bidirectional=${bidir.length}  (of which short=${shortsOnly.length})`);
  if (dropped.length) console.log(`Dropped (${dropped.length}): ${dropped.join(" · ")}`);

  // Raw directional edge before any exit rule — the fastest "do shorts even work"
  // read: forward-H return by side (long return is +, short return already sign-
  // flipped so + = the short made money).
  const fwdBy = (recs) => {
    const rets = recs.map(r => {
      const bar = r.fwd[Math.min(args.horizon, r.fwd.length) - 1];
      if (!bar) return null;
      return (r.side === "short" ? -1 : 1) * ((bar.close - r.entryClose) / r.entryClose) * 100;
    }).filter(x => x != null);
    return { n: rets.length, avg: mean(rets), win: winRate(rets) };
  };
  const lRaw = fwdBy(longOnly), sRaw = fwdBy(shortsOnly);
  console.log(`\nRaw fwd-${args.horizon}d (no exit rule):`);
  console.log(`  LONG   n=${lRaw.n}  avg ${pct(lRaw.avg)}%  win ${pctS(lRaw.win)}`);
  console.log(`  SHORT  n=${sRaw.n}  avg ${pct(sRaw.avg)}%  win ${pctS(sRaw.win)}`);

  const gLong = shortExitGridReport(longOnly, spyHist);
  const gShort = shortsOnly.length >= 20 ? shortExitGridReport(shortsOnly, spyHist) : null;
  const gBidir = shortExitGridReport(bidir, spyHist);
  printGrid(`LONG-ONLY (${longOnly.length})`, gLong);
  if (gShort) printGrid(`SHORT-ONLY (${shortsOnly.length})`, gShort);
  printGrid(`BIDIRECTIONAL (${bidir.length})`, gBidir);

  const attrLong = shortAttributionReport(longOnly, { horizon: args.horizon });
  printAttribution(`LONG entries (${longOnly.length})`, attrLong);

  // Verdict helper: best rule (by expectancy) for each mode.
  const best = rows => rows && rows[0];
  const bl = best(gLong), bb = best(gBidir), bs = best(gShort);
  console.log(`\n── VERDICT ──`);
  console.log(`  LONG-ONLY  best: ${bl?.rule}  exp ${pct(bl?.expectancy)}%  edgeSPY ${pct(bl?.edge)}  PF ${bl?.profitFactor?.toFixed?.(2)}  worst ${pct(bl?.worst)}`);
  if (bs) console.log(`  SHORT-ONLY best: ${bs?.rule}  exp ${pct(bs?.expectancy)}%  edgeSPY ${pct(bs?.edge)}  PF ${bs?.profitFactor?.toFixed?.(2)}  worst ${pct(bs?.worst)}`);
  console.log(`  BIDIR      best: ${bb?.rule}  exp ${pct(bb?.expectancy)}%  edgeSPY ${pct(bb?.edge)}  PF ${bb?.profitFactor?.toFixed?.(2)}  worst ${pct(bb?.worst)}`);
  console.log(`  → Shorts ${sRaw.avg > 0 ? "ADD" : "SUBTRACT"} raw expectancy (short avg ${pct(sRaw.avg)}%). ` +
    `Bidir exp ${pct(bb?.expectancy)}% vs long-only ${pct(bl?.expectancy)}% at best rule.`);

  const out = {
    params: args,
    counts: { longOnly: longOnly.length, bidir: bidir.length, shorts: shortsOnly.length, dropped: dropped.length },
    rawForward: { long: lRaw, short: sRaw },
    grids: { longOnly: gLong, shortOnly: gShort, bidir: gBidir },
    attribution: attrLong,
    dropped,
  };
  writeFileSync(new URL("../scratchpad/short-study-report.json", import.meta.url), JSON.stringify(out, null, 2));
  console.log("\nFull report → scratchpad/short-study-report.json");
}
main().catch(e => { console.error(e); process.exit(1); });
