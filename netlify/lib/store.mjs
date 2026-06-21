import { getStore } from "@netlify/blobs";

// Blob namespaces in Netlify Blobs.
const watchlistStore   = () => getStore("watchlist");    // key = TICKER
const netStore         = () => getStore("net");          // key = id
const jobsStore        = () => getStore("jobs");         // key = jobId
const fmpCacheStore    = () => getStore("fmp-cache");    // key = TICKER, TTL 24h
const layer2CacheStore = () => getStore("layer2-cache"); // key = TICKER, TTL 7d
const lockStore        = () => getStore("locks");        // key = lock name
const usageStore       = () => getStore("usage");        // key = haiku-<YYYY-MM-DD>

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

/* ---------- Rescan concurrency lock ----------
   Prevents overlapping rescans from stacking — the main driver of runaway
   FMP/Anthropic cost is rapid repeated clicks firing parallel full scans.
   Lock auto-expires after RESCAN_LOCK_MS (just over the 15-min background-fn
   ceiling won't matter; we use 6 min so a crashed scan can't wedge forever).
   NOTE: check-then-set is not perfectly atomic across simultaneous cold starts,
   but it eliminates the realistic double-click / double-fire case. */
const RESCAN_LOCK_MS = 6 * 60 * 1000;
export async function acquireRescanLock(jobId) {
  const cur = await lockStore().get("rescan", { type: "json" }).catch(() => null);
  if (cur && cur.until > Date.now()) return false; // someone holds a fresh lock
  await lockStore().setJSON("rescan", { jobId, startedAt: Date.now(), until: Date.now() + RESCAN_LOCK_MS });
  return true;
}
export async function releaseRescanLock(jobId) {
  const cur = await lockStore().get("rescan", { type: "json" }).catch(() => null);
  if (!cur || cur.jobId === jobId) await lockStore().delete("rescan").catch(() => {});
}

/* ---------- Anthropic spend circuit-breaker ----------
   Hard daily ceiling on Haiku web-search calls (the only paid Anthropic usage).
   Each Layer-2 call ≈ $0.12, so the default cap of 50 bounds the worst case to
   roughly $6/day no matter how many rescans fire. Override via HAIKU_DAILY_CAP. */
const HAIKU_DAILY_CAP = Number(process.env.HAIKU_DAILY_CAP || 50);
const haikuKey = () => "haiku-" + new Date().toISOString().slice(0, 10);
export function haikuCap() { return HAIKU_DAILY_CAP; }
export async function getHaikuUsage() {
  const v = await usageStore().get(haikuKey(), { type: "json" }).catch(() => null);
  return v?.count || 0;
}
export async function incrHaikuUsage() {
  const k = haikuKey();
  const cur = await usageStore().get(k, { type: "json" }).catch(() => null);
  const count = (cur?.count || 0) + 1;
  await usageStore().setJSON(k, { count, updated: Date.now() }).catch(() => {});
  return count;
}

/* ---------- Watchlist row schema validation / normalization ----------
   One malformed blob write (truncated, wrong shape, partial sym-flip) must not
   be able to crash the table render. normalizeWatchlistRow() guarantees every
   field the frontend reads exists with a safe default; a row with no usable
   ticker symbol is unrecoverable and returns null (quarantined). */
const asStr = (v, d = "") => (typeof v === "string" ? v : d);
const asArr = v => (Array.isArray(v) ? v : []);
export function normalizeWatchlistRow(row, keyTicker) {
  if (!row || typeof row !== "object") return null;
  const sym = asStr(row.sym, "").toUpperCase() || asStr(keyTicker, "").toUpperCase();
  if (!sym) return null; // no symbol → cannot render or key; quarantine
  return {
    ...row,
    sym,
    name:     asStr(row.name, sym),
    v:        asArr(row.v),
    score:    asStr(row.score, "—"),
    reasons:  asArr(row.reasons),
    ar:       asStr(row.ar, ""),
    arGrades: asArr(row.arGrades),
    vs:       asStr(row.vs, "N/M"),
    vsc:      asStr(row.vsc, "n"),
    fwd:      asStr(row.fwd, "N/M"),
    ttm:      asStr(row.ttm, "N/M"),
    yr5:      asStr(row.yr5, "N/M"),
    ft:       asStr(row.ft, "—"),
    ftc:      asStr(row.ftc, "x"),
    ps:       asStr(row.ps, "N/M"),
    trend:    asStr(row.trend, ""),
    exp:      asStr(row.exp, ""),
    cat:      asStr(row.cat, ""),
  };
}

/* ---------- watchlist ---------- */
export async function listWatchlist() {
  const s = watchlistStore();
  const { blobs } = await s.list();
  const raw = await Promise.all(blobs.map(b => s.get(b.key, { type: "json" }).catch(() => null)));
  const rows = [];
  let quarantined = 0;
  raw.forEach((r, i) => {
    const n = normalizeWatchlistRow(r, blobs[i]?.key);
    if (n) rows.push(n);
    else if (r != null) quarantined++;
  });
  if (quarantined) console.warn(`[watchlist] quarantined ${quarantined} malformed row(s) on read`);
  return rows;
}
export async function getWatchlistRow(ticker) {
  const raw = await watchlistStore().get(ticker.toUpperCase(), { type: "json" }).catch(() => null);
  return normalizeWatchlistRow(raw, ticker);
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
