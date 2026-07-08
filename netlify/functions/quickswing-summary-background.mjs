/* ===== QUICK SWING FEATURE =====
   Hourly summary worker. READS the Quick Swing score rows the alert worker keeps
   fresh (never re-scores — spends no per-ticker FMP), pulls the current market
   regime (SPY trend + VIX) and live SPY quote, diffs against last hour's snapshot,
   and pushes one Telegram summary of what changed: market direction plus any
   individual signal (verdict) changes and notable movers. Then persists this
   hour's snapshot as next hour's baseline.

   Invoked (fire-and-forget) by quickswing-summary-cron.mjs at the top of each ET
   trading hour (10:00–16:00). Background function (name ends "-background") →
   generous runtime, though this is a light read + one market-regime fetch.
   Removable with the rest of the QUICK SWING FEATURE block. */
import { getMarketRegime } from "../lib/quickswing-pipeline.mjs";
import { safe } from "../lib/fmp-client.mjs";
import { listQuickswingRows, getQsSummarySnapshot, putQsSummarySnapshot } from "../lib/store.mjs";
import { sendTelegram } from "../lib/telegram.mjs";
import { buildSnapshot, diffSnapshots, formatSummary, summaryLabel } from "../lib/quickswing-summary.mjs";

export default async (req) => {
  const { label = "" } = await req.json().catch(() => ({}));

  try {
    const [regime, rows, spyQuoteRaw] = await Promise.all([
      getMarketRegime().catch(() => null),
      listQuickswingRows().catch(() => []),
      safe("quote", "SPY").catch(() => []),
    ]);
    const spyQuote = spyQuoteRaw?.[0] || null;

    const cur = buildSnapshot({ rows, regime, spyQuote });
    const prevRaw = await getQsSummarySnapshot().catch(() => null);
    // Only diff against a snapshot from the SAME ET trading day — a leftover
    // prior-day snapshot must never be treated as "one hour ago".
    const prev = prevRaw && prevRaw.day === cur.day ? prevRaw : null;

    const diff = diffSnapshots(prev, cur);
    const res = await sendTelegram(formatSummary(diff, cur, label || summaryLabel(cur.etHour)));
    await putQsSummarySnapshot(cur).catch(() => {});

    console.log(`[qs-summary] label=${label || summaryLabel(cur.etHour)} tickers=${Object.keys(cur.rows).length} `
      + `verdictChanges=${diff.verdictChanges.length} movers=${diff.movers.length} sent=${res?.ok === true}`);
  } catch (e) {
    console.error("[qs-summary] failed:", e?.message || e);
  }
  return new Response("", { status: 202 });
};
