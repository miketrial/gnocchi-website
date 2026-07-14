/* Swing exit forensics — "why did we sell AMD before the run, and what would
   holding / a smarter exit have done?"

   For each watchlist name, this:
     1. Replays the SHIPPED swing engine (computeShortSignal.entryStrong entry +
        recordShortTransition's 40%-stop/63d-TIME exit, byte-identical to the site,
        long-only, sequential one-position-at-a-time) from START forward → the exact
        trades the panel would show.
     2. For each shipped entry, follows the REAL future bars in the cache (through the
        newest bar) under counterfactual exits, holding entry fixed:
          - shipped   : 40% catastrophe stop, else 63-session TIME cap (what we do now)
          - trendBreak: exit first close below the 50DMA (classic trend-follow give-back)
          - chand3    : chandelier trail — highHigh-since-entry − 3×ATR14, 40% backstop
          - chand4    : chandelier trail − 4×ATR14, 40% backstop
          - hold126   : fixed ~6-month hold (the holdtime report's "defensible" cap)
          - holdToday : never sell (mark-to-market at the newest bar) — the ceiling
        Each is benchmarked vs SPY buy-and-hold over its OWN entry→exit window.

   Pure/off-cache. Reuses the live engine so entries are exactly what ships. */

import { readFileSync } from "node:fs";
import {
  computeShortSignal, recordShortTransition, strengthSeriesFor,
  SBT_TIME_STOP_DAYS, SBT_HARD_STOP_PCT,
} from "../../netlify/lib/short-backtest.mjs";

const CACHE = new URL("../../scratchpad/swing-validate/deep-cache.json", import.meta.url);
const START = "2024-06-01";          // replay from here (>=200 bars of prior warmup exist)
const WATCHLIST = "AAOI,ADBE,ADI,ADSK,AER,AGX,ALAB,ALGN,AMAT,AMC,AMD,AME,AMZN,ANET,APLD,APOG,APP,ASML,AVGO,BA,BABA,BE,BHP,BWXT,C,CAT,CEG,CGNX,CMI,CORZ,CRDO,CRH,CRM,CRS,CSTM,CVX,DELL,DHR,ELF,EMR,EQT,ET,ETN,FANG,FFIV,FIX,FLEX,FSS,FTI,GE,GEV,GOOGL,GPRE,GTX,HNST,HON,HPE,HWM,IBM,INDI,INTC,INTU,IONQ,IREN,ISRG,JBL,KLAC,KMI,LIN,LLY,LRCX,MCHP,MELI,META,MMM,MP,MPC,MRVL,MSFT,MSTR,MU,NBIS,NEE,NFLX,NOW,NRG,NVDA,ORCL,PLTR,PSX,RKLB,ROK,RS,SLS,SMCI,SNDK,SOFI,STX,TEL,TER,TLN,TRMB,TSLA,TSM,TT,TTD,TXN,VIST,VRT,VST,VZ,WDAY,WDC,WMB,XOM".split(",");

const round2 = x => (x == null ? null : Math.round(x * 100) / 100);
const mean = a => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor((s.length - 1) / 2)]; };
const winRate = a => (a.length ? a.filter(x => x > 0).length / a.length : null);
const strengthAsOf = (series, date) => { for (const s of series) if (s.date <= date) return s.strength; return null; };
const spyCloseAsOf = (spyHist, date) => { for (const b of spyHist) if (b.date <= date) return b.close ?? b.price; return null; };
function spyRet(spyHist, e, x) { const a = spyCloseAsOf(spyHist, e), b = spyCloseAsOf(spyHist, x); return (a > 0 && b > 0) ? ((b - a) / a) * 100 : null; }

console.error("loading deep cache…");
const c = JSON.parse(readFileSync(CACHE, "utf8"));
const { spyHist, etfBySym, etfHistBySym, histBySym } = c;
const newest = spyHist[0].date;
const spyStr = strengthSeriesFor(spyHist);
const etfStr = {};
for (const [etf, h] of Object.entries(etfHistBySym || {})) etfStr[etf] = strengthSeriesFor(h);

/* Rolling SMA/ATR on ASCENDING bars for the counterfactual exits (bars[0] oldest). */
function ascendingTA(descHist) {
  const bars = [...descHist].reverse(); // oldest→newest
  const n = bars.length;
  const sma50 = Array(n).fill(null), sma200 = Array(n).fill(null), atr14 = Array(n).fill(null);
  let s50 = 0, s200 = 0;
  for (let i = 0; i < n; i++) {
    s50 += bars[i].close; if (i >= 50) s50 -= bars[i - 50].close; if (i >= 49) sma50[i] = s50 / 50;
    s200 += bars[i].close; if (i >= 200) s200 -= bars[i - 200].close; if (i >= 199) sma200[i] = s200 / 200;
  }
  // Wilder ATR14 on true range
  const tr = Array(n).fill(null);
  for (let i = 1; i < n; i++) {
    const h = bars[i].high ?? bars[i].close, l = bars[i].low ?? bars[i].close, pc = bars[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  let prev = null;
  for (let i = 1; i < n; i++) {
    if (i < 14) continue;
    if (prev == null) { let s = 0; for (let k = i - 13; k <= i; k++) s += tr[k]; prev = s / 14; }
    else prev = (prev * 13 + tr[i]) / 14;
    atr14[i] = prev;
  }
  const idxByDate = {}; for (let i = 0; i < n; i++) idxByDate[bars[i].date] = i;
  return { bars, sma50, sma200, atr14, idxByDate };
}

/* Counterfactual exit from an entry (ascending index ei) forward through newest bar. */
function cfExit(ta, ei, rule) {
  const { bars, sma50, atr14 } = ta;
  const entry = bars[ei].close;
  const hardStop = entry * (1 - SBT_HARD_STOP_PCT);
  let extreme = bars[ei].high ?? entry;
  const N = bars.length;
  for (let k = ei + 1; k < N; k++) {
    const bar = bars[k], day = k - ei;
    const low = bar.low ?? bar.close, close = bar.close, open = bar.open ?? bar.close;
    // catastrophe 40% stop (all rules carry it, like the shipped engine's backstop)
    if (rule.hardStop !== false && low <= hardStop) {
      const fill = (open <= hardStop) ? open : hardStop;
      return { exitDate: bar.date, exitPrice: round2(fill), pnl: ((fill - entry) / entry) * 100, hold: day, reason: "STOP" };
    }
    // chandelier trailing stop
    if (rule.trailAtr) {
      const atr = atr14[k] ?? atr14[k - 1];
      if (atr > 0) {
        const line = extreme - rule.trailAtr * atr;
        if (low <= line) { const fill = (open <= line) ? open : line; return { exitDate: bar.date, exitPrice: round2(fill), pnl: ((fill - entry) / entry) * 100, hold: day, reason: "TRAIL" }; }
      }
    }
    // trend-break: close below 50DMA
    if (rule.trendBreak && sma50[k] != null && close < sma50[k]) {
      return { exitDate: bar.date, exitPrice: round2(close), pnl: ((close - entry) / entry) * 100, hold: day, reason: "TREND" };
    }
    // maCross: exit on a 50/200 death-cross (slow, patient trend death)
    if (rule.maCross && ta.sma50[k] != null && ta.sma200[k] != null && ta.sma50[k] < ta.sma200[k]) {
      return { exitDate: bar.date, exitPrice: round2(close), pnl: ((close - entry) / entry) * 100, hold: day, reason: "MACROSS" };
    }
    // fixed time cap
    if (rule.timeStop && day >= rule.timeStop) {
      return { exitDate: bar.date, exitPrice: round2(close), pnl: ((close - entry) / entry) * 100, hold: day, reason: "TIME" };
    }
    if ((bar.high ?? close) > extreme) extreme = bar.high ?? close;
  }
  const last = bars[N - 1];
  return { exitDate: last.date, exitPrice: round2(last.close), pnl: ((last.close - entry) / entry) * 100, hold: N - 1 - ei, reason: "OPEN" };
}

const RULES = {
  shipped:   { hardStop: true, timeStop: SBT_TIME_STOP_DAYS },   // 40% stop + 63d TIME (what ships)
  maCross:   { hardStop: true, maCross: true },                  // exit only on a 50/200 death-cross
  trendBreak:{ hardStop: true, trendBreak: true },               // exit on first 50DMA loss
  chand3:    { hardStop: true, trailAtr: 3 },
  chand4:    { hardStop: true, trailAtr: 4 },
  hold126:   { hardStop: true, timeStop: 126 },
  holdToday: { hardStop: false },                                // never sell (ceiling)
};
const RULE_ORDER = ["shipped", "maCross", "trendBreak", "chand3", "chand4", "hold126", "holdToday"];

/* Replay the shipped engine forward from START → the exact sequential trades. */
function shippedTrades(sym, hist, secStr) {
  const asc = [...hist].reverse();
  const dates = asc.filter(b => b.date >= START).map(b => b.date);
  let log = { open: null, closed: [] };
  for (const date of dates) {
    const hAsOf = hist.filter(d => d.date <= date);
    if (hAsOf.length < 200) continue;
    const sig = computeShortSignal(hAsOf, { spyStrength: strengthAsOf(spyStr, date), sectorStrength: strengthAsOf(secStr, date) });
    if (!sig) continue;
    log = recordShortTransition(sym, sig, log, `${date}T21:00:00.000Z`);
  }
  const trades = log.closed.map(t => ({ entryDate: t.entryScoredAt.slice(0, 10), entryPrice: t.entryPrice, shippedExitDate: t.exitScoredAt.slice(0, 10), shippedReason: t.exitReason, shippedPnl: t.pnlPct }));
  if (log.open) trades.push({ entryDate: log.open.entryScoredAt.slice(0, 10), entryPrice: log.open.entryPrice, shippedReason: "OPEN", open: true });
  return trades.sort((a, b) => (a.entryDate < b.entryDate ? -1 : 1));
}

// ---- run
const perRule = Object.fromEntries(RULE_ORDER.map(r => [r, { pnls: [], edges: [], holds: [] }]));
const amdRows = [];
let namesWithTrades = 0, totalTrades = 0;

for (const sym of WATCHLIST) {
  const hist = histBySym[sym];
  if (!hist || hist.length < 260) continue;
  const etf = etfBySym?.[sym] || null;
  const secStr = etf ? (etfStr[etf] || []) : [];
  const ta = ascendingTA(hist);
  const trades = shippedTrades(sym, hist, secStr);
  if (!trades.length) continue;
  namesWithTrades++;
  for (const tr of trades) {
    const ei = ta.idxByDate[tr.entryDate];
    if (ei == null) continue;
    totalTrades++;
    const results = {};
    for (const rname of RULE_ORDER) {
      const r = cfExit(ta, ei, RULES[rname]);
      const s = spyRet(spyHist, tr.entryDate, r.exitDate);
      r.spy = s; r.edge = (s != null ? r.pnl - s : null);
      results[rname] = r;
      perRule[rname].pnls.push(r.pnl);
      if (r.edge != null) perRule[rname].edges.push(r.edge);
      perRule[rname].holds.push(r.hold);
    }
    if (sym === "AMD") amdRows.push({ tr, results });
  }
}

// ---- AMD deep dive
console.log(`\n${"=".repeat(78)}\nAMD — every shipped swing entry since ${START}, and where each exit rule would land`);
console.log(`(cache newest bar ${newest}; AMD last close ${histBySym.AMD[0].close})`);
for (const { tr, results } of amdRows) {
  console.log(`\n● ENTRY ${tr.entryDate} @ $${round2(tr.entryPrice)}${tr.open ? "  (still OPEN in shipped log)" : ""}`);
  console.log(`   rule        exit date    exit $     P/L      SPY same days   edge     hold(d)  reason`);
  for (const rname of RULE_ORDER) {
    const r = results[rname];
    console.log(`   ${rname.padEnd(11)} ${String(r.exitDate).padEnd(12)} ${String("$" + r.exitPrice).padStart(8)}  ${(r.pnl >= 0 ? "+" : "") + round2(r.pnl) + "%"}`.padEnd(70).slice(0, 58)
      + `${(r.spy == null ? "—" : (r.spy >= 0 ? "+" : "") + round2(r.spy) + "%").padStart(8)}  ${(r.edge == null ? "—" : (r.edge >= 0 ? "+" : "") + round2(r.edge) + "%").padStart(8)}  ${String(r.hold).padStart(6)}   ${r.reason}`);
  }
}

// ---- portfolio-level across the whole watchlist
console.log(`\n${"=".repeat(78)}\nWATCHLIST AGGREGATE — ${totalTrades} shipped entries across ${namesWithTrades} names since ${START}`);
console.log(`exit rule    n    avgP/L   medHold   win%    avgEdgeVsSPY   totalPnL($10k/trade)`);
for (const rname of RULE_ORDER) {
  const p = perRule[rname];
  const cum = p.pnls.reduce((s, x) => s + 10000 * (x / 100), 0);
  console.log(`${rname.padEnd(11)}  ${String(p.pnls.length).padStart(3)}  ${((mean(p.pnls) >= 0 ? "+" : "") + round2(mean(p.pnls)) + "%").padStart(8)}  ${String(median(p.holds)).padStart(6)}  ${(round2(winRate(p.pnls) * 100) + "%").padStart(6)}  ${((mean(p.edges) >= 0 ? "+" : "") + round2(mean(p.edges)) + "%").padStart(9)}     ${("$" + Math.round(cum).toLocaleString()).padStart(12)}`);
}
console.log("\nnote: holdToday = mark-to-market at the newest bar (unrealized) — the never-sell ceiling, not an achievable rule.");
