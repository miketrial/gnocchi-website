/* ===== QUICK SWING FEATURE =====
   Pure (blob-free, network-free) logic for the real-time Telegram alert layer:
     - decideWindow(now): is the market in a session we alert on, and which one?
     - alertTransition(prevAlerted, newVerdict): did the verdict cross a line
       worth notifying (entry / exit), and which kind?
     - formatAlert(row, kind, session): the Telegram message body.

   Kept side-effect-free on purpose so the gating + transition rules can be
   unit-tested by injecting a fake `now` / synthetic verdict sequences, with no
   FMP calls, no Netlify Blobs, and no live clock. The worker
   (quickswing-alert-background.mjs) and the scheduler
   (quickswing-alert-cron.mjs) wire these to real I/O.
   Removable with the rest of the QUICK SWING FEATURE block. */

/* ---------- Session window gating (America/New_York, DST-safe) ----------
   Michigan is Eastern Time — same zone as the NYSE — so ET gating matches both
   the exchange and the user's local clock, DST included.
     Regular:     Mon–Fri 09:30–15:59 ET  → every fire (5-min cron).
     After-hours: Mon–Fri 16:00–20:00 ET  → only on 15-min marks (slower).
     Otherwise (premarket, overnight, weekend) → don't run, spend zero FMP.
   Premarket is intentionally excluded: the FMP plan has no premarket endpoint,
   so there is nothing to score before 09:30 ET. */
const REGULAR_OPEN_MIN = 9 * 60 + 30;   // 09:30
const REGULAR_CLOSE_MIN = 16 * 60;      // 16:00
const AH_CLOSE_MIN = 20 * 60;           // 20:00

export function etParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const weekday = get("weekday");                 // "Mon".."Sun"
  const hour = Number(get("hour")) % 24;          // guard "24" at midnight
  const minute = Number(get("minute"));
  return { weekday, hour, minute, minutesOfDay: hour * 60 + minute };
}

export function decideWindow(now = new Date()) {
  const { weekday, minutesOfDay } = etParts(now);
  const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday);
  if (!isWeekday) return { run: false, session: null };

  if (minutesOfDay >= REGULAR_OPEN_MIN && minutesOfDay < REGULAR_CLOSE_MIN) {
    return { run: true, session: "regular" };
  }
  if (minutesOfDay >= REGULAR_CLOSE_MIN && minutesOfDay <= AH_CLOSE_MIN) {
    // After-hours: throttle the 5-min cron down to every 15 minutes.
    const onQuarterHour = (minutesOfDay % 15) === 0;
    return onQuarterHour ? { run: true, session: "afterhours" } : { run: false, session: null };
  }
  return { run: false, session: null };
}

/* ---------- Verdict transition → alert decision ----------
   `prevAlerted` = the verdict we last SENT a Telegram alert for (from the
   qs-alert-state blob), or null on first sight. Fires on:
     non-BUY  → BUY   : fresh long entry
     non-SELL → SELL  : fresh short entry (also covers a BUY→SELL direction flip)
     BUY/SELL → NEUTRAL|BLOCKED : the open call cooled off — exit
   Same-side repeats (BUY→BUY, SELL→SELL) and non-actionable churn
   (NEUTRAL→BLOCKED, null→NEUTRAL, etc.) do not fire. `changed` tells the
   caller whether to refresh the stored state even when no alert is sent. */
export function alertTransition(prevAlerted, newVerdict) {
  const changed = prevAlerted !== newVerdict;
  if (newVerdict === "BUY" && prevAlerted !== "BUY") return { fire: true, kind: "BUY", changed };
  if (newVerdict === "SELL" && prevAlerted !== "SELL") return { fire: true, kind: "SELL", changed };
  const wasOpen = prevAlerted === "BUY" || prevAlerted === "SELL";
  const nowFlat = newVerdict === "NEUTRAL" || newVerdict === "BLOCKED";
  if (wasOpen && nowFlat) return { fire: true, kind: "EXIT", changed };
  return { fire: false, kind: null, changed };
}

/* ---------- Message body ---------- */
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function fmtPrice(p) {
  return p == null ? "n/a" : `$${Number(p).toFixed(2)}`;
}

export function formatAlert(row, kind, session = "regular") {
  const prefix = session === "afterhours" ? "🌙 AH " : "";
  const sym = esc(row?.sym ?? "?");
  const price = fmtPrice(row?.price);
  const lines = [];

  if (kind === "BUY" || kind === "SELL") {
    const emoji = kind === "BUY" ? "🟢" : "🔴";
    const tier = row?.tier ? ` (${esc(row.tier)})` : "";
    lines.push(`${prefix}${emoji} <b>${sym} — ${kind}</b>${tier}`);
    lines.push(`Buy ${esc(row?.buyScore ?? "?")} · Sell ${esc(row?.sellScore ?? "?")}`);
    lines.push(`Price ${price}${row?.priceIsLive ? " (live)" : ""}`);
    if (row?.stop?.price != null) {
      const pct = row.stop.pctFromEntry != null ? ` (${row.stop.pctFromEntry > 0 ? "+" : ""}${row.stop.pctFromEntry}%)` : "";
      lines.push(`Stop ${fmtPrice(row.stop.price)}${pct} · ${esc(row.stop.basis ?? "")}`);
    }
    if (row?.agreement?.label) lines.push(esc(row.agreement.label));
  } else {
    // EXIT
    const why = row?.verdict === "BLOCKED"
      ? `BLOCKED${row?.blockedReason ? ` — ${esc(row.blockedReason)}` : ""}`
      : "cooled to NEUTRAL";
    lines.push(`${prefix}⚪️ <b>${sym} — EXIT</b>`);
    lines.push(`Verdict ${why}`);
    lines.push(`Price ${price}${row?.priceIsLive ? " (live)" : ""}`);
  }
  return lines.join("\n");
}
