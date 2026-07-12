/* v6.2 offline verification — drive the SHIPPED engine functions (replayShortTrades,
   dailySignalLog) over real cached bars, exactly as the seed endpoint will, and check:
     1. The v6.2 relative-strength gate FIRES (entries still appear) and is THINNER
        than v6 (rs126≥30pp filters some entries out) — compare v6 vs v6.2 entry counts.
     2. AMD still HOLDS its run (death-cross exit intact) and no early (<200d) TIME exit.
     3. Exits still book with CROSS / STOP / TIME reasons.
     4. Every fired BUY carries rs126 ≥ 0.30 (the gate actually binds).
   Read-only; nothing is written. */

import { readFileSync } from "node:fs";
import {
  replayShortTrades, dailySignalLog, strengthSeriesFor, ret126SeriesFor, computeShortSignal,
  SBT_SEED_SESSIONS, SBT_SEED_VERSION, SBT_RS_MIN,
} from "../../netlify/lib/short-backtest.mjs";

const CACHE = new URL("../../scratchpad/swing-validate/deep-cache.json", import.meta.url);
const c = JSON.parse(readFileSync(CACHE, "utf8"));
const { spyHist, etfBySym, etfHistBySym, histBySym } = c;
console.log(`deep cache newest bar: ${spyHist[0].date} · SBT_SEED_VERSION=${SBT_SEED_VERSION} · replay=${SBT_SEED_SESSIONS} · RS floor=+${SBT_RS_MIN * 100}pp\n`);

const spy560 = spyHist.slice(0, 320);
const spyStr = strengthSeriesFor(spy560);
const spyRet126 = ret126SeriesFor(spy560);
const strengthAsOf = (series, date) => { for (const s of series) if (s.date <= date) return s.strength; return null; };
const secStrFor = (sym) => { const etf = etfBySym?.[sym]; const h = etf ? (etfHistBySym[etf] || []).slice(0, 320) : []; return h.length ? strengthSeriesFor(h) : []; };

const fmtTrade = t =>
  `    entry ${t.entryScoredAt.slice(0, 10)} @$${t.entryPrice}  →  exit ${t.exitScoredAt.slice(0, 10)} @$${t.exitPrice}  ${String(t.exitReason).padEnd(5)} ${(t.pnlPct >= 0 ? "+" : "") + t.pnlPct}%`;

const SAMPLE = ["AMD", "NVDA", "MU", "CAT", "XOM", "VZ", "INTC", "BA", "LLY", "GE"];
let crossSeen = 0, timeSeen = 0, stopSeen = 0, openSeen = 0;
for (const sym of SAMPLE) {
  const hist = (histBySym[sym] || []).slice(0, 560);
  if (hist.length < 205) { console.log(`${sym}: insufficient bars`); continue; }
  const secStr = secStrFor(sym);
  const log = replayShortTrades(sym, hist, spyStr, secStr, spy560, spyRet126);
  console.log(`${sym} — ${log.closed.length} closed, open=${log.open ? `@$${log.open.entryPrice} since ${log.open.entryScoredAt.slice(0, 10)} (${log.open.barsHeld} sessions)` : "none"}`);
  for (const t of [...log.closed].reverse()) console.log(fmtTrade(t));
  for (const t of log.closed) { if (t.exitReason === "CROSS") crossSeen++; if (t.exitReason === "TIME") timeSeen++; if (t.exitReason === "STOP") stopSeen++; }
  if (log.open) openSeen++;
}
console.log(`\nexit-reason mix across sample: CROSS=${crossSeen} TIME=${timeSeen} STOP=${stopSeen} · open=${openSeen}`);

// ---- v6 vs v6.2 entry-count comparison + rs126-binds check, on the full sample of names
let v6Entries = 0, v62Entries = 0, rsViolations = 0, rsChecked = 0;
for (const sym of Object.keys(histBySym)) {
  const hist = (histBySym[sym] || []).slice(0, 560);
  if (hist.length < 260) continue;
  const secStr = secStrFor(sym);
  const lastScorable = hist.length - 200;
  let prevStrong = false;
  for (let i = 0; i <= lastScorable; i++) {
    const date = hist[i].date, opts = { spyStrength: strengthAsOf(spyStr, date), sectorStrength: strengthAsOf(secStr, date) };
    // v6 gate = the same signal WITHOUT the RS floor (rs126 forced to pass)
    const s62 = computeShortSignal(hist.slice(i, i + 260), { ...opts, spyRet126: strengthAsOf(spyRet126, date) });
    const s6 = computeShortSignal(hist.slice(i, i + 260), { ...opts, spyRet126: -999 }); // rs126 always ≥ floor
    if (!s62) continue;
    if (s6.entryStrong) v6Entries++;
    if (s62.entryStrong) { v62Entries++; rsChecked++; if (!(s62.rs126 >= SBT_RS_MIN)) rsViolations++; }
  }
}
console.log(`\nentry counts over the sample-name bars: v6 (no RS floor)=${v6Entries}  →  v6.2 (RS≥${SBT_RS_MIN})=${v62Entries}  (kept ${Math.round(100 * v62Entries / (v6Entries || 1))}%)`);
console.log(`rs126 gate binds: ${rsViolations} of ${rsChecked} fired entries violate rs126≥${SBT_RS_MIN} (must be 0)`);

// ---- assertions
const amdLog = replayShortTrades("AMD", histBySym.AMD.slice(0, 560), spyStr, secStrFor("AMD"), spy560, spyRet126);
const failures = [];
if (!amdLog.open) failures.push("AMD expected to be OPEN through the newest bar — it is not");
const amdEarlyTime = amdLog.closed.find(t => t.exitReason === "TIME" && (Date.parse(t.exitScoredAt) - Date.parse(t.entryScoredAt)) / 86400000 < 200);
if (amdEarlyTime) failures.push(`AMD booked an early (<200d) TIME exit — backstop wrong?`);
if (crossSeen + timeSeen + stopSeen + openSeen === 0) failures.push("no trades at all — replay broken");
if (v62Entries === 0) failures.push("v6.2 gate fires ZERO entries — RS floor is over-blocking (threading bug?)");
if (v62Entries >= v6Entries) failures.push("v6.2 is not thinner than v6 — the RS floor isn't binding");
if (rsViolations > 0) failures.push(`${rsViolations} fired entries violate the rs126 floor — gate not applied`);
console.log(failures.length ? `\n❌ ${failures.length} failure(s):\n- ` + failures.join("\n- ") : "\n✅ v6.2 verification passed: RS floor binds & thins the book; AMD holds; exits intact.");
process.exit(failures.length ? 1 : 0);
