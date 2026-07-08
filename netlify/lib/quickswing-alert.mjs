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

/* ---------- Live position exit (take-profit / stop / time) ----------
   The alert worker tracks the entry it told you to take (an "alert position" on
   the qs-alert-state blob) and pings you to EXIT using the SAME rule the paper-
   trade backtest books (quickswing-backtest.mjs v11): priority STOP → TARGET →
   FLIP → TIME. The threshold constants are imported from the backtest module by
   the worker so the two can't drift.

   One deliberate difference from the backtest: TARGET here fires on the live
   INTRADAY price crossing back above entry (a long), not the daily close — so the
   ping is timely ("you're green, book it") rather than end-of-day. FLIP is
   surfaced by the worker as the opposite-side entry alert, so it's not messaged
   here as a separate exit. */
export function makeAlertPosition(row, side, sessionDate) {
  return {
    side,                                   // "long" | "short"
    entryPrice: row?.price ?? null,
    entryDate: sessionDate ?? null,
    entrySessionDate: sessionDate ?? null,
    lastSessionDate: sessionDate ?? null,
    barsHeld: 0,
    stopPrice: row?.stop?.price ?? null,    // the 2.5×ATR stop the scorer already computed
  };
}

export function positionExitDecision(pos, row, timeStopDays = 3) {
  if (!pos) return { reason: null };
  const price = row?.price;
  if (!(price > 0)) return { reason: null };
  const long = pos.side === "long";
  if (pos.stopPrice != null && (long ? price <= pos.stopPrice : price >= pos.stopPrice)) return { reason: "STOP" };
  if (pos.entryPrice != null && (long ? price > pos.entryPrice : price < pos.entryPrice)) return { reason: "TARGET" };
  if (long ? row?.verdict === "SELL" : row?.verdict === "BUY") return { reason: "FLIP" };
  if ((pos.barsHeld ?? 0) >= timeStopDays) return { reason: "TIME" };
  return { reason: null };
}

export function formatExitAlert(row, reason, pos, session = "regular") {
  const prefix = session === "afterhours" ? "🌙 AH " : "";
  const sym = esc(row?.sym ?? "?");
  const long = pos?.side === "long";
  const label = reason === "TARGET" ? "took profit" : reason === "STOP" ? "stopped out" : reason === "TIME" ? "timed out" : "exit";
  const emoji = reason === "TARGET" ? "✅" : reason === "STOP" ? "🛑" : "⚪️";
  const price = fmtPrice(row?.price);
  const lines = [`${prefix}${emoji} <b>${sym} — EXIT</b> (${label})`];
  if (pos?.entryPrice != null && row?.price != null) {
    const pl = ((row.price - pos.entryPrice) / pos.entryPrice) * 100 * (long ? 1 : -1);
    lines.push(`${long ? "Long" : "Short"} ${fmtPrice(pos.entryPrice)} → ${price}${row?.priceIsLive ? " (live)" : ""} (${pl >= 0 ? "+" : ""}${pl.toFixed(2)}%)`);
  } else {
    lines.push(`Price ${price}${row?.priceIsLive ? " (live)" : ""}`);
  }
  return lines.join("\n");
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
    if (row?.agreement?.of) lines.push(`${row.agreement.count}/${row.agreement.of} agree`);
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

/* ---------- Market Open snapshot ----------
   Once per trading day, on the first regular-session scan, the worker sends ONE
   consolidated snapshot of every active BUY/SELL setup instead of relying on the
   transition dedup (which stays silent on a name that was already BUY at the
   prior close — the reason a carried-over KLAC never texted). After the snapshot
   the worker re-baselines the per-ticker dedup to the open state, so the rest of
   the day runs on normal transition alerts. All pure/formatting here; the worker
   wires it to the blob state + Telegram. */

export function etDateStr(now = new Date()) {
  // en-CA renders YYYY-MM-DD — the ET trading-day key we de-dupe the snapshot on.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

export function etClockLabel(now = new Date()) {
  const { hour, minute } = etParts(now);
  const ampm = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${String(minute).padStart(2, "0")} ${ampm} ET`;
}

function sideOf(v) { return v === "BUY" ? "BUY" : v === "SELL" ? "SELL" : "FLAT"; }
function scoreNum(s) { const n = parseInt(String(s ?? "").split("/")[0], 10); return isFinite(n) ? n : 0; }

/* Overnight changes: diff each ticker's current verdict-side against the side we
   last alerted on (prior close, from qs-alert-state). Only side changes among
   {BUY, SELL, FLAT} count — NEUTRAL↔BLOCKED churn is both FLAT, so it's ignored. */
export function openSnapshotChanges(prevMap = {}, rows = []) {
  const changes = [];
  for (const row of rows) {
    const from = sideOf(prevMap[row.sym] ?? null);
    const to = sideOf(row.verdict);
    if (from !== to) changes.push({ sym: row.sym, from, to });
  }
  return changes;
}

function changeLine(ch) {
  const sym = esc(ch.sym);
  if (ch.from === "FLAT" && ch.to === "BUY") return `🟢 ${sym} entered BUY`;
  if (ch.from === "FLAT" && ch.to === "SELL") return `🔴 ${sym} entered SELL`;
  if (ch.from === "BUY" && ch.to === "FLAT") return `⚪️ ${sym} exited BUY`;
  if (ch.from === "SELL" && ch.to === "FLAT") return `⚪️ ${sym} exited SELL`;
  return `🔄 ${sym} ${esc(ch.from)}→${esc(ch.to)}`; // direction flip
}

function detailBlock(row, side) {
  const emoji = side === "BUY" ? "🟢" : "🔴";
  const tier = row?.tier ? ` · ${esc(row.tier)}` : "";
  const agree = row?.agreement?.of ? ` · ${row.agreement.count}/${row.agreement.of} agree` : "";
  const live = row?.priceIsLive ? " (live)" : "";
  let stop = "";
  if (row?.stop?.price != null) {
    const pct = row.stop.pctFromEntry != null ? ` (${row.stop.pctFromEntry > 0 ? "+" : ""}${row.stop.pctFromEntry}%)` : "";
    stop = ` · stop ${fmtPrice(row.stop.price)}${pct} · ${esc(row.stop.basis ?? "")}`;
  }
  return [
    "",
    `${emoji} <b>${esc(row?.sym ?? "?")}</b>${tier}`,
    `Buy ${esc(row?.buyScore ?? "?")} · Sell ${esc(row?.sellScore ?? "?")}${agree}`,
    `${fmtPrice(row?.price)}${live}${stop}`,
  ];
}

export function formatOpenSnapshot({ rows = [], prevMap = {}, regime = null, label = "" } = {}) {
  const buys = rows.filter(r => r?.verdict === "BUY").sort((a, b) => scoreNum(b.buyScore) - scoreNum(a.buyScore));
  const sells = rows.filter(r => r?.verdict === "SELL").sort((a, b) => scoreNum(b.sellScore) - scoreNum(a.sellScore));
  const changes = openSnapshotChanges(prevMap, rows);

  const L = [`🔔 <b>Market Open — ${esc(label)}</b>`];

  if (regime?.ok) {
    const fav = regime.favorable ? "🟢 REGIME FAVORABLE" : "🔴 REGIME UNFAVORABLE";
    const dist = regime.distributionDays != null ? ` · DIST ${regime.distributionDays}/25` : "";
    const vix = regime.vix && regime.vix.level != null
      ? ` · VIX ${Number(regime.vix.level).toFixed(1)} ${String(regime.vix.label ?? "").toUpperCase()}`.trimEnd()
      : "";
    L.push(`${fav}${dist}${vix}`);
  }
  L.push(`🟢 <b>${buys.length} BUY</b> · 🔴 <b>${sells.length} SELL</b>`);

  // Changes since prior close (top, per user request).
  L.push("");
  if (changes.length) {
    L.push("<b>Changes since prior close:</b>");
    for (const ch of changes) L.push(changeLine(ch));
  } else {
    L.push("<i>No signal changes since prior close.</i>");
  }

  // One-line roster for the quick glance.
  L.push("");
  L.push(`<b>BUYS:</b> ${buys.length ? buys.map(r => esc(r.sym)).join(" ") : "—"}`);
  L.push(`<b>SELLS:</b> ${sells.length ? sells.map(r => esc(r.sym)).join(" ") : "—"}`);

  // Detail blocks, sorted by conviction (Buy score for BUYS, Sell score for SELLS).
  if (buys.length) {
    L.push("");
    L.push("━━ 🟢 <b>BUYS</b> ━━");
    for (const r of buys) L.push(...detailBlock(r, "BUY"));
  }
  if (sells.length) {
    L.push("");
    L.push("━━ 🔴 <b>SELLS</b> ━━");
    for (const r of sells) L.push(...detailBlock(r, "SELL"));
  }
  if (!buys.length && !sells.length) {
    L.push("");
    L.push("<i>No active BUY or SELL setups at the open.</i>");
  }
  return L.join("\n");
}
