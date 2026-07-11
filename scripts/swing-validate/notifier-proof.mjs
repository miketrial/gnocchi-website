/* ===== Notifier proof — run the 15-day daily BUY/SELL/HOLD log on the REAL
   watchlist with live FMP data, so you can see exactly which signals the swing
   engine fires (mechanism proof — NOT an edge claim). Fetches fresh EOD so the
   window is the most-recent 15 completed sessions. Writes notifier-proof.json.
   Usage: set -a && . ./.env && set +a ; node scripts/swing-validate/notifier-proof.mjs */
import { safe, delay } from "../../netlify/lib/fmp-client.mjs";
import { cleanHist, strengthFactor } from "../../netlify/lib/quickswing-pipeline.mjs";
import { dailySignalLog, replayShortTrades, strengthSeriesFor, pruneShortWindow, SBT_LIQ_FLOOR } from "../../netlify/lib/short-backtest.mjs";
import { etfFor } from "./lib.mjs";
import { writeFileSync } from "node:fs";

// Current Swing watchlist (fetched from the live site 2026-07-10).
const WATCHLIST = "AAOI,ADBE,ADI,ADSK,AER,AGX,ALAB,ALGN,AMAT,AMC,AMD,AME,AMZN,ANET,APLD,APOG,APP,ASML,AVGO,BA,BABA,BE,BHP,BWXT,C,CAT,CEG,CGNX,CMI,CORZ,CRDO,CRH,CRM,CRS,CSTM,CVX,DELL,DHR,ELF,EMR,EQT,ET,ETN,FANG,FFIV,FIX,FLEX,FSS,FTI,GE,GEV,GOOGL,GPRE,GTX,HNST,HON,HPE,HWM,IBM,INDI,INTC,INTU,IONQ,IREN,ISRG,JBL,KEEL,KLAC,KMI,KSCP,LIN,LLY,LRCX,MCHP,MELI,META,MMM,MOV,MP,MPC,MRVL,MSFT,MSTR,MU,NBIS,NEE,NFLX,NOW,NRG,NVDA,ORCL,OUST,PL,PLTR,PSX,RKLB,RLGT,ROK,RS,RYCEY,SLS,SMCI,SMH,SNDK,SOFI,SOXL,STX,TEL,TER,THG,TLN,TRMB,TSLA,TSM,TT,TTD,TXN,ULS,VIST,VRT,VST,VZ,WDAY,WDC,WEYS,WMB,XOM".split(",");
const BARS = 360;

async function getHist(sym, memo) {
  if (memo.has(sym)) return memo.get(sym);
  const h = cleanHist(await safe("historical-price-eod/full", sym, `&limit=${BARS}`)); await delay(80);
  memo.set(sym, h); return h;
}

async function main() {
  if (!process.env.FMP_API_KEY) { console.error("FMP_API_KEY not set."); process.exit(1); }
  const memo = new Map();
  const spyHist = await getHist("SPY", memo);
  const spyStr = strengthSeriesFor(spyHist);
  const etfStrMemo = new Map();

  const out = [];
  let f = 0;
  for (const sym of WATCHLIST) {
    try {
      const hist = await getHist(sym, memo);
      if (!hist || hist.length < 205) { out.push({ sym, skip: `only ${hist?.length ?? 0} bars` }); continue; }
      const profile = await safe("profile", sym); await delay(70);
      const p0 = profile?.[0] || {};
      const etf = etfFor(p0.sector, p0.industry);
      let secStr = [];
      if (etf) { if (!etfStrMemo.has(etf)) etfStrMemo.set(etf, strengthSeriesFor(await getHist(etf, memo))); secStr = etfStrMemo.get(etf); }
      const dl = dailySignalLog(sym, hist, spyStr, secStr, { sessions: 15 });
      const trades = pruneShortWindow(replayShortTrades(sym, hist, spyStr, secStr, spyHist));
      out.push({ sym, sector: p0.sector, days: dl.days, open: dl.open, closedInLog: (trades.closed || []).length });
    } catch (e) { out.push({ sym, error: String(e?.message || e) }); }
    if (++f % 20 === 0) console.log(`  …${f}/${WATCHLIST.length}`);
  }
  writeFileSync(new URL("../../scratchpad/swing-validate/notifier-proof.json", import.meta.url), JSON.stringify(out, null, 2));

  // ---- summary ----
  const scored = out.filter(o => o.days?.length);
  const lastDate = scored.map(o => o.days[o.days.length - 1]?.date).filter(Boolean).sort().pop();
  const buys = [], sells = [], openNow = [], watch = [];
  for (const o of scored) {
    for (const d of o.days) {
      if (d.action === "BUY") buys.push(`${o.sym}@${d.date}($${d.price})`);
      if (d.action === "SELL") sells.push(`${o.sym}@${d.date}(${d.reason})`);
    }
    if (o.open) openNow.push(`${o.sym}(entry $${o.open.entryPrice}, stop $${o.open.stopPrice})`);
    const last = o.days[o.days.length - 1];
    if (last?.action === "WATCH") watch.push(o.sym);
  }
  console.log(`\n=== 15-session notifier (through ${lastDate}) — ${scored.length}/${WATCHLIST.length} scoreable ===`);
  console.log(`\nBUY signals in window (${buys.length}):\n  ${buys.join("  ") || "none"}`);
  console.log(`\nSELL signals in window (${sells.length}):\n  ${sells.join("  ") || "none"}`);
  console.log(`\nOPEN positions now (${openNow.length}):\n  ${openNow.slice(0, 40).join("  ")}${openNow.length > 40 ? ` …+${openNow.length - 40}` : ""}`);
  console.log(`\nWATCH (strong+uptrend but blocked by <$${SBT_LIQ_FLOOR / 1e6}M/day guardrail) latest session (${watch.length}):\n  ${watch.join(" ") || "none"}`);
  console.log(`\nfull per-day log → scratchpad/swing-validate/notifier-proof.json`);
}
main().catch(e => { console.error(e); process.exit(1); });
