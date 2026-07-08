/* ===== QUICK SWING FEATURE =====
   Pure (blob-free, network-free) logic for the HOURLY Telegram summary layer:
     - summaryWindow(now): is this a top-of-hour ET slot we summarize on (weekday
       10:00–16:00 ET, covering the 09:30 open through the 16:00 close)?
     - summaryLabel(hour): the "10:00 AM ET" style label for the message header.
     - buildSnapshot({rows, regime, spyQuote, now}): compact state blob captured
       each run — market direction + per-ticker verdict/price.
     - diffSnapshots(prev, cur): what changed in the last hour (market + stocks).
     - formatSummary(diff, cur, label): the Telegram message body.

   Side-effect-free on purpose so the gating + diff rules can be unit-tested with
   synthetic snapshots and a fake `now`, no FMP / Netlify Blobs / live clock. The
   worker (quickswing-summary-background.mjs) and scheduler
   (quickswing-summary-cron.mjs) wire these to real I/O.
   Removable with the rest of the QUICK SWING FEATURE block. */
import { etParts } from "./quickswing-alert.mjs";
import { isMarketHoliday, isHalfDay } from "./market-calendar.mjs";

/* ---------- Window gating (America/New_York, DST-safe) ----------
   Fires at the top of each ET hour from 10:00 to 16:00 inclusive:
     10:00 summarizes 09:30 open → 10:00,  … , 16:00 summarizes 15:00 → close.
   Cron runs `0 * * * *` (top of every hour, UTC == ET at minute 0) and this
   gate throws away the off-session fires so they spend zero FMP. */
export function summaryWindow(now = new Date()) {
  const { weekday, hour } = etParts(now);
  const isWeekday = ["Mon", "Tue", "Wed", "Thu", "Fri"].includes(weekday);
  if (!isWeekday) return { run: false };
  const dateStr = etDate(now);
  if (isMarketHoliday(dateStr)) return { run: false };
  // Half-days close at 13:00 ET — end the summary series there.
  const lastHour = isHalfDay(dateStr) ? 13 : 16;
  if (hour >= 10 && hour <= lastHour) {
    return { run: true, etHour: hour, label: summaryLabel(hour), isClose: hour === lastHour };
  }
  return { run: false };
}

export function summaryLabel(hour) {
  const ampm = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:00 ${ampm} ET`;
}

function etDate(now = new Date()) {
  // en-CA renders YYYY-MM-DD, which is what we compare snapshots on.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
}

/* ---------- Snapshot ----------
   `rows` are the quickswing score blobs the alert worker keeps fresh every 5 min
   (we read, never re-score — the summary spends no per-ticker FMP). `regime` is
   getMarketRegime()'s output; `spyQuote` the live SPY /quote (for the day %). */
export function buildSnapshot({ rows = [], regime = null, spyQuote = null, now = new Date() } = {}) {
  const rowMap = {};
  for (const r of rows) {
    if (!r?.sym) continue;
    rowMap[r.sym] = {
      verdict: r.verdict ?? null,
      tier: r.tier ?? null,
      price: typeof r.price === "number" ? r.price : null,
      buyScore: r.buyScore ?? null,
      sellScore: r.sellScore ?? null,
    };
  }
  const { hour } = etParts(now);
  return {
    day: etDate(now),
    at: Date.now(),
    etHour: hour,
    spy: {
      // Prefer the LIVE /quote price: regime.price comes from the SPY EOD-history
      // cache (6h TTL in store.mjs), so it can lag intraday and would flatten the
      // hour-over-hour delta. The live quote is authoritative for "right now".
      price: (typeof spyQuote?.price === "number" ? spyQuote.price : (regime?.price ?? null)),
      changePct: typeof spyQuote?.changePercentage === "number" ? spyQuote.changePercentage : null,
    },
    vix: regime?.vix ? { level: regime.vix.level, label: regime.vix.label } : null,
    regimeLabel: regime?.label ?? null,
    favorable: regime?.ok ? regime.favorable : null,
    rows: rowMap,
  };
}

const MOVER_THRESHOLD_PCT = 1.0; // |Δ| ≥ 1% over the hour counts as a mover

export function diffSnapshots(prev, cur) {
  const verdictChanges = [];
  const movers = [];
  for (const [sym, c] of Object.entries(cur.rows || {})) {
    const p = prev?.rows?.[sym];
    if (p && p.verdict !== c.verdict) {
      verdictChanges.push({ sym, from: p.verdict, to: c.verdict, price: c.price });
    }
    if (p && typeof p.price === "number" && p.price > 0 && typeof c.price === "number") {
      const pct = ((c.price - p.price) / p.price) * 100;
      if (Math.abs(pct) >= MOVER_THRESHOLD_PCT) movers.push({ sym, pct, price: c.price, verdict: c.verdict });
    }
  }
  movers.sort((a, b) => Math.abs(b.pct) - Math.abs(a.pct));

  const spyHourPct = (prev && prev.spy?.price > 0 && typeof cur.spy?.price === "number")
    ? ((cur.spy.price - prev.spy.price) / prev.spy.price) * 100 : null;
  const vixHourDelta = (prev && typeof prev.vix?.level === "number" && typeof cur.vix?.level === "number")
    ? (cur.vix.level - prev.vix.level) : null;

  return {
    hasPrev: !!prev,
    market: {
      spyPrice: cur.spy?.price ?? null,
      spyDayPct: cur.spy?.changePct ?? null,
      spyHourPct,
      vixLevel: cur.vix?.level ?? null,
      vixHourDelta,
      regimeLabel: cur.regimeLabel,
      regimeChanged: !!prev && prev.regimeLabel !== cur.regimeLabel,
    },
    verdictChanges,
    movers,
  };
}

/* ---------- Message body ---------- */
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function arrow(x) { return x > 0 ? "▲" : x < 0 ? "▼" : "▬"; }
function signedPct(x) { return x == null ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`; }
function signedNum(x) { return x == null ? "n/a" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}`; }
function fmtPrice(p) { return typeof p === "number" ? `$${p.toFixed(2)}` : "n/a"; }
function verdictEmoji(v) {
  return v === "BUY" ? "🟢" : v === "SELL" ? "🔴" : v === "BLOCKED" ? "⛔️" : v === "NEUTRAL" ? "⚪️" : "▫️";
}

// `health` (optional) appends a close-of-day system line: normally a "✅ Bounce
// OK" heartbeat, or a "⚠️ FMP degraded" flag when the day's scan mostly returned
// no data. Only the summary worker's close-of-day run passes it.
export function formatSummary(diff, cur, label, health = null) {
  const m = diff.market;
  const L = [`📊 <b>Hourly Summary — ${esc(label)}</b>`];

  const spyBits = [];
  if (m.spyPrice != null) spyBits.push(`SPY $${m.spyPrice.toFixed(2)}`);
  if (m.spyDayPct != null) spyBits.push(`${arrow(m.spyDayPct)}${signedPct(m.spyDayPct)} day`);
  if (m.spyHourPct != null) spyBits.push(`${arrow(m.spyHourPct)}${signedPct(m.spyHourPct)} hr`);
  if (spyBits.length) L.push(spyBits.join(" · "));

  if (m.regimeLabel) L.push(`Trend: ${esc(m.regimeLabel)}${m.regimeChanged ? " ⚠️ <b>changed</b>" : ""}`);

  const vixBits = [];
  if (m.vixLevel != null) vixBits.push(`VIX ${m.vixLevel.toFixed(2)}`);
  if (m.vixHourDelta != null) vixBits.push(`${arrow(m.vixHourDelta)}${signedNum(m.vixHourDelta)} hr`);
  if (vixBits.length) L.push(vixBits.join(" · "));

  if (!diff.hasPrev) {
    L.push("");
    L.push("<i>Session baseline set — hour-over-hour changes begin next hour.</i>");
  }

  if (diff.verdictChanges.length) {
    L.push("");
    L.push("<b>Signal changes (last hr):</b>");
    for (const v of diff.verdictChanges) {
      L.push(`${verdictEmoji(v.to)} ${esc(v.sym)} ${esc(v.from ?? "—")}→${esc(v.to ?? "—")}  ${fmtPrice(v.price)}`);
    }
  } else if (diff.hasPrev) {
    L.push("");
    L.push("<i>No signal changes this hour.</i>");
  }

  if (diff.movers.length) {
    L.push("");
    L.push("<b>Movers (last hr):</b>");
    for (const mv of diff.movers.slice(0, 8)) {
      L.push(`${verdictEmoji(mv.verdict)} ${esc(mv.sym)} ${arrow(mv.pct)}${signedPct(mv.pct)}  ${fmtPrice(mv.price)}`);
    }
  }

  if (health) {
    L.push("");
    const gap = health.worstGapMin != null ? ` · longest silent-gap ${health.worstGapMin}m` : "";
    if (health.degraded) {
      L.push(`⚠️ <b>FMP degraded</b> — morning scan ${health.scanned ?? "?"} names, ${health.na ?? "?"} returned no data${gap}`);
    } else {
      L.push(`✅ <b>Bounce OK</b> — morning scan ${health.scanned ?? 0} names${health.na ? ` (${health.na} na)` : ""}${gap}`);
    }
  }

  return L.join("\n");
}

/* ---------- Daily Top-N message (Most-Active scan) ----------
   A SEPARATE Telegram message from the hourly watchlist summary and the 5-min
   alerts — sent once at ~9:45 ET by quickswing-daily-background.mjs. Same visual
   grammar (emoji + HTML) so it reads consistently with the rest of the Bounce
   texts, but its own header and content: the day's best buy-scored names out of
   the most-active quality-filtered universe. `rows` MUST already be ranked best-first. */
export function formatDailyTop({ rows = [], regime = null, label = "", scanned = 0, stale = false, asOfDay = null } = {}) {
  const L = [`🎯 <b>Top ${rows.length} Bounce Picks — Most Active</b>`];
  if (label) L.push(`<i>${esc(label)}</i>`);
  if (stale) L.push(`⚠️ <i>Universe stale${asOfDay ? ` (from ${esc(asOfDay)})` : ""} — screener may be down; today's movers may be missing.</i>`);

  const mBits = [];
  if (typeof regime?.price === "number") mBits.push(`SPY $${regime.price.toFixed(2)}`);
  if (regime?.label) mBits.push(esc(regime.label));
  if (typeof regime?.vix?.level === "number") mBits.push(`VIX ${regime.vix.level.toFixed(2)}`);
  if (mBits.length) L.push(mBits.join(" · "));
  if (scanned) L.push(`Scanned ${scanned} most-active names.`);

  L.push("");
  if (!rows.length) {
    L.push("<i>No qualifying names scored today.</i>");
    return L.join("\n");
  }
  rows.forEach((r, i) => {
    L.push(`${i + 1}. ${verdictEmoji(r.verdict)} <b>${esc(r.sym)}</b> ${esc(r.verdict ?? "—")}`
      + ` · buy ${esc(String(r.buyScore ?? "—"))} · ${fmtPrice(r.price)}`);
  });
  return L.join("\n");
}
