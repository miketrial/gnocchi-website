import { scoreTicker, fetchLivePrice } from "../lib/pipeline.mjs";
import { listWatchlist, putWatchlistRowWithHistory, patchWatchlistPrice, getWatchlistRow, putJob, deleteFmpCache } from "../lib/store.mjs";

const STALE_DAYS = 2;

export default async (req) => {
  const { jobId, force, tickers: onlyTickers, clientTickers } = await req.json().catch(() => ({}));
  if (!jobId) return new Response("Missing jobId", { status: 400 });

  const existing = await listWatchlist();

  // ── Pre-scan: clear FMP cache for any tickers poisoned by a prior CDN sym-flip ──
  // If multiple tickers share the same company name in the blob, a prior bad rescan
  // wrote one wrong company's data for all of them. Clear their FMP cache so this
  // scan fetches fresh data rather than serving the poisoned cache entry.
  const existingNameCount = {};
  for (const r of existing) {
    const n = r.name;
    if (n && n !== r.sym) existingNameCount[n] = (existingNameCount[n] || 0) + 1;
  }
  const watchlistPoisonedNames = new Set(
    Object.entries(existingNameCount).filter(([, c]) => c > 1).map(([n]) => n)
  );
  if (watchlistPoisonedNames.size > 0) {
    const poisonedRows = existing.filter(r => watchlistPoisonedNames.has(r.name));
    await Promise.all(poisonedRows.map(r => deleteFmpCache(r.sym).catch(() => {})));
  }

  const storedSyms = new Set(existing.map(r => r.sym));
  const extraRows = (clientTickers || [])
    .filter(sym => !storedSyms.has(sym))
    .map(sym => ({ sym }));
  const allRows = [...existing, ...extraRows];

  const cutoff = Date.now() - STALE_DAYS * 24 * 60 * 60 * 1000;

  const fullPool = (onlyTickers && onlyTickers.length)
    ? onlyTickers.map(sym => allRows.find(r => r.sym === sym) || { sym })
    : force
      ? allRows
      : allRows.filter(r => !r.scored_at || new Date(r.scored_at).getTime() < cutoff || r.avg_volume == null);
  const fullTickers = new Set(fullPool.map(r => r.sym));

  const allTickers = allRows.map(r => r.sym);
  const total = allTickers.length;
  const rows = [];
  await putJob(jobId, { status: "running", total, completed: 0, rows });

  // ── PASS 1: Score all tickers; collect full-rescore rows without writing yet ──
  // Trust FMP data directly — the individual knownName guard was removed because it
  // caused a deadlock when the blob itself was poisoned with wrong company names:
  // the guard would block the healed FMP data from fixing the stale blob entry.
  // CDN-wide flips are caught by the batch dedup in PASS 2 instead.
  const pendingFullWrites = [];
  for (const sym of allTickers) {
    try {
      if (fullTickers.has(sym)) {
        const row = await scoreTicker(sym);
        pendingFullWrites.push({ sym, row });
        rows.push(row);
      } else {
        const quote = await fetchLivePrice(sym);
        if (quote != null) await patchWatchlistPrice(sym, quote);
        const stored = await getWatchlistRow(sym);
        rows.push(stored ? { ...stored, price: quote?.price ?? stored.price } : { sym });
      }
    } catch (e) {
      rows.push({ sym, error: String(e.message || e) });
    }
    await putJob(jobId, { status: "running", total, completed: rows.length, rows });
  }

  // ── PASS 2: CDN flip detection ────────────────────────────────────────────────
  // If multiple tickers in this batch returned the same company name, FMP's CDN is
  // currently serving one company's data for all requests. Don't write those rows.
  const freshNameCount = {};
  for (const { row } of pendingFullWrites) {
    const n = row.name;
    if (n && n !== row.sym) freshNameCount[n] = (freshNameCount[n] || 0) + 1;
  }
  const freshFlipNames = new Set(
    Object.entries(freshNameCount).filter(([, c]) => c > 1).map(([n]) => n)
  );

  // ── PASS 3: Write results, skipping CDN-flipped entries ──────────────────────
  for (const { sym, row } of pendingFullWrites) {
    if (freshFlipNames.has(row.name)) {
      // Batch dedup detected a CDN-wide flip — don't write stale data.
      await deleteFmpCache(sym).catch(() => {});
    } else {
      await putWatchlistRowWithHistory(sym, row);
    }
  }

  // Replace CDN-flipped rows in the final job response with { sym } placeholders
  // so the frontend doesn't display the wrong company's data in the post-scan view.
  if (freshFlipNames.size > 0) {
    for (let i = 0; i < rows.length; i++) {
      if (rows[i].name && freshFlipNames.has(rows[i].name)) {
        rows[i] = { sym: rows[i].sym };
      }
    }
  }

  await putJob(jobId, { status: "done", total, completed: rows.length, rows });
  return new Response("", { status: 202 });
};
