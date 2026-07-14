/* Final attack: SURVIVORSHIP. Our caches only hold today's survivors, so the rule
   has never seen a former high-flyer that ran up then went to ZERO. Pull a curated
   set of liquid momentum names that later delisted/went bankrupt, verify each is a
   GENUINE delisting (newest bar well before 2026 — guards against FMP recycling a
   dead ticker's symbol), score them with the exact live gate, and ask: did the
   "best of the best" signal (techScore>=15, uptrend, $300M/day) ever fire on them,
   and what did that trade return holding into the collapse? That is the survivorship
   penalty the survivor-only backtest cannot see. Reuses the universe cache's SPY +
   sector-ETF strength series (market-wide, valid for any name). */
import { readFileSync } from "node:fs";
import { computeShortSignal, strengthSeriesFor } from "../../netlify/lib/short-backtest.mjs";

const KEY = (readFileSync(new URL("../../.env", import.meta.url), "utf8").match(/FMP_API_KEY\s*=\s*([^\s]+)/) || [])[1];
const CACHE = new URL("../../scratchpad/swing-validate/universe500-cache.json", import.meta.url);
const HARD_STOP_PCT = 0.40, H = 126;
const SECTOR_ETF = { "Technology": "XLK", "Healthcare": "XLV", "Utilities": "XLU", "Industrials": "XLI", "Consumer Cyclical": "XLY", "Consumer Defensive": "XLP", "Financial Services": "XLF", "Communication Services": "XLC", "Basic Materials": "XLB", "Energy": "XLE", "Real Estate": "XLRE" };
// Former liquid/high-momentum names that delisted or went bankrupt (2022-2025).
const NAMES = ["NKLA","FSR","RIDE","GOEV","VORB","WE","BRDS","YELL","SAVE","BIG","TUP","PTRA","IRNT","CANO","REV","EXPR","MMAT","AMTD","CVNA_SKIP"];
const r2 = x => (x == null ? null : Math.round(x * 100) / 100);
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const strengthAsOf = (s, d) => { for (const x of s) if (x.date <= d) return x.strength; return null; };
const spyAsOf = (h, d) => { for (const b of h) if (b.date <= d) return b.close ?? b.price; return null; };
const spyRet = (h, e, x) => { const a = spyAsOf(h, e), b = spyAsOf(h, x); return (a > 0 && b > 0) ? ((b - a) / a) * 100 : null; };

const c = JSON.parse(readFileSync(CACHE, "utf8"));
const spyHist = c.spyHist, spyStr = strengthSeriesFor(spyHist);
const etfStr = {}; for (const [e, h] of Object.entries(c.etfHistBySym || {})) etfStr[e] = strengthSeriesFor(h);

async function pull(sym) {
  const hr = await fetch(`https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=${sym}&apikey=${KEY}`);
  const hj = await hr.json(); const hist = (Array.isArray(hj) ? hj : hj.historical || []).map(b => ({ date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume }));
  const pr = await fetch(`https://financialmodelingprep.com/stable/profile?symbol=${sym}&apikey=${KEY}`);
  const pj = await pr.json(); const prof = Array.isArray(pj) ? pj[0] : pj;
  return { hist, sector: prof?.sector || null, delistedProfile: prof?.isActivelyTrading === false };
}

function simFwd(hist, i) {
  const entry = hist[i].close, stop = entry * (1 - HARD_STOP_PCT); let day = 0;
  for (let j = i - 1; j >= 0; j--) { const bar = hist[j]; day++; const low = bar.low > 0 ? bar.low : bar.close;
    if (low <= stop) { const fill = (bar.open > 0 && bar.open <= stop) ? bar.open : stop; return { pnl: ((fill - entry) / entry) * 100, exitDate: bar.date, reason: "STOP" }; }
    if (day >= H) return { pnl: ((bar.close - entry) / entry) * 100, exitDate: bar.date, reason: "TIME" }; }
  const l = hist[0]; return { pnl: ((l.close - entry) / entry) * 100, exitDate: l.date, reason: "DELIST/EOD" };
}

const results = [];
const s15trades = [], anyGateTrades = [];
for (const sym of NAMES) {
  if (sym.endsWith("_SKIP")) continue;
  try {
    const { hist, sector, delistedProfile } = await pull(sym);
    if (!hist.length) { console.log(`${sym}\tNO DATA`); continue; }
    const newest = hist[0].date;
    const genuine = newest < "2025-09-01"; // must have stopped trading -> guards symbol recycling
    if (!genuine) { console.log(`${sym}\tSKIP (newest ${newest} — still trading / recycled symbol)`); continue; }
    if (hist.length < 205) { console.log(`${sym}\tSKIP (${hist.length} bars, <205)`); continue; }
    const etf = SECTOR_ETF[sector] || null; const secStr = etf ? (etfStr[etf] || []) : [];
    const len = hist.length, last = len - 200;
    const strong = new Array(len).fill(false), sc = new Array(len).fill(0), dv = new Array(len).fill(0);
    for (let i = 0; i <= last; i++) { const sig = computeShortSignal(hist.slice(i), { spyStrength: strengthAsOf(spyStr, hist[i].date), sectorStrength: strengthAsOf(secStr, hist[i].date) }); sc[i] = sig ? sig.techScore : 0; strong[i] = !!(sig && sig.entryStrong); dv[i] = sig ? sig.avgDollarVol : 0; }
    let nGate = 0, nS15 = 0; const gTrades = [], sTrades = [];
    for (let i = 0; i <= last; i++) {
      if (!strong[i] || (i + 1 <= last && strong[i + 1]) || !(hist[i].close > 0)) continue;
      const r = simFwd(hist, i); const s = spyRet(spyHist, hist[i].date, r.exitDate); const edge = s == null ? null : r.pnl - s;
      nGate++; gTrades.push({ date: hist[i].date, ts: sc[i], pnl: r2(r.pnl), edge: r2(edge), reason: r.reason });
      anyGateTrades.push(r.pnl);
      if (sc[i] >= 15) { nS15++; sTrades.push({ date: hist[i].date, ts: sc[i], pnl: r2(r.pnl), reason: r.reason }); s15trades.push(r.pnl); }
    }
    const peakDV = Math.max(...dv);
    console.log(`${sym}\tsector=${sector||"?"}\tbars ${hist.length} (${hist[len-1].date}..${newest})\tpeak$vol ${(peakDV/1e6).toFixed(0)}M\tgateEntries ${nGate}\ttechScore>=15 ${nS15}`);
    if (sTrades.length) console.log(`   techScore>=15 trades: ` + sTrades.map(t => `${t.date} ts${t.ts} ${t.pnl}% [${t.reason}]`).join(" | "));
    results.push({ sym, sector, peakDV, nGate, nS15, gTrades, sTrades });
  } catch (e) { console.log(`${sym}\tERR ${e.message}`); }
}

console.log("\n===== SURVIVORSHIP PENALTY SUMMARY =====");
console.log(`delisted high-flyers tested: ${results.length}`);
console.log(`  passed the shipped gate at least once: ${results.filter(r => r.nGate > 0).length}`);
console.log(`  ever fired techScore>=15 ('best of the best'): ${results.filter(r => r.nS15 > 0).length}  (${s15trades.length} such trades)`);
if (s15trades.length) console.log(`  those techScore>=15 trades: avg ${r2(mean(s15trades))}%  worst ${r2(Math.min(...s15trades))}%  %losers ${r2(100*s15trades.filter(x=>x<0).length/s15trades.length)}%`);
if (anyGateTrades.length) console.log(`  ALL gate trades on delisted names: avg ${r2(mean(anyGateTrades))}%  worst ${r2(Math.min(...anyGateTrades))}%`);
console.log("\n(Compare: on the survivor universe, techScore>=15 averaged +17.7% / +11.2% edge. Any drag here is the survivorship gap the survivor-only backtest hides.)");
