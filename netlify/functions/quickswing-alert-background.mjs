/* ===== QUICK SWING FEATURE =====
   Real-time alert worker. Re-scores the Quick Swing watchlist and pushes Telegram
   messages on two things:
     - ENTRY: a fresh BUY/SELL verdict transition (or a flip to the opposite side).
     - EXIT: the entry it told you to take hits its take-profit (first green tick
       above entry), 2.5×ATR stop, or 3-session time stop — the SAME exit rule the
       paper-trade backtest books (quickswing-backtest.mjs v11), so the alerts and
       the Backtest Log tell one consistent story.

   It tracks the open "alert position" (entry price / side / stop / sessions-held)
   on the qs-alert-state blob. NEUTRAL/BLOCKED are held through, not exited — a
   position leaves only via take-profit, stop, flip, or time stop. Once a position
   exits, the same-side verdict is NOT re-entered until a genuinely fresh setup
   (verdict leaves the side and returns), so a stopped/booked name doesn't re-ping
   every 5 minutes.

   Invoked (fire-and-forget) by quickswing-alert-cron.mjs during market hours.
   Reuses the exact scoring call the manual rescan uses, so the verdict can't
   drift from the app table. Removable with the rest of the QUICK SWING FEATURE
   block. */
import { scoreTickerQuickSwing, getMarketRegime } from "../lib/quickswing-pipeline.mjs";
import {
  listQuickswingRows, putQuickswingRow,
  getQsAlertState, putQsAlertState,
  getQsOpenDigestDate, putQsOpenDigestDate,
  acquireRescanLock, releaseRescanLock,
} from "../lib/store.mjs";
import { QS_TIME_STOP_DAYS } from "../lib/quickswing-backtest.mjs";
import { sendTelegram } from "../lib/telegram.mjs";
import {
  alertTransition, formatAlert, formatExitAlert,
  makeAlertPosition, positionExitDecision,
  etDateStr, etClockLabel, formatOpenSnapshot,
} from "../lib/quickswing-alert.mjs";

const sideForVerdict = (v) => (v === "BUY" ? "long" : v === "SELL" ? "short" : null);

export default async (req) => {
  const { session = "regular" } = await req.json().catch(() => ({}));

  // Share the global rescan lock: if a manual rescan (or a previous alert cycle
  // that overran) is in flight, skip this tick rather than double the FMP
  // fan-out. The next 5-min fire will pick up any transition we missed.
  const jobId = `qs-alert-${Date.now()}`;
  const gotLock = await acquireRescanLock(jobId);
  if (!gotLock) {
    console.log("[qs-alert] rescan in progress — skipping this cycle");
    return new Response("", { status: 202 });
  }

  // First regular-session scan of a new ET trading day → send the once-daily
  // Market Open snapshot (all active setups, incl. carry-overs) instead of the
  // transition alerts, then re-baseline the dedup + open positions to the open
  // state. Guarded so it fires at most once per day.
  const today = etDateStr(new Date());
  const lastDigest = await getQsOpenDigestDate().catch(() => null);
  const isOpenScan = session === "regular" && lastDigest !== today;

  let scored = 0, alerted = 0;
  try {
    const regime = await getMarketRegime().catch(() => null);
    const watchlist = await listQuickswingRows();

    const scoredRows = [];
    const prevMap = {};

    for (const { sym } of watchlist) {
      try {
        const row = await scoreTickerQuickSwing(sym, { skipCache: true, marketRegime: regime });
        await putQuickswingRow(sym, row).catch(() => {}); // keep the app table fresh
        scored++;

        const prevState = await getQsAlertState(sym).catch(() => null);
        const prevVerdict = prevState?.verdict ?? null;
        prevMap[sym] = prevVerdict;
        scoredRows.push(row);
        if (isOpenScan) continue; // the open snapshot (after the loop) handles alerts + positions

        // The session (bar) date this scan represents — advances once per trading
        // day, so intraday rescans don't inflate the time-stop counter.
        const sessionDate = row.dataAsOf || today;
        let pos = prevState?.pos ?? null;
        if (pos && pos.lastSessionDate && sessionDate > pos.lastSessionDate) {
          pos = { ...pos, barsHeld: (pos.barsHeld || 0) + 1, lastSessionDate: sessionDate };
        }

        let newVerdict = prevVerdict;
        if (pos) {
          // Holding: check for a position exit (STOP → TARGET → FLIP → TIME).
          const { reason } = positionExitDecision(pos, row, QS_TIME_STOP_DAYS);
          if (reason === "FLIP") {
            await sendTelegram(formatAlert(row, row.verdict, session)); // opposite-side entry
            pos = makeAlertPosition(row, sideForVerdict(row.verdict), sessionDate);
            newVerdict = row.verdict;
            alerted++;
          } else if (reason) { // STOP / TARGET / TIME
            await sendTelegram(formatExitAlert(row, reason, pos, session));
            pos = null;
            newVerdict = row.verdict; // keep the side so we don't immediately re-enter it
            alerted++;
          }
          // else: hold — no message, keep the position
        } else {
          // Flat: fire on a fresh BUY/SELL entry, and open a position to track it.
          const { fire, kind } = alertTransition(prevVerdict, row.verdict);
          if (fire && (kind === "BUY" || kind === "SELL")) {
            await sendTelegram(formatAlert(row, kind, session));
            pos = makeAlertPosition(row, sideForVerdict(kind), sessionDate);
            alerted++;
          }
          newVerdict = row.verdict;
        }

        await putQsAlertState(sym, newVerdict, pos).catch(() => {});
      } catch (e) {
        console.error(`[qs-alert] ${sym} failed:`, e?.message || e);
      }
    }

    if (isOpenScan) {
      // One consolidated Market Open message (uses prior-close verdicts for the
      // "changes since prior close" section, so it's built BEFORE we overwrite
      // the state below).
      const res = await sendTelegram(
        formatOpenSnapshot({ rows: scoredRows, prevMap, regime, label: etClockLabel(new Date()) })
      );
      if (res?.ok) alerted = scoredRows.filter((r) => r.verdict === "BUY" || r.verdict === "SELL").length;
      // Re-baseline dedup AND open a fresh alert-position for every active setup,
      // so intraday take-profit/stop/time exits alert from the open.
      for (const row of scoredRows) {
        const side = sideForVerdict(row.verdict);
        const pos = side ? makeAlertPosition(row, side, row.dataAsOf || today) : null;
        await putQsAlertState(row.sym, row.verdict, pos).catch(() => {});
      }
      // Stamp last so a mid-snapshot crash simply re-sends next tick rather than
      // silently skipping the day's open snapshot.
      await putQsOpenDigestDate(today).catch(() => {});
    }
  } finally {
    await releaseRescanLock(jobId);
  }

  console.log(`[qs-alert] session=${session} openScan=${isOpenScan} scored=${scored} alerted=${alerted}`);
  return new Response("", { status: 202 });
};
