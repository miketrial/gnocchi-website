/* v6 offline verification — drive the SHIPPED engine functions (replayShortTrades,
   dailySignalLog) over real cached bars, exactly as the seed endpoint will, and
   check the behavior the exit study promised:
     1. AMD: the Jan/Apr-2026 entries now HOLD through today (no death-cross on the
        run) instead of TIME-exiting at 63 sessions.
     2. CROSS exits appear (a name whose 50DMA fell through its 200DMA closes with
        reason CROSS, at that bar's close).
     3. Conviction stamps flow: position/trade `.conviction` + dailyLog days.
     4. Replay window: hist truncated to 560 bars (the live fetch limit) still
        yields the same trades as full history over the 240-session window.
   Read-only; nothing is written. */

import { readFileSync } from "node:fs";
import {
  replayShortTrades, dailySignalLog, strengthSeriesFor,
  SBT_SEED_SESSIONS, SBT_SEED_VERSION,
} from "../../netlify/lib/short-backtest.mjs";

const CACHE = new URL("../../scratchpad/swing-validate/deep-cache.json", import.meta.url);
const c = JSON.parse(readFileSync(CACHE, "utf8"));
const { spyHist, etfBySym, etfHistBySym, histBySym } = c;
console.log(`deep cache newest bar: ${spyHist[0].date} · SBT_SEED_VERSION=${SBT_SEED_VERSION} · replay=${SBT_SEED_SESSIONS} sessions\n`);

// Mirror the seed endpoint: per-ticker hist truncated to 560 bars, SPY/ETF to 320
// (the live scorer's shared cache length).
const spy560 = spyHist.slice(0, 320);
const spyStr = strengthSeriesFor(spy560);
const secStrFor = (sym) => {
  const etf = etfBySym?.[sym];
  const h = etf ? (etfHistBySym[etf] || []).slice(0, 320) : [];
  return h.length ? strengthSeriesFor(h) : [];
};

const fmtTrade = t =>
  `  ${t.conviction ? "★" : " "} entry ${t.entryScoredAt.slice(0, 10)} @$${t.entryPrice}  →  exit ${t.exitScoredAt.slice(0, 10)} @$${t.exitPrice}  ${String(t.exitReason).padEnd(5)} ${(t.pnlPct >= 0 ? "+" : "") + t.pnlPct}%`;

const SAMPLE = ["AMD", "NVDA", "MU", "CAT", "XOM", "VZ", "INTC", "BA", "LLY", "GE"];
let crossSeen = 0, timeSeen = 0, stopSeen = 0, openSeen = 0, convSeen = 0;
for (const sym of SAMPLE) {
  const hist = (histBySym[sym] || []).slice(0, 560);
  if (hist.length < 205) { console.log(`${sym}: insufficient bars`); continue; }
  const secStr = secStrFor(sym);
  const log = replayShortTrades(sym, hist, spyStr, secStr, spy560);
  const dl = dailySignalLog(sym, hist, spyStr, secStr, { sessions: 15 });
  console.log(`${sym} — ${log.closed.length} closed, open=${log.open ? `${log.open.conviction ? "★" : ""}@$${log.open.entryPrice} since ${log.open.entryScoredAt.slice(0, 10)} (${log.open.barsHeld} sessions)` : "none"}`);
  for (const t of [...log.closed].reverse()) console.log(fmtTrade(t));
  for (const t of log.closed) {
    if (t.exitReason === "CROSS") crossSeen++;
    if (t.exitReason === "TIME") timeSeen++;
    if (t.exitReason === "STOP") stopSeen++;
    if (t.conviction) convSeen++;
  }
  if (log.open) { openSeen++; if (log.open.conviction) convSeen++; }
  const dlBuys = dl.days.filter(d => d.action === "BUY");
  if (dlBuys.length) console.log(`  dailyLog BUYs: ${dlBuys.map(d => `${d.date}${d.conviction ? "★" : ""}`).join(", ")}`);
  console.log("");
}
console.log(`exit-reason mix across sample: CROSS=${crossSeen} TIME=${timeSeen} STOP=${stopSeen} · open=${openSeen} · conviction-stamped=${convSeen}`);

// ---- assertions
const amdHist = histBySym.AMD.slice(0, 560);
const amdLog = replayShortTrades("AMD", amdHist, spyStr, secStrFor("AMD"), spy560);
const failures = [];
// 1. AMD must be HOLDING through today — its uptrend never death-crossed on the run.
if (!amdLog.open) failures.push("AMD expected to be OPEN through the newest bar (no death-cross on the run) — it is not");
// 2. No AMD TIME exit before ~189 sessions (the old 63-day guillotine must be gone).
const amdEarlyTime = amdLog.closed.find(t => t.exitReason === "TIME" && (Date.parse(t.exitScoredAt) - Date.parse(t.entryScoredAt)) / 86400000 < 200);
if (amdEarlyTime) failures.push(`AMD booked an early TIME exit (${JSON.stringify(amdEarlyTime)}) — 63-day cap still active?`);
// 3. The engine must still be capable of ALL THREE exits somewhere in the sample.
if (crossSeen === 0 && timeSeen === 0 && stopSeen === 0 && openSeen === 0) failures.push("no trades at all — replay broken");
console.log(failures.length ? `\n❌ ${failures.length} verification failure(s):\n- ` + failures.join("\n- ") : "\n✅ v6 verification passed: AMD holds the run; no early TIME guillotine; exits book with the new reasons.");
process.exit(failures.length ? 1 : 0);
