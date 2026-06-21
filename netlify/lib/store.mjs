import { getStore } from "@netlify/blobs";

// Three namespaces in Netlify Blobs.
const watchlistStore   = () => getStore("watchlist");    // key = TICKER
const netStore         = () => getStore("net");          // key = id
const jobsStore        = () => getStore("jobs");         // key = jobId
const fmpCacheStore    = () => getStore("fmp-cache");    // key = TICKER, TTL 24h
const layer2CacheStore = () => getStore("layer2-cache"); // key = TICKER, TTL 7d

/* ---------- FMP cache (24h TTL) ---------- */
const FMP_TTL_MS = 24 * 60 * 60 * 1000;
export async function getFmpCache(ticker) {
  const entry = await fmpCacheStore().get(ticker.toUpperCase(), { type: "json" }).catch(() => null);
  if (!entry || !entry.ts || Date.now() - entry.ts > FMP_TTL_MS) return null;
  return entry.data;
}
export async function putFmpCache(ticker, data) {
  await fmpCacheStore().setJSON(ticker.toUpperCase(), { ts: Date.now(), data });
}
export async function deleteFmpCache(ticker) {
  await fmpCacheStore().delete(ticker.toUpperCase()).catch(() => {});
}

/* ---------- Layer 2 cache (7-day TTL) ---------- */
const LAYER2_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export async function getLayer2Cache(ticker) {
  const entry = await layer2CacheStore().get(ticker.toUpperCase(), { type: "json" }).catch(() => null);
  if (!entry || !entry.ts || Date.now() - entry.ts > LAYER2_TTL_MS) return null;
  return entry.data;
}
export async function putLayer2Cache(ticker, data) {
  await layer2CacheStore().setJSON(ticker.toUpperCase(), { ts: Date.now(), data });
}
export async function deleteLayer2Cache(ticker) {
  await layer2CacheStore().delete(ticker.toUpperCase()).catch(() => {});
}

/* ---------- watchlist ---------- */
export async function listWatchlist() {
  const s = watchlistStore();
  const { blobs } = await s.list();
  const rows = await Promise.all(blobs.map(b => s.get(b.key, { type: "json" })));
  return rows.filter(Boolean);
}
export async function getWatchlistRow(ticker) {
  return watchlistStore().get(ticker.toUpperCase(), { type: "json" });
}
export async function putWatchlistRow(ticker, row) {
  await watchlistStore().setJSON(ticker.toUpperCase(), row);
}
export async function putWatchlistRowWithHistory(ticker, newRow) {
  const existing = await getWatchlistRow(ticker.toUpperCase()).catch(() => null);
  let history = existing?.history || [];
  if (existing?.score && existing?.scored_at) {
    history = [{ score: existing.score, scored_at: existing.scored_at }, ...history];
  }
  // Remove history entries from the same calendar day as the new scan —
  // the new scan is already the most recent for today (stored on the row itself).
  const newDay = newRow.scored_at ? newRow.scored_at.slice(0, 10) : null;
  if (newDay) history = history.filter(h => h.scored_at?.slice(0, 10) !== newDay);
  // Deduplicate within history: keep only newest per day (array is newest-first).
  const seenDays = new Set();
  history = history.filter(h => {
    const day = h.scored_at?.slice(0, 10);
    if (!day || seenDays.has(day)) return false;
    seenDays.add(day);
    return true;
  });
  await watchlistStore().setJSON(ticker.toUpperCase(), { ...newRow, history: history.slice(0, 50) });
}
export async function deleteWatchlistRow(ticker) {
  await watchlistStore().delete(ticker.toUpperCase());
}
export async function patchWatchlistPrice(ticker, { price, volume, avgVolume } = {}) {
  const existing = await getWatchlistRow(ticker.toUpperCase()).catch(() => null);
  if (!existing) return;
  await watchlistStore().setJSON(ticker.toUpperCase(), {
    ...existing,
    price,
    ...(volume    != null ? { volume }      : {}),
    ...(avgVolume != null ? { avg_volume: avgVolume } : {}),
    price_updated_at: new Date().toISOString(),
  });
}

/* ---------- net ---------- */
export async function listNet() {
  const s = netStore();
  const { blobs } = await s.list();
  const rows = await Promise.all(blobs.map(b => s.get(b.key, { type: "json" })));
  return rows.filter(Boolean);
}
export async function putNetRow(row) {
  const id = row.id || crypto.randomUUID();
  const saved = { ...row, id };
  await netStore().setJSON(id, saved);
  return saved;
}
export async function deleteNetRow(id) {
  await netStore().delete(id);
}

/* ---------- jobs ---------- */
export async function putJob(jobId, job) {
  await jobsStore().setJSON(jobId, job);
}
export async function getJob(jobId) {
  return jobsStore().get(jobId, { type: "json" });
}
