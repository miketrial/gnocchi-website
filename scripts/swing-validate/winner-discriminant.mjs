/* Big-winner discriminant study — "what separates the >10% fat-tail winners from
   the small wins (and losses), and is it a measurable ENTRY feature we can gate on?"

   For every SHIPPED v6 swing trade (entry = v5 best-of-best gate; exit = 50/200
   death-cross → 40% stop → 189-session backstop) over the deep 2006-2026 cache,
   capture an ENTRY-TIME feature vector (no look-ahead) and the realized v6 outcome,
   then:
     A. base rates — how fat is the right tail (share >10 / >25 / >50 / >100%)
     B. univariate discriminants — per feature, quintile-bucket avg P/L + edge vs
        SPY + P(>10% win), plus the Spearman rank-IC(feature, pnl). Computed on
        IS(<2017) and independently re-checked on OOS(>=2017) — a feature only
        counts if the relationship SURVIVES out-of-sample.
     C. sub-factor points (each 0-3 ladder) vs outcome.
     D. gate simulations — add each promising threshold (and combos) to the buy
        criteria; report the effect on n, avg P/L, EDGE vs SPY, win%, %>10, avg
        winner, worst, cum$, IS vs OOS. The bar to clear: concentrates big wins
        AND holds/raises edge out-of-sample (not just widens variance).
     E. decomposition — how much of "big winner" is just a long hold in a rising
        market (beta/duration) vs a name-selection signal knowable at entry.

   Pure/off-cache; entries byte-identical to the shipped gate. Features are all
   computable at the entry bar from price/volume/SPY/VIX — nothing forward-looking. */

import { readFileSync, writeFileSync } from "node:fs";
import { computeShortSignal, strengthSeriesFor, SBT_HARD_STOP_PCT, SBT_TIME_STOP_DAYS } from "../../netlify/lib/short-backtest.mjs";

const CACHE = new URL("../../scratchpad/swing-validate/deep-cache.json", import.meta.url);
const RUNWAY = 252;
const BIG = 10;   // the user's ">10% win" threshold
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
const r2 = x => (x == null ? null : Math.round(x * 100) / 100);
const pct = (num, den) => (den ? r2(100 * num / den) : null);
const strengthAsOf = (series, date) => { for (const s of series) if (s.date <= date) return s.strength; return null; };
const spyCloseAsOf = (spyHist, date) => { for (const b of spyHist) if (b.date <= date) return b.close ?? b.price; return null; };
function spyRet(spyHist, e, x) { const a = spyCloseAsOf(spyHist, e), b = spyCloseAsOf(spyHist, x); return (a > 0 && b > 0) ? ((b - a) / a) * 100 : null; }
// Spearman rank correlation
function spearman(xs, ys) {
  const n = xs.length; if (n < 5) return null;
  const rank = arr => { const idx = arr.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]); const r = Array(n); let i = 0; while (i < n) { let j = i; while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) r[idx[k][1]] = avg; i = j + 1; } return r; };
  const rx = rank(xs), ry = rank(ys), mx = mean(rx), my = mean(ry);
  let num = 0, dx = 0, dy = 0; for (let i = 0; i < n; i++) { num += (rx[i] - mx) * (ry[i] - my); dx += (rx[i] - mx) ** 2; dy += (ry[i] - my) ** 2; }
  return (dx && dy) ? r2(num / Math.sqrt(dx * dy)) : null;
}

console.error("loading deep cache…");
const c = JSON.parse(readFileSync(CACHE, "utf8"));
const { spyHist, vixHist, etfBySym, etfHistBySym, histBySym } = c;
const spyStr = strengthSeriesFor(spyHist);
const etfStr = {};
for (const [etf, h] of Object.entries(etfHistBySym || {})) etfStr[etf] = strengthSeriesFor(h);

// SPY ascending returns + 200DMA for regime + beta
const spyAsc = [...spyHist].reverse();
const spyRetAsc = Array(spyAsc.length).fill(null);
for (let i = 1; i < spyAsc.length; i++) spyRetAsc[i] = spyAsc[i - 1].close > 0 ? spyAsc[i].close / spyAsc[i - 1].close - 1 : null;
const spyIdxByDate = {}; for (let i = 0; i < spyAsc.length; i++) spyIdxByDate[spyAsc[i].date] = i;
const spy200 = {}; { let s = 0; for (let i = 0; i < spyAsc.length; i++) { s += spyAsc[i].close; if (i >= 200) s -= spyAsc[i - 200].close; if (i >= 199) spy200[spyAsc[i].date] = s / 200; } }
const spyDatesDesc = spyHist.map(b => b.date);
const spy200AsOf = d => { for (const dt of spyDatesDesc) if (dt <= d) { if (spy200[dt] != null) return spy200[dt]; } return null; };
const vixAsOf = d => { for (const b of vixHist) if (b.date <= d) return b.close; return null; };

function ascendingTA(descHist) {
  const bars = [...descHist].reverse();
  const n = bars.length;
  const sma50 = Array(n).fill(null), sma200 = Array(n).fill(null), ret = Array(n).fill(null);
  let s50 = 0, s200 = 0;
  for (let i = 0; i < n; i++) {
    s50 += bars[i].close; if (i >= 50) s50 -= bars[i - 50].close; if (i >= 49) sma50[i] = s50 / 50;
    s200 += bars[i].close; if (i >= 200) s200 -= bars[i - 200].close; if (i >= 199) sma200[i] = s200 / 200;
    if (i >= 1 && bars[i - 1].close > 0) ret[i] = bars[i].close / bars[i - 1].close - 1;
  }
  return { bars, sma50, sma200, ret };
}
// 252-day daily-return beta of the name vs SPY, ending at ascending index ei
function betaAt(ta, ei) {
  const N = 252; if (ei < N + 1) return null;
  const xs = [], ys = [];
  for (let k = ei - N + 1; k <= ei; k++) {
    const d = ta.bars[k].date, si = spyIdxByDate[d];
    if (si == null || ta.ret[k] == null || spyRetAsc[si] == null) continue;
    xs.push(spyRetAsc[si]); ys.push(ta.ret[k]);
  }
  if (xs.length < 100) return null;
  const mx = mean(xs), my = mean(ys); let cov = 0, varx = 0;
  for (let i = 0; i < xs.length; i++) { cov += (xs[i] - mx) * (ys[i] - my); varx += (xs[i] - mx) ** 2; }
  return varx ? cov / varx : null;
}

function v6Exit(ta, ei) {
  const { bars, sma50, sma200 } = ta;
  const entry = bars[ei].close, hardStop = entry * (1 - SBT_HARD_STOP_PCT);
  const end = Math.min(bars.length - 1, ei + RUNWAY);
  for (let k = ei + 1; k <= end; k++) {
    const bar = bars[k], day = k - ei, low = bar.low ?? bar.close, open = bar.open ?? bar.close;
    if (low <= hardStop) { const fill = (open <= hardStop) ? open : hardStop; return { pnl: ((fill - entry) / entry) * 100, exitK: k, reason: "STOP" }; }
    if (sma50[k] != null && sma200[k] != null && sma50[k] < sma200[k]) return { pnl: ((bar.close - entry) / entry) * 100, exitK: k, reason: "CROSS" };
    if (day >= SBT_TIME_STOP_DAYS) return { pnl: ((bar.close - entry) / entry) * 100, exitK: k, reason: "TIME" };
  }
  return { pnl: ((bars[end].close - entry) / entry) * 100, exitK: end, reason: "EOD" };
}

console.error("labeling v6 trades + entry features…");
const T = [];
const names = Object.keys(histBySym);
let done = 0;
for (const sym of names) {
  const hist = histBySym[sym];
  if (!hist || hist.length < 320) { done++; continue; }
  const etf = etfBySym?.[sym] || null;
  const secStr = etf ? (etfStr[etf] || []) : [];
  const lastScorable = hist.length - 200;
  const sigAt = new Array(lastScorable + 1).fill(null);
  for (let i = 0; i <= lastScorable; i++) {
    const sig = computeShortSignal(hist.slice(i, i + 260), { spyStrength: strengthAsOf(spyStr, hist[i].date), sectorStrength: strengthAsOf(secStr, hist[i].date) });
    sigAt[i] = sig && sig.entryStrong ? sig : (sig ? { entryStrong: false } : null);
  }
  const ta = ascendingTA(hist);
  const ascN = ta.bars.length;
  for (let i = 0; i <= lastScorable; i++) {
    const sig = sigAt[i]; if (!sig || !sig.entryStrong) continue;
    if (i + 1 <= lastScorable && sigAt[i + 1]?.entryStrong) continue; // fresh transition only
    const date = hist[i].date, ei = ascN - 1 - i;
    if (ascN - 1 - ei < RUNWAY) continue; // full-runway cohort
    const x = v6Exit(ta, ei);
    const exitDate = ta.bars[x.exitK].date, spy = spyRet(spyHist, date, exitDate);
    if (spy == null) continue;
    const close = ta.bars[ei].close, sma50 = ta.sma50[ei], sma200 = ta.sma200[ei];
    // re-derive the raw sub-factors + continuous features from the signal + bars
    const closes260 = hist.slice(i, i + 260).map(b => b.close);
    const high52 = Math.max(...closes260.slice(0, Math.min(252, closes260.length)));
    T.push({
      sym, date, year: +date.slice(0, 4), oos: +date.slice(0, 4) >= 2017,
      pnl: x.pnl, spy, edge: x.pnl - spy, reason: x.reason, hold: x.exitK - ei,
      // features (entry-time)
      ts: sig.techScore,
      mom63: sig.mom63 != null ? sig.mom63 * 100 : null,                    // 3-mo % return
      dvolB: sig.avgDollarVol / 1e9,                                        // $B/day
      secPts: sig.secPts,
      beta: betaAt(ta, ei),
      atrPct: (sig.atr14 > 0 && close > 0) ? 100 * sig.atr14 / close : null,// daily volatility %
      offHigh: high52 > 0 ? 100 * (high52 - close) / high52 : null,         // % below 52w high
      ext: sma50 > 0 ? 100 * (close - sma50) / sma50 : null,                // % above 50DMA
      spread: sma200 > 0 ? 100 * (sma50 - sma200) / sma200 : null,          // 50/200 spread (trend maturity)
      vix: vixAsOf(date),
      bear: (() => { const sc = spyCloseAsOf(spyHist, date), sm = spy200AsOf(date); return sc != null && sm != null ? sc < sm : null; })(),
    });
  }
  if (++done % 100 === 0) console.error(`  ${done}/${names.length} trades=${T.length}`);
}
console.error(`v6 trades: ${T.length}`);

const IS = T.filter(t => !t.oos), OOS = T.filter(t => t.oos);
const big = t => t.pnl > BIG;

// ---- A. base rates
const grp = (arr) => ({ n: arr.length, avg: r2(mean(arr.map(t => t.pnl))), med: r2(median(arr.map(t => t.pnl))), edge: r2(mean(arr.map(t => t.edge))),
  p10: pct(arr.filter(t => t.pnl > 10).length, arr.length), p25: pct(arr.filter(t => t.pnl > 25).length, arr.length), p50: pct(arr.filter(t => t.pnl > 50).length, arr.length), p100: pct(arr.filter(t => t.pnl > 100).length, arr.length),
  winShareOfPnl: r2(100 * arr.filter(t => t.pnl > 10).reduce((s, t) => s + t.pnl, 0) / (arr.reduce((s, t) => s + Math.max(t.pnl, 0), 0) || 1)) });
console.log(`\n${"=".repeat(100)}\nA. BASE RATES — how concentrated is the right tail? (v6, full-runway cohort)`);
const b = grp(T);
console.log(`n=${b.n}  avgP/L=${b.avg}%  median=${b.med}%  edge=${b.edge}%`);
console.log(`share of trades: >10%=${b.p10}%  >25%=${b.p25}%  >50%=${b.p50}%  >100%=${b.p100}%`);
console.log(`→ the >10% winners capture ${b.winShareOfPnl}% of ALL positive P/L. The median trade makes ${b.med}%.`);

// ---- B. univariate discriminants (quintiles, IS-defined, OOS re-checked)
const FEATURES = [
  ["mom63", "3-mo momentum %"], ["dvolB", "$-vol $B/day"], ["beta", "beta 252d"],
  ["atrPct", "ATR% (daily vol)"], ["offHigh", "% below 52w high"], ["ext", "% above 50DMA"],
  ["spread", "50/200 spread %"], ["vix", "VIX at entry"], ["ts", "techScore"], ["secPts", "sector-RS pts"],
];
function quintileReport(rows, key) {
  const vals = rows.filter(t => t[key] != null).map(t => t[key]).sort((a, b) => a - b);
  if (vals.length < 25) return null;
  const q = i => vals[Math.floor(i / 5 * vals.length)];
  const cuts = [q(1), q(2), q(3), q(4)];
  const bucket = v => (v <= cuts[0] ? 0 : v <= cuts[1] ? 1 : v <= cuts[2] ? 2 : v <= cuts[3] ? 3 : 4);
  const B = [[], [], [], [], []];
  for (const t of rows) if (t[key] != null) B[bucket(t[key])].push(t);
  return { cuts, buckets: B.map(bk => ({ n: bk.length, avg: r2(mean(bk.map(t => t.pnl))), edge: r2(mean(bk.map(t => t.edge))), p10: pct(bk.filter(big).length, bk.length) })) };
}
console.log(`\n${"=".repeat(100)}\nB. UNIVARIATE — feature quintile (Q1 low → Q5 high): avg P/L / edge / %>10win, and rank-IC(feature,pnl)`);
console.log(`   IC>0 = higher feature → bigger P/L. A feature is only actionable if the IC has the SAME sign IS and OOS.`);
for (const [key, label] of FEATURES) {
  const icIS = spearman(IS.filter(t => t[key] != null).map(t => t[key]), IS.filter(t => t[key] != null).map(t => t.pnl));
  const icOOS = spearman(OOS.filter(t => t[key] != null).map(t => t[key]), OOS.filter(t => t[key] != null).map(t => t.pnl));
  const qr = quintileReport(T, key);
  const survives = icIS != null && icOOS != null && Math.sign(icIS) === Math.sign(icOOS) && Math.abs(icOOS) >= 0.05;
  console.log(`\n${label.padEnd(20)} IC_IS=${String(icIS).padStart(6)}  IC_OOS=${String(icOOS).padStart(6)}  ${survives ? "✓ survives OOS" : "✗ not robust"}`);
  if (qr) for (let i = 0; i < 5; i++) { const q = qr.buckets[i]; console.log(`   Q${i + 1} (n=${String(q.n).padStart(4)})  avgP/L ${String((q.avg >= 0 ? "+" : "") + q.avg + "%").padStart(9)}   edge ${String((q.edge >= 0 ? "+" : "") + q.edge + "%").padStart(8)}   >10win ${q.p10}%`); }
}

// ---- C. sub-factor 0-3 ladders
console.log(`\n${"=".repeat(100)}\nC. SUB-FACTOR POINTS vs outcome (secPts already gated ≥2)`);
for (const key of ["secPts"]) {
  for (let p = 0; p <= 3; p++) { const bk = T.filter(t => t[key] === p); if (bk.length) console.log(`  ${key}=${p}  n=${String(bk.length).padStart(4)}  avgP/L ${r2(mean(bk.map(t => t.pnl)))}%  edge ${r2(mean(bk.map(t => t.edge)))}%  >10win ${pct(bk.filter(big).length, bk.length)}%`); }
}

// ---- D. gate simulations
console.log(`\n${"=".repeat(100)}\nD. GATE SIMULATIONS — add each rule to the buy criteria. Bar: concentrate big wins AND hold edge OOS.`);
const GATES = {
  "base (v6, no add)":       () => true,
  "mom63 ≥ +25%":            t => t.mom63 != null && t.mom63 >= 25,
  "mom63 ≥ +40% (conv)":     t => t.mom63 != null && t.mom63 >= 40,
  "beta ≥ 1.3":              t => t.beta != null && t.beta >= 1.3,
  "beta ≥ 1.6":              t => t.beta != null && t.beta >= 1.6,
  "$-vol ≥ $3B/day":         t => t.dvolB >= 3,
  "ext 3-15% (not extended)":t => t.ext != null && t.ext >= 3 && t.ext <= 15,
  "spread ≥ 8% (matured)":   t => t.spread != null && t.spread >= 8,
  "offHigh ≤ 10% (near hi)": t => t.offHigh != null && t.offHigh <= 10,
  "VIX ≤ 22 (calm)":         t => t.vix != null && t.vix <= 22,
  "mom63≥25 & beta≥1.3":     t => t.mom63 != null && t.mom63 >= 25 && t.beta != null && t.beta >= 1.3,
  "mom63≥25 & $3B":          t => t.mom63 != null && t.mom63 >= 25 && t.dvolB >= 3,
  "mom63≥25 & spread≥8":     t => t.mom63 != null && t.mom63 >= 25 && t.spread != null && t.spread >= 8,
};
const simRow = (arr) => {
  if (!arr.length) return "n=0";
  const wins = arr.filter(t => t.pnl > 0), bigs = arr.filter(big);
  const cum = arr.reduce((s, t) => s + 10000 * (t.pnl / 100), 0);
  return `n=${String(arr.length).padStart(4)}  avgP/L ${String(r2(mean(arr.map(t => t.pnl))) + "%").padStart(8)}  edge ${String(r2(mean(arr.map(t => t.edge))) + "%").padStart(8)}  win ${String(pct(wins.length, arr.length) + "%").padStart(6)}  >10 ${String(pct(bigs.length, arr.length) + "%").padStart(6)}  avgWin ${String(r2(mean(wins.map(t => t.pnl))) + "%").padStart(8)}  worst ${String(r2(Math.min(...arr.map(t => t.pnl))) + "%").padStart(8)}  cum$${Math.round(cum).toLocaleString()}`;
};
const outGates = {};
for (const [label, fn] of Object.entries(GATES)) {
  const all = T.filter(fn), is = IS.filter(fn), oos = OOS.filter(fn);
  outGates[label] = { all: all.length, oos: oos.length };
  console.log(`\n${label}`);
  console.log(`   ALL  ${simRow(all)}`);
  console.log(`   IS   ${simRow(is)}`);
  console.log(`   OOS  ${simRow(oos)}`);
}

// ---- E. decomposition: is "big winner" just long hold × rising market?
console.log(`\n${"=".repeat(100)}\nE. DECOMPOSITION — is a big win an ENTRY signal or just a long hold in a rising market?`);
const bigWins = T.filter(t => t.pnl > 25), smallWins = T.filter(t => t.pnl > 0 && t.pnl <= 10);
console.log(`big winners (>25%, n=${bigWins.length}): median hold ${median(bigWins.map(t => t.hold))} sessions, median SPY-over-hold ${r2(median(bigWins.map(t => t.spy)))}%, median edge ${r2(median(bigWins.map(t => t.edge)))}%`);
console.log(`small wins  (0-10%, n=${smallWins.length}): median hold ${median(smallWins.map(t => t.hold))} sessions, median SPY-over-hold ${r2(median(smallWins.map(t => t.spy)))}%`);
console.log(`rank-IC(hold, pnl)         = ${spearman(T.map(t => t.hold), T.map(t => t.pnl))}   ← how much bigger P/L is just from holding longer`);
console.log(`rank-IC(SPY-over-hold, pnl)= ${spearman(T.map(t => t.spy), T.map(t => t.pnl))}   ← how much is just the market rising during the hold`);
console.log(`rank-IC(hold, edge)        = ${spearman(T.map(t => t.hold), T.map(t => t.edge))}   ← does a longer hold add edge ABOVE SPY, or just beta?`);
const exitOfBig = {}; for (const t of bigWins) exitOfBig[t.reason] = (exitOfBig[t.reason] || 0) + 1;
console.log(`exit reason of the big winners: ${Object.entries(exitOfBig).map(([k, v]) => `${k} ${pct(v, bigWins.length)}%`).join("  ")}`);

writeFileSync(new URL("../../scratchpad/swing-validate/winner-discriminant.json", import.meta.url), JSON.stringify({ base: b, gates: outGates, n: T.length }, null, 2));
console.error("\nwrote scratchpad/swing-validate/winner-discriminant.json");
