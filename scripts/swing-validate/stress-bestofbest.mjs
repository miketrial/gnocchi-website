/* Adversarial stress test of the techScore>=15 "best of the best" rule.
   Try to BREAK it before trusting it. All off the 488-name cache, 6mo hold.
   Attack 1 — regime: split entries by SPY vs its 200DMA at entry (bull/bear) and
     by VIX tercile. A beta bet should DIE when entered in a downtrend.
   Attack 2 — name-vs-timing control: for each name that ever hits techScore>=15,
     compare that name's score>=15-entry edge to its "buy ANY bar" average edge. If
     equal, the rule is pure name-ownership (survivorship-exposed), not timing skill.
   Attack 3 — matched random basket: bootstrap N random baskets of the same size
     from baseline; where does techScore>=15's edge fall in that distribution? */
import { readFileSync } from "node:fs";
import { computeShortSignal, strengthSeriesFor } from "../../netlify/lib/short-backtest.mjs";

const CACHE = new URL("../../scratchpad/swing-validate/universe500-cache.json", import.meta.url);
const HARD_STOP_PCT = 0.40, FULL_RUNWAY = 252, H = 126, MINRUN = 126;
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const r2 = x => (x == null ? null : Math.round(x * 100) / 100);
const strengthAsOf = (s, d) => { for (const x of s) if (x.date <= d) return x.strength; return null; };
const spyAsOf = (h, d) => { for (const b of h) if (b.date <= d) return b.close ?? b.price; return null; };
const spyRet = (h, e, x) => { const a = spyAsOf(h, e), b = spyAsOf(h, x); return (a > 0 && b > 0) ? ((b - a) / a) * 100 : null; };
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296;};}

console.error("loading…");
const c = JSON.parse(readFileSync(CACHE, "utf8"));
const { spyHist, vixHist, etfBySym, etfHistBySym, histBySym } = c;
const spyStr = strengthSeriesFor(spyHist);
const etfStr = {}; for (const [e, h] of Object.entries(etfHistBySym || {})) etfStr[e] = strengthSeriesFor(h);
// SPY 200DMA as-of (oldest-first pass)
const spyAsc = [...spyHist].reverse(); const sma200 = {};
for (let i = 199; i < spyAsc.length; i++) { let s = 0; for (let k = i - 199; k <= i; k++) s += spyAsc[k].close; sma200[spyAsc[i].date] = s / 200; }
const spyClose = {}; for (const b of spyHist) spyClose[b.date] = b.close;
const spyDates = spyHist.map(b => b.date);
const asOf = (map, d) => { for (const dd of spyDates) if (dd <= d) return map[dd]; return null; };
const vixAt = {}; if (vixHist) for (const b of vixHist) vixAt[b.date] = b.close ?? b.price;
const vixDates = vixHist ? vixHist.map(b => b.date) : [];
const vixAsOf = d => { for (const dd of vixDates) if (dd <= d) return vixAt[dd]; return null; };

function simFwd(hist, i) {
  const entry = hist[i].close, stop = entry * (1 - HARD_STOP_PCT);
  let day = 0;
  for (let j = i - 1; j >= 0 && (i - j) <= FULL_RUNWAY; j--) {
    const bar = hist[j]; day++; const low = (bar.low ?? bar.close) > 0 ? (bar.low ?? bar.close) : bar.close;
    if (low <= stop) { const fill = ((bar.open ?? bar.close) > 0 && (bar.open ?? bar.close) <= stop) ? (bar.open ?? bar.close) : stop; return { pnl: ((fill - entry) / entry) * 100, exitDate: bar.date }; }
    if (day >= H) return { pnl: ((bar.close - entry) / entry) * 100, exitDate: bar.date };
  }
  const l = hist[Math.max(0, i - FULL_RUNWAY)]; return { pnl: ((l.close - entry) / entry) * 100, exitDate: l.date };
}

// Build per-name: entries (fresh strong transitions) + ALL scoreable bars (for control A).
const entries = [];                 // {sym, date, techScore, edge, pnl, regime, vixT}
const perNameAny = {};              // sym -> [edge over all bars]
const perNameS15 = {};              // sym -> [edge over techScore>=15 entry bars]
let done = 0;
for (const sym of Object.keys(histBySym)) {
  const hist = histBySym[sym] || []; if (hist.length < 205) { done++; continue; }
  const secStr = etfBySym?.[sym] ? (etfStr[etfBySym[sym]] || []) : [];
  const len = hist.length, last = len - 200;
  const strong = new Array(len).fill(false), sc = new Array(len).fill(0);
  for (let i = 0; i <= last; i++) { const sig = computeShortSignal(hist.slice(i), { spyStrength: strengthAsOf(spyStr, hist[i].date), sectorStrength: strengthAsOf(secStr, hist[i].date) }); sc[i] = sig ? sig.techScore : 0; strong[i] = !!(sig && sig.entryStrong); }
  const anyEdges = [];
  for (let i = FULL_RUNWAY; i <= last; i++) {   // require full runway for a fair anytime baseline
    const r = simFwd(hist, i); const s = spyRet(spyHist, hist[i].date, r.exitDate); if (s == null) continue;
    anyEdges.push(r.pnl - s);
  }
  if (anyEdges.length) perNameAny[sym] = anyEdges;
  for (let i = 0; i <= last; i++) {
    if (!strong[i] || (i + 1 <= last && strong[i + 1]) || !(hist[i].close > 0)) continue;
    if ((len - 1 - i) < 0) {}
    const runway = i; if (runway < MINRUN) continue;
    const r = simFwd(hist, i); const s = spyRet(spyHist, hist[i].date, r.exitDate); if (s == null) continue;
    const edge = r.pnl - s;
    const d = hist[i].date; const px = asOf(spyClose, d), sm = asOf(sma200, d);
    const regime = (px != null && sm != null) ? (px >= sm ? "bull" : "bear") : "na";
    entries.push({ sym, date: d, techScore: sc[i], edge, pnl: r.pnl, regime, vix: vixAsOf(d) });
    if (sc[i] >= 15) (perNameS15[sym] ||= []).push(edge);
  }
  if (++done % 100 === 0) console.error(`  ${done} names`);
}
console.error(`entries: ${entries.length}`);

const grp = (arr) => ({ n: arr.length, edge: r2(mean(arr.map(x => x.edge))), pnl: r2(mean(arr.map(x => x.pnl))), winVsSpy: r2(100 * arr.filter(x => x.edge > 0).length / arr.length), worst: r2(Math.min(...arr.map(x => x.pnl))) });
const base = entries, s15 = entries.filter(e => e.techScore >= 15);

console.log("\n===== ATTACK 1a — regime by SPY vs 200DMA at entry =====");
console.log("set\tregime\tn\tavgPnl\tedge\t%beatSPY\tworst");
for (const [nm, set] of [["baseline", base], ["techScore>=15", s15]]) for (const reg of ["bull", "bear"]) {
  const g = set.filter(e => e.regime === reg); if (!g.length) { console.log([nm, reg, 0].join("\t")); continue; }
  const s = grp(g); console.log([nm, reg, s.n, s.pnl, s.edge, s.winVsSpy, s.worst].join("\t"));
}

console.log("\n===== ATTACK 1b — VIX tercile at entry =====");
const vixVals = entries.map(e => e.vix).filter(v => v != null).sort((a, b) => a - b);
if (vixVals.length) {
  const t1 = vixVals[Math.floor(vixVals.length / 3)], t2 = vixVals[Math.floor(2 * vixVals.length / 3)];
  console.log(`VIX terciles: calm<=${r2(t1)}  normal<=${r2(t2)}  stress>`);
  console.log("set\tvixBucket\tn\tavgPnl\tedge\tworst");
  for (const [nm, set] of [["baseline", base], ["techScore>=15", s15]]) for (const [bk, test] of [["calm", v => v <= t1], ["normal", v => v > t1 && v <= t2], ["stress", v => v > t2]]) {
    const g = set.filter(e => e.vix != null && test(e.vix)); if (!g.length) { console.log([nm, bk, 0].join("\t")); continue; }
    const s = grp(g); console.log([nm, bk, s.n, s.pnl, s.edge, s.worst].join("\t"));
  }
} else console.log("(no VIX in cache)");

console.log("\n===== ATTACK 2 — name-ownership vs timing (Control A) =====");
const diffs = [];
for (const sym of Object.keys(perNameS15)) {
  if (!perNameAny[sym] || !perNameAny[sym].length) continue;
  const anytime = mean(perNameAny[sym]), s15e = mean(perNameS15[sym]);
  diffs.push({ sym, anytime, s15e, diff: s15e - anytime, nAny: perNameAny[sym].length, nS15: perNameS15[sym].length });
}
const anyMean = mean(diffs.map(d => d.anytime)), s15Mean = mean(diffs.map(d => d.s15e)), diffMean = mean(diffs.map(d => d.diff));
console.log(`names with a techScore>=15 entry: ${diffs.length}`);
console.log(`  avg "buy ANY bar in these names" edge : ${r2(anyMean)}%`);
console.log(`  avg "buy at techScore>=15 bar" edge   : ${r2(s15Mean)}%`);
console.log(`  timing lift (score15 - anytime)       : ${r2(diffMean)}%   ${diffMean > 0 ? "(score adds entry timing)" : "(pure name-ownership)"}`);
console.log(`  names where score15 beats anytime     : ${r2(100 * diffs.filter(d => d.diff > 0).length / diffs.length)}%`);

console.log("\n===== ATTACK 3 — matched random basket (Control B) =====");
const rng = mulberry32(20260711); const K = s15.length, ITERS = 3000; const draws = [];
const allEdges = base.map(e => e.edge);
for (let it = 0; it < ITERS; it++) { let s = 0; for (let i = 0; i < K; i++) s += allEdges[(rng() * allEdges.length) | 0]; draws.push(s / K); }
draws.sort((a, b) => a - b);
const dMean = mean(draws), dStd = Math.sqrt(mean(draws.map(x => (x - dMean) ** 2)));
const s15edge = mean(s15.map(e => e.edge));
console.log(`random ${K}-trade basket edge: mean ${r2(dMean)}%  95%ile ${r2(draws[Math.floor(0.95 * ITERS)])}%  99.9%ile ${r2(draws[Math.floor(0.999 * ITERS)])}%`);
console.log(`techScore>=15 edge: ${r2(s15edge)}%   z=${r2((s15edge - dMean) / dStd)}  (but note: random draw ignores that score15 = high-beta names)`);
