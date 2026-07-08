/* ===== QUICK SWING FEATURE =====
   Real-time alert worker. Re-scores the Bounce watchlist ∪ daily Top-N every 5
   min and pushes Telegram messages on:
     - ENTRY: a fresh BUY/SELL verdict transition (or a flip to the opposite side).
     - EXIT: the tracked entry hits its take-profit (first green tick above entry),
       2.5×ATR stop, 3-session time stop, or flips — the SAME rule the paper-trade
       backtest books, so alerts and the Backtest Log stay consistent.
     - HOLD nudges (Section B): a one-shot "read cooling", "approaching stop", and
       "time-stop next session" heads-up while a position is open.

   Delivery discipline (Section A):
     - confirm-before-dedup: a position/verdict only advances after its Telegram
       send is CONFIRMED, so a dropped alert re-fires next tick instead of being
       lost while the dedup silently moves on.
     - loud vs silent: only a fresh STRONG BUY entry, a STOP exit, and a flip-to-
       SELL buzz the phone; everything else arrives silently.
     - flood batching: many fresh entries in one tick collapse into one digest.

   Invoked (fire-and-forget) by quickswing-alert-cron.mjs during market hours.
   Removable with the rest of the QUICK SWING FEATURE block. */
import { scoreTickerQuickSwing, getMarketRegime } from "../lib/quickswing-pipeline.mjs";
import {
  listQuickswingRows, listQsDaily, putQuickswingRow, putQsDailyRow,
  getQsAlertState, putQsAlertState,
  getQsOpenDigestDate, putQsOpenDigestDate,
  getQsPreCloseDate, putQsPreCloseDate, putQsStopMark,
  getQsHeartbeat, putQsHeartbeat,
  acquireRescanLock, releaseRescanLock,
} from "../lib/store.mjs";
import { QS_TIME_STOP_DAYS } from "../lib/quickswing-backtest.mjs";
import { barIsStale } from "../lib/market-calendar.mjs";
import { sendTelegram } from "../lib/telegram.mjs";
import {
  alertTransition, formatAlert, formatExitAlert,
  makeAlertPosition, positionExitDecision,
  etDateStr, etClockLabel, etParts, formatOpenSnapshot, formatOutageRoster,
  formatEntryDigest, formatCoolingNote, formatApproachingStop,
  formatTimeStopNudge, formatPreCloseRoster,
} from "../lib/quickswing-alert.mjs";

const sideForVerdict = (v) => (v === "BUY" ? "long" : v === "SELL" ? "short" : null);
// A send counts as "delivered" for dedup purposes if it succeeded OR was a
// deliberate no-op (Telegram not configured). Only a real DELIVERY FAILURE
// (429/5xx exhausted, network error) holds the state back so it re-fires next
// tick — otherwise a user without Telegram would freeze the whole state machine.
const delivered = (res) => !!res && (res.ok || res.skipped);
// A silent gap longer than this (~3 missed 5-min cycles) counts as an outage:
// on recovery we send a catch-up roster.
const OUTAGE_MS = 16 * 60 * 1000;
// More than this many fresh entries in one tick → one digest instead of a flood.
const ENTRY_FLOOD_CAP = Number(process.env.QS_ENTRY_FLOOD_CAP || 4);
// Approaching-stop danger band, in fractions of R (entry→stop distance).
const NEAR_STOP_R = 0.3;

// Loud only for the three the user opted into: a fresh STRONG BUY entry, a STOP
// exit, and a flip-to-SELL. Everything else is delivered silently.
const loudEntry = (row, kind) => kind === "BUY" && row?.tier === "strong";

/* One-shot, silent HOLD nudges (B1 cooling / B5 approaching-stop / B6 time-stop).
   Returns { pos, sent } — a dedup flag is only set once its send confirms, so a
   dropped nudge re-fires next tick. */
async function holdNudges(pos, row) {
  let sent = 0;
  const long = pos.side === "long";

  // B1 — verdict drained off the position's side before any hard exit.
  const supportsSide = long ? row.verdict === "BUY" : row.verdict === "SELL";
  if (!supportsSide && !pos.cooledNotified) {
    const res = await sendTelegram(formatCoolingNote(row, pos), { silent: true });
    if (delivered(res)) { pos = { ...pos, cooledNotified: true }; sent++; }
  } else if (supportsSide && pos.cooledNotified) {
    pos = { ...pos, cooledNotified: false }; // recovered — allow a future cool to re-notify
  }

  // B5 — price entered the ~0.3R danger band before the hard stop.
  if (pos.stopPrice != null && pos.entryPrice != null && row.price != null) {
    const R = Math.abs(pos.entryPrice - pos.stopPrice);
    const dist = long ? (row.price - pos.stopPrice) : (pos.stopPrice - row.price);
    const inBand = R > 0 && dist > 0 && dist <= NEAR_STOP_R * R;
    if (inBand && !pos.nearStopWarned) {
      const res = await sendTelegram(formatApproachingStop(row, pos), { silent: true });
      if (delivered(res)) { pos = { ...pos, nearStopWarned: true }; sent++; }
    } else if (!inBand && pos.nearStopWarned) {
      pos = { ...pos, nearStopWarned: false };
    }
  }

  // B6 — the session before the time-stop trips.
  if ((pos.barsHeld ?? 0) === (QS_TIME_STOP_DAYS - 1) && !pos.timeWarned) {
    const res = await sendTelegram(formatTimeStopNudge(row, pos, QS_TIME_STOP_DAYS), { silent: true });
    if (delivered(res)) { pos = { ...pos, timeWarned: true }; sent++; }
  }

  return { pos, sent };
}

/* Flush deferred fresh entries (A4). ≤ cap → individual alerts (strong BUYs loud);
   > cap → one silent digest. In both cases a position opens ONLY after the send
   confirms (A1), so a dropped alert re-fires next tick. Returns the sent count. */
async function flushEntries(pending, session) {
  let sent = 0;
  if (pending.length > ENTRY_FLOOD_CAP) {
    const res = await sendTelegram(formatEntryDigest(pending), { silent: true });
    if (delivered(res)) {
      for (const e of pending) {
        const pos = makeAlertPosition(e.row, sideForVerdict(e.kind), e.sessionDate);
        await putQsAlertState(e.sym, e.row.verdict, pos).catch(() => {});
        sent++;
      }
    }
  } else {
    for (const e of pending) {
      const res = await sendTelegram(formatAlert(e.row, e.kind, session, e.source), { silent: !loudEntry(e.row, e.kind) });
      if (delivered(res)) {
        const pos = makeAlertPosition(e.row, sideForVerdict(e.kind), e.sessionDate);
        await putQsAlertState(e.sym, e.row.verdict, pos).catch(() => {});
        sent++;
      }
    }
  }
  return sent;
}

export default async (req) => {
  const { session = "regular" } = await req.json().catch(() => ({}));

  // Share the global rescan lock: if a manual rescan (or a previous alert cycle
  // that overran) is in flight, skip this tick rather than double the FMP fan-out.
  const jobId = `qs-alert-${Date.now()}`;
  const gotLock = await acquireRescanLock(jobId);
  if (!gotLock) {
    console.log("[qs-alert] rescan in progress — skipping this cycle");
    return new Response("", { status: 202 });
  }

  const now = new Date();
  const today = etDateStr(now);
  const lastDigest = await getQsOpenDigestDate().catch(() => null);
  const isOpenScan = session === "regular" && lastDigest !== today;

  // Silent-loop recovery (F3): a long gap since our last successful run → send a
  // one-time catch-up roster after this scan.
  const hb = await getQsHeartbeat().catch(() => null);
  const gapMs = hb?.ts ? (Date.now() - hb.ts) : 0;
  const wasOutage = !!hb?.ts && gapMs > OUTAGE_MS;

  // Pre-close review (B4): once/day around 15:50 ET.
  const { hour: etHour, minute: etMin } = etParts(now);
  const preCloseDone = await getQsPreCloseDate().catch(() => null);
  const isPreClose = session === "regular" && etHour === 15 && etMin >= 48 && etMin <= 54 && preCloseDone !== today;

  let scored = 0, alerted = 0, staleSkipped = 0;
  const openPositions = [];   // positions open at the START of this tick (recovery + pre-close rosters)
  const priorStateBySym = {}; // for the open-scan carried-position fix (B3)
  const pendingEntries = [];  // deferred fresh entries for flood batching (A4)
  try {
    const regime = await getMarketRegime().catch(() => null);
    const [manual, daily] = await Promise.all([
      listQuickswingRows(),
      listQsDaily().catch(() => []),
    ]);
    const manualSet = new Set(manual.map((r) => r?.sym).filter(Boolean));
    const dailySet = new Set(daily.map((r) => r?.sym).filter(Boolean));
    const sourceOf = new Map();
    for (const r of manual) if (r?.sym) sourceOf.set(r.sym, "manual");
    for (const r of daily) if (r?.sym && !sourceOf.has(r.sym)) sourceOf.set(r.sym, "daily");
    const watchlist = [...sourceOf.entries()].map(([sym, source]) => ({ sym, source }));

    const scoredRows = [];
    const prevMap = {};

    for (const { sym, source } of watchlist) {
      try {
        const row = await scoreTickerQuickSwing(sym, { skipCache: true, marketRegime: regime });
        // Write each fresh row back to the store(s) it belongs to (no leakage of
        // auto names into the manual watchlist; a name in both mirrors to daily).
        if (manualSet.has(sym)) await putQuickswingRow(sym, row).catch(() => {});
        if (dailySet.has(sym)) await putQsDailyRow(sym, row).catch(() => {});
        scored++;

        const prevState = await getQsAlertState(sym).catch(() => null);
        const prevVerdict = prevState?.verdict ?? null;
        prevMap[sym] = prevVerdict;
        scoredRows.push(row);
        priorStateBySym[sym] = prevState;
        if (prevState?.pos) {
          openPositions.push({
            sym, source, side: prevState.pos.side,
            entryPrice: prevState.pos.entryPrice, stopPrice: prevState.pos.stopPrice,
            barsHeld: prevState.pos.barsHeld, price: row.price, overnightGap: row.overnightGap,
          });
        }
        if (isOpenScan) continue; // the open snapshot (after the loop) handles alerts + positions

        // Session (bar) date — advances once per trading day so intraday rescans
        // don't inflate the time-stop counter.
        const sessionDate = row.dataAsOf || today;
        let pos = prevState?.pos ?? null;
        if (pos && pos.lastSessionDate && sessionDate > pos.lastSessionDate) {
          pos = { ...pos, barsHeld: (pos.barsHeld || 0) + 1, lastSessionDate: sessionDate };
        }

        let newVerdict = prevVerdict;
        if (pos) {
          // Holding: STOP → TARGET → FLIP → TIME. Only advance state on a CONFIRMED send.
          const { reason } = positionExitDecision(pos, row, QS_TIME_STOP_DAYS);
          if (reason === "FLIP") {
            const res = await sendTelegram(formatAlert(row, row.verdict, session, source), { silent: false }); // flip-to-SELL is loud
            if (delivered(res)) { pos = makeAlertPosition(row, sideForVerdict(row.verdict), sessionDate); newVerdict = row.verdict; alerted++; }
          } else if (reason) { // STOP / TARGET / TIME
            const loud = reason === "STOP";
            const res = await sendTelegram(formatExitAlert(row, reason, pos, session, source), { silent: !loud });
            if (delivered(res)) {
              if (reason === "STOP") await putQsStopMark(sym, today).catch(() => {}); // A6 — withhold from daily for a few sessions
              pos = null;
              newVerdict = row.verdict; // keep the side so we don't immediately re-enter it
              alerted++;
            }
            // send failed → keep pos → retry next tick
          } else {
            // Hold — one-shot silent nudges (B1/B5/B6).
            const nudged = await holdNudges(pos, row);
            pos = nudged.pos;
            alerted += nudged.sent;
          }
        } else {
          const { fire, kind } = alertTransition(prevVerdict, row.verdict);
          if (fire && (kind === "BUY" || kind === "SELL")) {
            if (barIsStale(row.dataAsOf, today)) {
              // FMP's daily bar is >=1 full session behind — the technicals are
              // frozen. Suppress the ENTRY and leave the dedup verdict untouched
              // (don't write) so it fires for real once the feed catches up.
              staleSkipped++;
              continue;
            }
            // Defer to the post-loop batch decision (A4). State/position advance
            // there, after the send confirms — so leave this sym's state untouched.
            pendingEntries.push({ sym, row, kind, source, sessionDate });
            continue;
          }
          newVerdict = row.verdict;
        }

        await putQsAlertState(sym, newVerdict, pos).catch(() => {});
      } catch (e) {
        console.error(`[qs-alert] ${sym} failed:`, e?.message || e);
      }
    }

    // Flush deferred fresh entries (A4) — individual (tiered) or one digest.
    if (!isOpenScan && pendingEntries.length) {
      alerted += await flushEntries(pendingEntries, session);
    }

    if (isOpenScan) {
      // Consolidated Market Open snapshot — MANUAL watchlist only (kept separate
      // from the 9:45 Most-Active message), delivered silently.
      const manualRows = scoredRows.filter((r) => manualSet.has(r.sym));
      const res = await sendTelegram(
        formatOpenSnapshot({ rows: manualRows, prevMap, regime, label: etClockLabel(now) }),
        { silent: true }
      );
      if (res?.ok) alerted = manualRows.filter((r) => r.verdict === "BUY" || r.verdict === "SELL").length;
      // Re-baseline dedup + positions to the open. B3 fix: CARRY a same-side
      // position's real entry/stop/bars across the day instead of resetting it to
      // today's open (which zeroed barsHeld so the time-stop never tripped and
      // reset the cost basis each morning).
      for (const row of scoredRows) {
        const side = sideForVerdict(row.verdict);
        const prior = priorStateBySym[row.sym]?.pos;
        let pos;
        if (side && prior && prior.side === side) {
          const nd = row.dataAsOf || today;
          const advanced = prior.lastSessionDate && nd > prior.lastSessionDate;
          pos = { ...prior, barsHeld: (prior.barsHeld || 0) + (advanced ? 1 : 0), lastSessionDate: nd };
        } else {
          pos = side ? makeAlertPosition(row, side, row.dataAsOf || today) : null;
        }
        await putQsAlertState(row.sym, row.verdict, pos).catch(() => {});
      }
      await putQsOpenDigestDate(today).catch(() => {});
    }

    // Pre-close review (B4) — once/day, silent.
    if (isPreClose && !isOpenScan) {
      const res = await sendTelegram(formatPreCloseRoster(openPositions, etClockLabel(now), QS_TIME_STOP_DAYS), { silent: true });
      if (delivered(res)) await putQsPreCloseDate(today).catch(() => {});
    }

    // Silent-loop recovery roster (F3) — once, after a real outage, silent.
    if (wasOutage && !isOpenScan) {
      await sendTelegram(formatOutageRoster(openPositions, gapMs / 60000), { silent: true }).catch(() => {});
    }

    // Heartbeat — stamp only on a successful finish (F1 watchdog reads it).
    await putQsHeartbeat({ session, scored }).catch(() => {});
  } finally {
    await releaseRescanLock(jobId);
  }

  console.log(`[qs-alert] session=${session} openScan=${isOpenScan} scored=${scored} `
    + `alerted=${alerted} entries=${pendingEntries.length} staleSkipped=${staleSkipped} `
    + `preClose=${isPreClose && !isOpenScan} outageRecover=${wasOutage && !isOpenScan}`);
  return new Response("", { status: 202 });
};
