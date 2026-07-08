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
  listQuickswingRows, listQsDaily, putQuickswingRow, putQsDailyRow,
  getQsAlertState, putQsAlertState,
  getQsOpenDigestDate, putQsOpenDigestDate,
  getQsHeartbeat, putQsHeartbeat,
  acquireRescanLock, releaseRescanLock,
} from "../lib/store.mjs";
import { QS_TIME_STOP_DAYS } from "../lib/quickswing-backtest.mjs";
import { barIsStale } from "../lib/market-calendar.mjs";
import { sendTelegram } from "../lib/telegram.mjs";
import {
  alertTransition, formatAlert, formatExitAlert,
  makeAlertPosition, positionExitDecision,
  etDateStr, etClockLabel, formatOpenSnapshot, formatOutageRoster,
} from "../lib/quickswing-alert.mjs";

const sideForVerdict = (v) => (v === "BUY" ? "long" : v === "SELL" ? "short" : null);
// A silent gap longer than this (~3 missed 5-min cycles) counts as an outage:
// on recovery we send a catch-up roster. Also the staleness bar the cron uses.
const OUTAGE_MS = 16 * 60 * 1000;

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

  // Silent-loop recovery: if our last successful run was long enough ago that the
  // loop effectively went dark, we'll send a one-time catch-up roster after this
  // scan (unless it's the open scan, which already sends the full snapshot).
  const hb = await getQsHeartbeat().catch(() => null);
  const gapMs = hb?.ts ? (Date.now() - hb.ts) : 0;
  const wasOutage = !!hb?.ts && gapMs > OUTAGE_MS;

  let scored = 0, alerted = 0, staleSkipped = 0;
  const openPositions = []; // positions open at the START of this tick (for the recovery roster)
  try {
    const regime = await getMarketRegime().catch(() => null);
    // Scan the UNION of your manual watchlist (qs-rows) + the day's auto Top-N
    // from the 9:45 Most-Active scan (qs-daily), deduped by symbol with the
    // manual list winning the tag. This is what folds the auto picks into the
    // 5-min live rescore + verdict alerts. The manual side stays first-class.
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
        // Write each fresh row back to the store(s) it belongs to, so the auto
        // list refreshes in place WITHOUT leaking auto names into the manual
        // watchlist. A name in both stays first-class in qs-rows and mirrors to
        // qs-daily so the bottom section shows the same live read.
        if (manualSet.has(sym)) await putQuickswingRow(sym, row).catch(() => {});
        if (dailySet.has(sym)) await putQsDailyRow(sym, row).catch(() => {});
        scored++;

        const prevState = await getQsAlertState(sym).catch(() => null);
        const prevVerdict = prevState?.verdict ?? null;
        prevMap[sym] = prevVerdict;
        scoredRows.push(row);
        // Snapshot positions open at the start of this tick — the recovery roster
        // (below) reviews these with live prices after a silent gap.
        if (prevState?.pos) {
          openPositions.push({
            sym, side: prevState.pos.side,
            entryPrice: prevState.pos.entryPrice, stopPrice: prevState.pos.stopPrice,
            price: row.price,
          });
        }
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
            await sendTelegram(formatAlert(row, row.verdict, session, source)); // opposite-side entry
            pos = makeAlertPosition(row, sideForVerdict(row.verdict), sessionDate);
            newVerdict = row.verdict;
            alerted++;
          } else if (reason) { // STOP / TARGET / TIME
            await sendTelegram(formatExitAlert(row, reason, pos, session, source));
            pos = null;
            newVerdict = row.verdict; // keep the side so we don't immediately re-enter it
            alerted++;
          }
          // else: hold — no message, keep the position
        } else {
          // Flat: fire on a fresh BUY/SELL entry, and open a position to track it.
          const { fire, kind } = alertTransition(prevVerdict, row.verdict);
          if (fire && (kind === "BUY" || kind === "SELL")) {
            if (barIsStale(row.dataAsOf, today)) {
              // FMP's daily bar is >=1 full session behind — the technicals are
              // frozen. Suppress the ENTRY and DON'T advance the dedup verdict, so
              // it fires for real once the feed catches up. (Exits are left alone —
              // better to act on a maybe-stale stop than to miss it.)
              staleSkipped++;
              await putQsAlertState(sym, prevVerdict, pos).catch(() => {});
              continue;
            }
            await sendTelegram(formatAlert(row, kind, session, source));
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
      // One consolidated Market Open message — scoped to your MANUAL watchlist
      // only, so it stays separate from the 9:45 Most-Active scan's own message.
      // (Uses prior-close verdicts for the "changes since prior close" section,
      // so it's built BEFORE we overwrite the state below.)
      const manualRows = scoredRows.filter((r) => manualSet.has(r.sym));
      const res = await sendTelegram(
        formatOpenSnapshot({ rows: manualRows, prevMap, regime, label: etClockLabel(new Date()) })
      );
      if (res?.ok) alerted = manualRows.filter((r) => r.verdict === "BUY" || r.verdict === "SELL").length;
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

    // Silent-loop recovery roster — once, after a real outage, on a normal tick
    // (the open scan already sends the full snapshot, so skip it there).
    if (wasOutage && !isOpenScan) {
      await sendTelegram(formatOutageRoster(openPositions, gapMs / 60000)).catch(() => {});
    }

    // Heartbeat — stamp only on a successful finish so the cron watchdog can tell
    // whether this fire-and-forget worker is actually running.
    await putQsHeartbeat({ session, scored }).catch(() => {});
  } finally {
    await releaseRescanLock(jobId);
  }

  console.log(`[qs-alert] session=${session} openScan=${isOpenScan} scored=${scored} `
    + `alerted=${alerted} staleSkipped=${staleSkipped} outageRecover=${wasOutage && !isOpenScan}`);
  return new Response("", { status: 202 });
};
