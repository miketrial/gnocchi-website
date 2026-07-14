/* Big-winner CLASSIFIER — the hard version of "what is measurable and the same
   between all the larger winners?" Instead of univariate quintiles, this treats it
   as a separation problem: can any entry feature (or small combo) SEPARATE the big
   winners from the losers well enough to gate on?

   For every v6 swing trade (v5 gate entry; death-cross/40%/189 exit) over the deep
   2006-2026 cache, capture a RICH entry-time feature vector (incl. features not
   tested before: golden-cross age, 6/12-month momentum, relative strength vs SPY,
   volatility-adjusted momentum, trend cleanliness) and:

     A. AUC per feature = P(feature ranks a random BIG winner above a random LOSER).
        0.5 = no separation; >0.60 = a real edge. Computed IS and OOS separately —
        a feature only counts if it separates in BOTH.
     B. For the best features, precision/recall of a gate at swept thresholds:
        precision = share of the KEPT trades that are big winners (vs 28.9% base),
        recall = share of big winners kept, and — the decider — the EDGE vs SPY and
        worst-case of the kept set, IS/OOS/bear. A gate is only real if it lifts the
        big-winner rate AND holds edge out-of-sample and in-sample (bears included).
     C. The counter-test: does the same gate also concentrate big LOSERS? (a beta
        gate widens both tails — reports the ≤−25% rate of the kept set.)
     D. A greedy 2-feature combo search on the OOS-robust features.

   big winner := pnl > 25%   loser := pnl < 0   (small win 0-25% is neither). */

import { readFileSync, writeFileSync } from "node:fs";
import { computeShortSignal, strengthSeriesFor, SBT_HARD_STOP_PCT, SBT_TIME_STOP_DAYS } from "../../netlify/lib/short-backtest.mjs";

const CACHE = new URL("../../scratchpad/swing-validate/deep-cache.json", import.meta.url);
const RUNWAY = 252, BIGWIN = 25, LOSS = 0;
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
const pctile = (a, q) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const r2 = x => (x == null ? null : Math.round(x * 100) / 100);
const share = (num, den) => (den ? r2(100 * num / den) : null);
const strengthAsOf = (series, date) => { for (const s of series) if (s.date <= date) return s.strength; return null; };
const spyCloseAsOf = (spyHist, date) => { for (const b of spyHist) if (b.date <= date) return b.close ?? b.price; return null; };
function spyRet(spyHist, e, x) { const a = spyCloseAsOf(spyHist, e), b = spyCloseAsOf(spyHist, x); return (a > 0 && b > 0) ? ((b - a) / a) * 100 : null; }
// AUC via Mann-Whitney: P(pos ranks above neg). Ties count 0.5.
function auc(pos, neg) {
  if (!pos.length || !neg.length) return null;
  const all = [...pos.map(v => [v, 1]), ...neg.map(v => [v, 0])].sort((a, b) => a[0] - b[0]);
  let rankSum = 0, i = 0;
  while (i < all.length) { let j = i; while (j + 1 < all.length && all[j + 1][0] === all[i][0]) j++; const avgRank = (i + j) / 2 + 1; for (let k = i; k <= j; k++) if (all[k][1] === 1) rankSum += avgRank; i = j + 1; }
  return r2((rankSum - pos.length * (pos.length + 1) / 2) / (pos.length * neg.length));
}

console.error("loading deep cache…");
const c = JSON.parse(readFileSync(CACHE, "utf8"));
const { spyHist, vixHist, etfBySym, etfHistBySym, histBySym } = c;
const spyStr = strengthSeriesFor(spyHist);
const etfStr = {};
for (const [etf, h] of Object.entries(etfHistBySym || {})) etfStr[etf] = strengthSeriesFor(h);
const spyAsc = [...spyHist].reverse();
const spyRetAsc = Array(spyAsc.length).fill(null);
for (let i = 1; i < spyAsc.length; i++) spyRetAsc[i] = spyAsc[i - 1].close > 0 ? spyAsc[i].close / spyAsc[i - 1].close - 1 : null;
const spyIdxByDate = {}; for (let i = 0; i < spyAsc.length; i++) spyIdxByDate[spyAsc[i].date] = i;
const spyCloseAscByDate = {}; for (const b of spyAsc) spyCloseAscByDate[b.date] = b.close;
const spy200 = {}; { let s = 0; for (let i = 0; i < spyAsc.length; i++) { s += spyAsc[i].close; if (i >= 200) s -= spyAsc[i - 200].close; if (i >= 199) spy200[spyAsc[i].date] = s / 200; } }
const spyDatesDesc = spyHist.map(b => b.date);
const spy200AsOf = d => { for (const dt of spyDatesDesc) if (dt <= d) { if (spy200[dt] != null) return spy200[dt]; } return null; };
const vixAsOf = d => { for (const b of vixHist) if (b.date <= d) return b.close; return null; };

function ascendingTA(descHist) {
  const bars = [...descHist].reverse(); const n = bars.length;
  const sma50 = Array(n).fill(null), sma200 = Array(n).fill(null), ret = Array(n).fill(null), atr14 = Array(n).fill(null);
  let s50 = 0, s200 = 0; const tr = Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    s50 += bars[i].close; if (i >= 50) s50 -= bars[i - 50].close; if (i >= 49) sma50[i] = s50 / 50;
    s200 += bars[i].close; if (i >= 200) s200 -= bars[i - 200].close; if (i >= 199) sma200[i] = s200 / 200;
    if (i >= 1 && bars[i - 1].close > 0) { ret[i] = bars[i].close / bars[i - 1].close - 1; const h = bars[i].high ?? bars[i].close, l = bars[i].low ?? bars[i].close, pc = bars[i - 1].close; tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)); }
  }
  let prev = null; for (let i = 14; i < n; i++) { if (prev == null) { let s = 0; for (let k = i - 13; k <= i; k++) s += tr[k]; prev = s / 14; } else prev = (prev * 13 + tr[i]) / 14; atr14[i] = prev; }
  return { bars, sma50, sma200, ret, atr14 };
}
function betaAt(ta, ei) {
  const N = 252; if (ei < N + 1) return null; const xs = [], ys = [];
  for (let k = ei - N + 1; k <= ei; k++) { const d = ta.bars[k].date, si = spyIdxByDate[d]; if (si == null || ta.ret[k] == null || spyRetAsc[si] == null) continue; xs.push(spyRetAsc[si]); ys.push(ta.ret[k]); }
  if (xs.length < 100) return null; const mx = mean(xs), my = mean(ys); let cov = 0, vx = 0; for (let i = 0; i < xs.length; i++) { cov += (xs[i] - mx) * (ys[i] - my); vx += (xs[i] - mx) ** 2; } return vx ? cov / vx : null;
}
// sessions since the 50DMA most recently crossed ABOVE the 200DMA, as of ei
function goldenCrossAge(ta, ei) {
  if (ta.sma50[ei] == null || ta.sma200[ei] == null || !(ta.sma50[ei] > ta.sma200[ei])) return null;
  let k = ei; while (k > 0 && ta.sma50[k - 1] != null && ta.sma200[k - 1] != null && ta.sma50[k - 1] > ta.sma200[k - 1]) k--;
  return ei - k;
}
function retOver(ta, ei, look) { const j = ei - look; return (j >= 0 && ta.bars[j].close > 0) ? (ta.bars[ei].close / ta.bars[j].close - 1) * 100 : null; }
function v6Exit(ta, ei) {
  const { bars, sma50, sma200 } = ta; const entry = bars[ei].close, hardStop = entry * (1 - SBT_HARD_STOP_PCT), end = Math.min(bars.length - 1, ei + RUNWAY);
  for (let k = ei + 1; k <= end; k++) { const bar = bars[k], day = k - ei, low = bar.low ?? bar.close, open = bar.open ?? bar.close; if (low <= hardStop) { const f = open <= hardStop ? open : hardStop; return { pnl: (f - entry) / entry * 100, exitK: k }; } if (sma50[k] != null && sma200[k] != null && sma50[k] < sma200[k]) return { pnl: (bar.close - entry) / entry * 100, exitK: k }; if (day >= SBT_TIME_STOP_DAYS) return { pnl: (bar.close - entry) / entry * 100, exitK: k }; }
  return { pnl: (bars[end].close - entry) / entry * 100, exitK: end };
}

console.error("labeling v6 trades + rich features…");
const T = []; const names = Object.keys(histBySym); let done = 0;
for (const sym of names) {
  const hist = histBySym[sym]; if (!hist || hist.length < 520) { done++; continue; }
  const etf = etfBySym?.[sym] || null; const secStr = etf ? (etfStr[etf] || []) : [];
  const lastScorable = hist.length - 200; const strong = new Array(lastScorable + 1).fill(null);
  for (let i = 0; i <= lastScorable; i++) { const sig = computeShortSignal(hist.slice(i, i + 260), { spyStrength: strengthAsOf(spyStr, hist[i].date), sectorStrength: strengthAsOf(secStr, hist[i].date) }); strong[i] = sig; }
  const ta = ascendingTA(hist); const ascN = ta.bars.length;
  for (let i = 0; i <= lastScorable; i++) {
    const sig = strong[i]; if (!sig || !sig.entryStrong) continue; if (i + 1 <= lastScorable && strong[i + 1]?.entryStrong) continue;
    const date = hist[i].date, ei = ascN - 1 - i; if (ascN - 1 - ei < RUNWAY) continue;
    const x = v6Exit(ta, ei); const exitDate = ta.bars[x.exitK].date; const spy = spyRet(spyHist, date, exitDate); if (spy == null) continue;
    const close = ta.bars[ei].close, sma50 = ta.sma50[ei], sma200 = ta.sma200[ei], atr = ta.atr14[ei];
    const atrPct = (atr > 0 && close > 0) ? 100 * atr / close : null;
    const mom63 = retOver(ta, ei, 63), mom126 = retOver(ta, ei, 126), mom252 = retOver(ta, ei, 252);
    const spyClose = spyCloseAscByDate[date], spyJ = spyIdxByDate[date];
    const rs126 = (mom126 != null && spyJ != null && spyAsc[spyJ - 126]?.close > 0) ? mom126 - (spyClose / spyAsc[spyJ - 126].close - 1) * 100 : null;
    const closes260 = hist.slice(i, i + 260).map(b => b.close); const high52 = Math.max(...closes260.slice(0, 252));
    let above50 = 0, cnt = 0; for (let k = Math.max(0, ei - 62); k <= ei; k++) { if (ta.sma50[k] != null) { cnt++; if (ta.bars[k].close > ta.sma50[k]) above50++; } }
    T.push({
      sym, date, year: +date.slice(0, 4), oos: +date.slice(0, 4) >= 2017, pnl: x.pnl, spy, edge: x.pnl - spy,
      bear: (() => { const sc = spyCloseAsOf(spyHist, date), sm = spy200AsOf(date); return sc != null && sm != null ? sc < sm : null; })(),
      ts: sig.techScore, secPts: sig.secPts, dvolB: sig.avgDollarVol / 1e9,
      mom63, mom126, mom252, rs126, beta: betaAt(ta, ei), atrPct,
      volAdjMom: (mom63 != null && atrPct > 0) ? mom63 / atrPct : null,
      gcAge: goldenCrossAge(ta, ei),
      offHigh: high52 > 0 ? 100 * (high52 - close) / high52 : null,
      ext: sma50 > 0 ? 100 * (close - sma50) / sma50 : null,
      spread: sma200 > 0 ? 100 * (sma50 - sma200) / sma200 : null,
      cleanTrend: cnt ? 100 * above50 / cnt : null,
      vix: vixAsOf(date),
    });
  }
  if (++done % 100 === 0) console.error(`  ${done}/${names.length} trades=${T.length}`);
}
console.error(`v6 trades: ${T.length}`);

const IS = T.filter(t => !t.oos), OOS = T.filter(t => t.oos);
const baseBig = share(T.filter(t => t.pnl > BIGWIN).length, T.length);
console.log(`\n${"=".repeat(100)}\nBIG-WINNER CLASSIFIER — big:=pnl>${BIGWIN}%  loser:=pnl<${LOSS}%   (v6 cohort n=${T.length}; base >${BIGWIN}% rate=${baseBig}%)`);

// ---- A. AUC per feature (bigwin vs loser), IS and OOS
const FEATURES = ["mom63","mom126","mom252","rs126","volAdjMom","gcAge","beta","dvolB","atrPct","offHigh","ext","spread","cleanTrend","ts","secPts","vix"];
const aucOf = (rows, key) => { const pos = rows.filter(t => t.pnl > BIGWIN && t[key] != null).map(t => t[key]); const neg = rows.filter(t => t.pnl < LOSS && t[key] != null).map(t => t[key]); return auc(pos, neg); };
console.log(`\nA. SEPARATION — AUC(big winner vs loser), higher feature assumed better (0.5 = no separation):`);
console.log(`feature        AUC_all  AUC_IS  AUC_OOS   robust?   big-winner median / loser median`);
const aucRows = FEATURES.map(k => {
  const all = aucOf(T, k), is = aucOf(IS, k), oos = aucOf(OOS, k);
  const bigMed = median(T.filter(t => t.pnl > BIGWIN && t[k] != null).map(t => t[k])), losMed = median(T.filter(t => t.pnl < LOSS && t[k] != null).map(t => t[k]));
  // "robust" = both IS and OOS separate the SAME direction and OOS AUC is meaningfully off 0.5
  const dir = all != null && all >= 0.5 ? 1 : -1;
  const robust = is != null && oos != null && ((dir > 0 && is > 0.52 && oos > 0.55) || (dir < 0 && is < 0.48 && oos < 0.45));
  return { k, all, is, oos, robust, bigMed: r2(bigMed), losMed: r2(losMed) };
}).sort((a, b) => Math.abs((b.all ?? .5) - .5) - Math.abs((a.all ?? .5) - .5));
for (const r of aucRows) console.log(`${r.k.padEnd(13)}  ${String(r.all).padStart(6)}  ${String(r.is).padStart(6)}  ${String(r.oos).padStart(6)}   ${r.robust ? "✓ robust" : "✗       "}   ${String(r.bigMed).padStart(8)} / ${r.losMed}`);

// ---- B. gate precision/recall for the top separators
function gateStats(rows, fn) {
  const kept = rows.filter(fn); if (!kept.length) return null;
  const bigs = kept.filter(t => t.pnl > BIGWIN), losers = kept.filter(t => t.pnl < LOSS);
  return { n: kept.length, keep: share(kept.length, rows.length), bigRate: share(bigs.length, kept.length), lossRate: share(losers.length, kept.length),
    recall: share(bigs.length, rows.filter(t => t.pnl > BIGWIN).length), avg: r2(mean(kept.map(t => t.pnl))), edge: r2(mean(kept.map(t => t.edge))), worst: r2(Math.min(...kept.map(t => t.pnl))) };
}
console.log(`\nB. GATE precision/recall — does requiring the feature raise the big-winner rate AND hold edge? (base big-rate ${baseBig}%)`);
const CANDS = [
  ["mom63 ≥ 40", t => t.mom63 != null && t.mom63 >= 40],
  ["mom126 ≥ 60", t => t.mom126 != null && t.mom126 >= 60],
  ["mom252 ≥ 80", t => t.mom252 != null && t.mom252 >= 80],
  ["rs126 ≥ 30", t => t.rs126 != null && t.rs126 >= 30],
  ["volAdjMom ≥ 15", t => t.volAdjMom != null && t.volAdjMom >= 15],
  ["gcAge ≥ 120", t => t.gcAge != null && t.gcAge >= 120],
  ["spread ≥ 12", t => t.spread != null && t.spread >= 12],
  ["dvolB ≥ 3", t => t.dvolB >= 3],
  ["cleanTrend ≥ 90", t => t.cleanTrend != null && t.cleanTrend >= 90],
];
console.log(`gate               keep%  big%   loss%  recall  avgP/L   edge   worst   |  OOS big%/edge   IS big%/edge`);
for (const [label, fn] of CANDS) {
  const a = gateStats(T, fn), o = gateStats(OOS, fn), is = gateStats(IS, fn);
  if (!a) { console.log(`${label.padEnd(17)} (empty)`); continue; }
  console.log(`${label.padEnd(17)} ${String(a.keep).padStart(5)} ${String(a.bigRate).padStart(5)} ${String(a.lossRate).padStart(6)} ${String(a.recall).padStart(6)} ${String(a.avg + "%").padStart(8)} ${String(a.edge + "%").padStart(7)} ${String(a.worst + "%").padStart(7)}  |  ${o ? o.bigRate + "%/" + o.edge + "%" : "-"}   ${is ? is.bigRate + "%/" + is.edge + "%" : "-"}`);
}

// ---- C. counter-test summary line already embedded (loss% + worst). Explicit callout:
console.log(`\nC. COUNTER-TEST — for the highest-big% gates, the loss% column shows whether the SAME gate also keeps losers`);
console.log(`   (a genuine edge gate raises big% while LOWERING loss%; a beta gate raises both — variance, not skill).`);

// ---- D. greedy 2-feature combos among the OOS-robust separators
const robustKeys = aucRows.filter(r => r.robust).map(r => r.k);
console.log(`\nD. 2-FEATURE COMBOS among OOS-robust separators [${robustKeys.join(", ") || "none"}] — best by OOS edge with n≥120:`);
const thrFor = { mom63: 40, mom126: 60, mom252: 80, rs126: 30, volAdjMom: 15, gcAge: 120, spread: 12, dvolB: 3, cleanTrend: 90, beta: 1.3, ts: 16, ext: 8, offHigh: 12 };
const combos = [];
for (let a = 0; a < robustKeys.length; a++) for (let b = a + 1; b < robustKeys.length; b++) {
  const ka = robustKeys[a], kb = robustKeys[b], ta_ = thrFor[ka], tb_ = thrFor[kb]; if (ta_ == null || tb_ == null) continue;
  const fn = t => t[ka] != null && t[ka] >= ta_ && t[kb] != null && t[kb] >= tb_;
  const oos = gateStats(OOS, fn), is = gateStats(IS, fn);
  if (oos && oos.n >= 120) combos.push({ label: `${ka}≥${ta_} & ${kb}≥${tb_}`, oos, is });
}
combos.sort((a, b) => b.oos.edge - a.oos.edge);
for (const c of combos.slice(0, 8)) console.log(`  ${c.label.padEnd(34)} OOS n=${c.oos.n} big%=${c.oos.bigRate} edge=${c.oos.edge}% loss%=${c.oos.lossRate}  | IS ${c.is ? `n=${c.is.n} big%=${c.is.bigRate} edge=${c.is.edge}%` : "n<1"}`);

writeFileSync(new URL("../../scratchpad/swing-validate/bigwin-classifier.json", import.meta.url), JSON.stringify({ n: T.length, baseBig, auc: aucRows }, null, 2));
console.error("\nwrote scratchpad/swing-validate/bigwin-classifier.json");
