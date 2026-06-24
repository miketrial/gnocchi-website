import { scoreTickerShort } from "../lib/short-pipeline.mjs";
import { listWatchlist, putShortRow, putJob, acquireRescanLock, releaseRescanLock } from "../lib/store.mjs";

const STALE_HOURS = 12;

export default async (req) => {
  const { jobId, force, tickers: onlyTickers, clientTickers } = await req.json().catch(() => ({}));
  if (!jobId) return new Response("Missing jobId", { status: 400 });

  // Reuse the same rescan lock as basics — only one rescan (basics or short)
  // runs at a time. Prevents stacked FMP fan-outs from chewing through quota.
  const gotLock = await acquireRescanLock(jobId);
  if (!gotLock) {
    await putJob(jobId, { status: "error", error: "A rescan is already in progress — try again in a moment." });
    return new Response("", { status: 202 });
  }

  try {
    return await runShortScan({ jobId, force, onlyTickers, clientTickers });
  } finally {
    await releaseRescanLock(jobId);
  }
};

async function runShortScan({ jobId, force, onlyTickers, clientTickers }) {
  // Build ticker list from server watchlist + any client-only tickers
  const existing = await listWatchlist();
  const storedSyms = new Set(existing.map(r => r.sym));
  const extraSyms = (clientTickers || []).filter(s => !storedSyms.has(s));
  const allSyms = [...existing.map(r => r.sym), ...extraSyms];

  const cutoff = Date.now() - STALE_HOURS * 60 * 60 * 1000;

  // Which tickers to actually re-score
  const targets = (onlyTickers && onlyTickers.length)
    ? onlyTickers
    : force
      ? allSyms
      : allSyms; // short scans are cheap — always refresh all tickers for simplicity

  const total = allSyms.length;
  const rows = [];
  await putJob(jobId, { status: "running", total, completed: 0, rows });

  for (const sym of allSyms) {
    // In single-ticker mode, only push rows we actually scored. Bare {sym}
    // placeholders would overwrite the client's existing row with empty data.
    if (!targets.includes(sym)) continue;
    try {
      const skipCache = !!force || !!(onlyTickers && onlyTickers.length);
      const row = await scoreTickerShort(sym, { skipCache });
      await putShortRow(sym, row).catch(() => {});
      rows.push(row);
    } catch (e) {
      rows.push({ sym, error: String(e?.message || e) });
    }
    await putJob(jobId, { status: "running", total, completed: rows.length, rows });
  }

  await putJob(jobId, { status: "done", total, completed: rows.length, rows });
  return new Response("", { status: 202 });
}
