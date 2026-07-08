/* ===== QUICK SWING FEATURE =====
   Static NYSE trading calendar — full closures and half-days (1:00pm ET close).
   Used to (a) stop the alert / summary / daily crons from firing on a closed
   day, (b) end the regular session early on a half-day, and (c) tell the
   stale-EOD-bar guard what the most recent completed session should be.

   REVIEW ANNUALLY — extend the tables each December. FAIL-SAFE by design: an
   unknown future date is treated as a NORMAL trading day. We would rather scan
   on a real holiday we forgot to list (wasteful) than silently suppress a real
   trading day (harmful). All dates are ET calendar days "YYYY-MM-DD", matching
   etDateStr(). Pure / no imports, so nothing in the qs layer can create a cycle.
   Removable with the rest of the QUICK SWING FEATURE block. */

// Full closures (market shut).
const HOLIDAYS = new Set([
  // 2026
  "2026-01-01", // New Year's Day
  "2026-01-19", // MLK Jr. Day
  "2026-02-16", // Washington's Birthday
  "2026-04-03", // Good Friday
  "2026-05-25", // Memorial Day
  "2026-06-19", // Juneteenth
  "2026-07-03", // Independence Day (observed — Jul 4 is Sat)
  "2026-09-07", // Labor Day
  "2026-11-26", // Thanksgiving
  "2026-12-25", // Christmas
  // 2027
  "2027-01-01", // New Year's Day
  "2027-01-18", // MLK Jr. Day
  "2027-02-15", // Washington's Birthday
  "2027-03-26", // Good Friday
  "2027-05-31", // Memorial Day
  "2027-06-18", // Juneteenth (observed — Jun 19 is Sat)
  "2027-07-05", // Independence Day (observed — Jul 4 is Sun)
  "2027-09-06", // Labor Day
  "2027-11-25", // Thanksgiving
  "2027-12-24", // Christmas (observed — Dec 25 is Sat)
]);

// Early closes — regular session ends 13:00 ET.
const HALF_DAYS = new Set([
  "2026-11-27", // day after Thanksgiving
  "2026-12-24", // Christmas Eve
  "2027-11-26", // day after Thanksgiving
]);

export function isMarketHoliday(dateStr) { return HOLIDAYS.has(dateStr); }
export function isHalfDay(dateStr) { return HALF_DAYS.has(dateStr); }

// Day-of-week (0=Sun..6=Sat) via a noon-UTC anchor so there's no timezone drift.
function dow(dateStr) { return new Date(dateStr + "T12:00:00Z").getUTCDay(); }
export function isWeekend(dateStr) { const d = dow(dateStr); return d === 0 || d === 6; }
export function isTradingDay(dateStr) { return !isWeekend(dateStr) && !isMarketHoliday(dateStr); }

// Regular-session close in ET minutes-of-day (13:00 on half-days, else 16:00).
export function marketCloseMinET(dateStr) { return isHalfDay(dateStr) ? 13 * 60 : 16 * 60; }

// The trading day strictly before dateStr (skips weekends + holidays). Bounded
// so an unexpected table gap can't loop forever.
export function previousTradingDay(dateStr) {
  let d = new Date(dateStr + "T12:00:00Z");
  for (let i = 0; i < 14; i++) {
    d = new Date(d.getTime() - 86400000);
    const s = d.toISOString().slice(0, 10);
    if (isTradingDay(s)) return s;
  }
  return dateStr; // fail-safe
}

// True when the newest EOD bar (dataAsOf) is OLDER than the previous completed
// trading session relative to todayStr — i.e. FMP is >=1 full session behind.
// Conservative: intraday, hist[0] is either today (in-progress) or the prior
// session, both >= previousTradingDay(today), so this never false-positives in
// normal operation — only when the daily feed is genuinely stuck.
export function barIsStale(dataAsOf, todayStr) {
  if (!dataAsOf || !todayStr) return false;
  return dataAsOf < previousTradingDay(todayStr);
}
