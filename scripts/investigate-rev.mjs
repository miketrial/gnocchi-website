/* ===== QUICK SWING — REV (reversal-candle) factor investigation (offline) =====
   The attribution study flagged REV as the one factor whose higher points-at-entry
   associate with WORSE forward returns, in both the universe and the watchlist.
   This script tests WHY, rigorously, before we touch any weights.

   REV's raw value is posInRange = where the close sits in the day's high–low range
   (1.0 = closed at the highs, 0.0 = at the lows). It awards BUY points for a HIGH
   posInRange (closed strong after a down day) and SELL points for a LOW one.

   Hypothesis: for a NEXT-DAY mean-reversion tool this is backwards — a strong
   close means the bounce already happened intraday, so there's less left for
   tomorrow; a weak close (near the lows) is the better next-day bounce setup. If
   so, posInRange should be NEGATIVELY correlated with the next-day return, which
   makes REV's BUY points (which rise with posInRange) a drag on longs.

   Tests: (1) unconditional corr(posInRange → fwd return) across ALL bars,
   (2) forward return by REV points bucket within actual entries, (3) collinearity
   with RSI(2)/%B, (4) favorable vs unfavorable regime. Run locally with FMP_API_KEY.
     node scripts/investigate-rev.mjs [--limit=N] [--bars=500] */
import { safe, delay } from "../netlify/lib/fmp-client.mjs";
import { cleanHist, histAsOf, historicalScoreDetail } from "../netlify/lib/quickswing-pipeline.mjs";
import { pearson, mean, winRate } from "../netlify/lib/quickswing-study.mjs";
import { UNIVERSE } from "./universe.mjs";

const MIN_BARS = 200;

function args() {
  const a = { limit: null, bars: 500 };
  for (const s of process.argv.slice(2)) {
    const m = s.match(/^--(\w+)=(.*)$/); if (!m) continue;
    if (m[1] === "limit") a.limit = Number(m[2]);
    if (m[1] === "bars") a.bars = Number(m[2]);
  }
  return a;
}
// Correlation over only the pairs where both values are finite numbers.
function corrFinite(xs, ys) {
  const X = [], Y = [];
  for (let i = 0; i < xs.length; i++) {
    if (Number.isFinite(xs[i]) && Number.isFinite(ys[i])) { X.push(xs[i]); Y.push(ys[i]); }
  }
  const r = pearson(X, Y);
  return r == null ? "n/a" : r.toFixed(4);
}
const val = (d, k) => d?.factors?.find(f => f.key === k)?.value ?? null;
const pts = (d, k, side) => { const f = d?.factors?.find(ff => ff.key === k); return f ? (side === "sell" ? f.sell : f.buy) : null; };

async function main() {
  if (!process.env.FMP_API_KEY) { console.error("FMP_API_KEY not set — source .env first."); process.exit(1); }
  const a = args();
  let universe = [...new Set(UNIVERSE)];
  if (a.limit) universe = universe.slice(0, a.limit);

  const spyHist = cleanHist(await safe("historical-price-eod/full", "SPY", `&limit=${a.bars}`)); await delay(120);
  const vixHist = cleanHist(await safe("historical-price-eod/full", "^VIX", `&limit=${a.bars}`)); await delay(120);

  // All-bar records (unconditional test) and entry records (conditional test).
  const bars = [];       // { posInRange, rsi, pctB, next1, next3, regimeFav }
  const buyEntries = []; // { revBuyPts, next3 }
  const sellEntries = [];// { revSellPts, next3short }

  let done = 0;
  for (const sym of universe) {
    try {
      const hist = cleanHist(await safe("historical-price-eod/full", sym, `&limit=${a.bars}`)); await delay(110);
      const earn = await safe("earnings", sym, "&limit=24"); await delay(110);
      if (hist.length < MIN_BARS + 5) continue;
      const len = hist.length;
      // detail cache per index
      const detail = new Array(len).fill(null);
      for (let i = len - 1; i >= 0; i--) {
        const h = hist.slice(i);
        if (h.length < MIN_BARS) continue;
        const spyAsOf = histAsOf(spyHist, hist[i].date);
        if (spyAsOf.length < MIN_BARS) continue;
        detail[i] = historicalScoreDetail(h, spyAsOf, earn, hist[i].date, undefined, vixHist);
      }
      for (let i = 3; i < len; i++) {
        const d = detail[i]; if (!d) continue;
        const c0 = hist[i].close;
        const next1 = ((hist[i - 1].close - c0) / c0) * 100;
        const next3 = ((hist[i - 3].close - c0) / c0) * 100;
        const posInRange = val(d, "REV");
        if (posInRange != null) bars.push({ posInRange, rsi: val(d, "RSI"), pctB: val(d, "%B"), next1, next3, regimeFav: d.regimeFavorable });
        if (d.verdict === "BUY") buyEntries.push({ revBuyPts: pts(d, "REV", "buy"), next3 });
        else if (d.verdict === "SELL") sellEntries.push({ revSellPts: pts(d, "REV", "sell"), next3short: -next3 });
      }
    } catch (e) { /* skip */ }
    if (++done % 15 === 0) console.log(`  …${done}/${universe.length}`);
  }

  const col = bars.map(b => b.posInRange);
  console.log(`\n=== REV investigation — ${bars.length} bars, ${buyEntries.length} BUY / ${sellEntries.length} SELL entries ===`);

  console.log(`\n(1) UNCONDITIONAL — does closing strong (high posInRange) predict the NEXT day?`);
  console.log(`    corr(posInRange, next-1d return) = ${pearson(col, bars.map(b => b.next1))?.toFixed(4)}`);
  console.log(`    corr(posInRange, next-3d return) = ${pearson(col, bars.map(b => b.next3))?.toFixed(4)}`);
  console.log(`    (hypothesis predicts NEGATIVE: strong close → weaker next day)`);
  // next-day return by posInRange decile-ish buckets
  const bucketBy = (lo, hi) => bars.filter(b => b.posInRange >= lo && b.posInRange < hi).map(b => b.next1);
  for (const [lo, hi, label] of [[0, 0.2, "closed near LOWS  (0.0–0.2)"], [0.2, 0.4, "0.2–0.4"], [0.4, 0.6, "0.4–0.6"], [0.6, 0.8, "0.6–0.8"], [0.8, 1.01, "closed near HIGHS (0.8–1.0)"]]) {
    const g = bucketBy(lo, hi);
    console.log(`      ${label.padEnd(28)} n=${String(g.length).padStart(6)}  avg next-1d = ${mean(g)?.toFixed(3)}%  win ${(winRate(g) * 100).toFixed(0)}%`);
  }

  console.log(`\n(2) WITHIN ENTRIES — forward 3d return by REV points at entry`);
  for (const [side, arr, key, ret] of [["BUY (long)", buyEntries, "revBuyPts", "next3"], ["SELL (short)", sellEntries, "revSellPts", "next3short"]]) {
    console.log(`    ${side}:`);
    for (let p = 0; p <= 3; p++) {
      const g = arr.filter(e => Math.round(e[key]) === p).map(e => e[ret]);
      if (g.length) console.log(`      REV pts ${p}: n=${String(g.length).padStart(5)}  avg = ${mean(g)?.toFixed(3)}%  win ${(winRate(g) * 100).toFixed(0)}%`);
    }
  }

  console.log(`\n(3) COLLINEARITY — is REV just re-saying RSI/%B?`);
  console.log(`    corr(posInRange, RSI2) = ${corrFinite(col, bars.map(b => b.rsi))}   corr(posInRange, %B) = ${corrFinite(col, bars.map(b => b.pctB))}`);

  console.log(`\n(4) BY REGIME — corr(posInRange, next-1d)`);
  for (const [label, fav] of [["favorable", true], ["unfavorable", false]]) {
    const sub = bars.filter(b => b.regimeFav === fav);
    console.log(`    ${label.padEnd(12)} n=${String(sub.length).padStart(6)}  corr = ${corrFinite(sub.map(b => b.posInRange), sub.map(b => b.next1))}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
