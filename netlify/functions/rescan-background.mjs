import { scoreTicker, fetchLivePrice } from "../lib/pipeline.mjs";
import { listWatchlist, putWatchlistRowWithHistory, patchWatchlistPrice, getWatchlistRow, putJob, deleteFmpCache } from "../lib/store.mjs";

const STALE_DAYS = 2;

export default async (req) => {
  const { jobId, force, tickers: onlyTickers, clientTickers } = await req.json().catch(() => ({}));
  if (!jobId) return new Response("Missing jobId", { status: 400 });

  const existing = await listWatchlist();

  // ── Pre-scan: detect watchlist entries poisoned by a previous CDN sym-flip ────
  // If multiple tickers share the same company name, a prior bad rescan wrote one
  // wrong company's data for all of them. Clear ONLY the FMP cache so the next fetch
  // is fresh — do NOT delete the watchlist blob entries, which ensures the blob always
  // has something for the re-fetch at the end of the scan to display consistently.
  // wipedSyms drives cleanRows: excludes poisoned entries from the knownName lookup,
  // preventing the old wrong name from being used as a reference for nameMismatch.
  const existingNameCount = {};
  for (const r of existing) {
    const n = r.name;
    if (n && n !== r.sym) existingNameCount[n] = (existingNameCount[n] || 0) + 1;
  }
  const watchlistPoisonedNames = new Set(
    Object.entries(existingNameCount).filter(([, c]) => c > 1).map(([n]) => n)
  );
  const wipedSyms = new Set();
  if (watchlistPoisonedNames.size > 0) {
    const poisonedRows = existing.filter(r => watchlistPoisonedNames.has(r.name));
    for (const r of poisonedRows) wipedSyms.add(r.sym);
    await Promise.all(poisonedRows.map(r => deleteFmpCache(r.sym).catch(() => {})));
  }

  const storedSyms = new Set(existing.map(r => r.sym));
  const extraRows = (clientTickers || [])
    .filter(sym => !storedSyms.has(sym))
    .map(sym => ({ sym }));
  const allRows = [...existing, ...extraRows];

  // cleanRows excludes poisoned entries so knownName is never set to a poisoned value.
  // When knownName is undefined, hasNameFlip cannot fire — which is the correct behavior
  // for poisoned tickers: let dedup catch a CDN-wide flip, or allow correct data through
  // when FMP has healed (enabling one-rescan recovery from a full blob poisoning).
  const cleanRows = allRows.filter(r => !wipedSyms.has(r.sym));

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
  const pendingFullWrites = [];
  for (const sym of allTickers) {
    try {
      if (fullTickers.has(sym)) {
        const storedRow = cleanRows.find(r => r.sym === sym);
        const row = await scoreTicker(sym, { knownName: storedRow?.name });
        pendingFullWrites.push({ sym, row });
        // _flipGuarded means nameMismatch fired: the row has null financials and a bare shell.
        // Show the old stored data in the interim display instead of the bare shell, so the
        // user sees their correct last-known data rather than a confusing name/score change
        // during the scan window.
        if (row._flipGuarded) {
          const displayRow = allRows.find(r => r.sym === sym) || { sym };
          rows.push(displayRow);
        } else {
          rows.push(row);
        }
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

  // ── PASS 3: Write results, skipping CDN-flipped and name-guarded entries ──────
  for (const { sym, row } of pendingFullWrites) {
    if (freshFlipNames.has(row.name) || row._flipGuarded) {
      // Either the batch dedup detected a CDN-wide flip, or the individual nameMismatch
      // guard fired for this ticker. Either way: wipe FMP cache so the next rescan
      // refetches fresh, but do NOT write to the watchlist blob — preserve whatever
      // correct data was already there.
      await deleteFmpCache(sym).catch(() => {});
    } else {
      await putWatchlistRowWithHistory(sym, row);
    }
  }

  // Replace CDN-flipped rows in the job response with { sym } placeholders so
  // the frontend doesn't display the wrong company's data. (flip-guarded rows were
  // already pushed as stored/old data in PASS 1, so they don't need replacement here.)
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
