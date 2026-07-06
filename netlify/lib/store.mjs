import { getStore } from "@netlify/blobs";

// Blob namespaces in Netlify Blobs.
const watchlistStore   = () => getStore("watchlist");    // key = TICKER
const netStore         = () => getStore("net");          // key = id
const jobsStore        = () => getStore("jobs");         // key = jobId
const fmpCacheStore    = () => getStore("fmp-cache");    // key = TICKER, TTL 24h
const layer2CacheStore = () => getStore("layer2-cache"); // key = TICKER, TTL 7d
const lockStore        = () => getStore("locks");        // key = lock name
const usageStore       = () => getStore("usage");        // key = haiku-<YYYY-MM-DD>
const settingsStore    = () => getStore("settings");     // key = setting name
const shortRowStore    = () => getStore("short-rows");   // key = TICKER, per-ticker short-pipeline score blob
const shortFmpStore    = () => getStore("short-fmp");    // key = TICKER, per-ticker raw FMP fan-out cache (24h TTL)
const epsSnapStore     = () => getStore("eps-snapshots");// key = TICKER (object: {YYYY-MM-DD: fwdEps})
const qsRowStore       = () => getStore("qs-rows");      // key = TICKER, per-ticker quickswing-pipeline score blob
const qsTradesStore    = () => getStore("qs-trades");    // key = TICKER, per-ticker paper-trade backtest log
const qsFmpStore       = () => getStore("qs-fmp");       // key = TICKER, per-ticker raw FMP fan-out cache (24h TTL)
const qsAlertStore     = () => getStore("qs-alert-state");// key = TICKER, last verdict a Telegram alert was sent for (dedup)
const spyHistStore     = () => getStore("spy-hist");     // key = "SPY", one shared blob for the whole scan batch

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
   Each Layer-2 call ≈ $0.12, so the default cap of 150 bounds the worst case to
   roughly $18/day no matter how many rescans fire. Override via HAIKU_DAILY_CAP. */
const HAIKU_DAILY_CAP = Number(process.env.HAIKU_DAILY_CAP || 150);
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

/* ---------- Pinned tickers (server-side, shared across devices) ---------- */
export async function getWatchState() {
  const v = await settingsStore().get("watch-state", { type: "json" }).catch(() => null);
  return {
    flags:      (v && typeof v.flags      === 'object' && !Array.isArray(v.flags))      ? v.flags      : {},
    demoted:    (v && typeof v.demoted    === 'object' && !Array.isArray(v.demoted))    ? v.demoted    : {},
    activity:   Array.isArray(v?.activity) ? v.activity : [],
    sigHistory: (v && typeof v.sigHistory === 'object' && !Array.isArray(v.sigHistory)) ? v.sigHistory : {},
  };
}
export async function setWatchState({ flags, demoted, activity, sigHistory }) {
  await settingsStore().setJSON("watch-state", {
    flags, demoted, activity, sigHistory,
    updated: Date.now(),
  });
}

export async function getPins() {
  const v = await settingsStore().get("pins", { type: "json" }).catch(() => null);
  return Array.isArray(v?.pins) ? v.pins : [];
}
export async function setPins(pins) {
  const clean = Array.isArray(pins)
    ? [...new Set(pins.filter(s => typeof s === "string" && s).map(s => s.toUpperCase()))]
    : [];
  await settingsStore().setJSON("pins", { pins: clean, updated: Date.now() });
  return clean;
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

/* ---------- Short Term: per-ticker score blobs ---------- */
export async function listShortRows() {
  const s = shortRowStore();
  const { blobs } = await s.list();
  const rows = await Promise.all(blobs.map(b => s.get(b.key, { type: "json" }).catch(() => null)));
  return rows.filter(Boolean);
}
export async function getShortRow(ticker) {
  return shortRowStore().get(ticker.toUpperCase(), { type: "json" }).catch(() => null);
}
export async function putShortRow(ticker, row) {
  await shortRowStore().setJSON(ticker.toUpperCase(), row);
}
export async function deleteShortRow(ticker) {
  await shortRowStore().delete(ticker.toUpperCase()).catch(() => {});
}

/* ---------- Short Term: raw FMP fan-out cache (separate from basics) ---------- */
const SHORT_FMP_TTL_MS = 24 * 60 * 60 * 1000;
export async function getShortFmpCache(ticker) {
  const entry = await shortFmpStore().get(ticker.toUpperCase(), { type: "json" }).catch(() => null);
  if (!entry || !entry.ts || Date.now() - entry.ts > SHORT_FMP_TTL_MS) return null;
  return entry.data;
}
export async function putShortFmpCache(ticker, data) {
  await shortFmpStore().setJSON(ticker.toUpperCase(), { ts: Date.now(), data });
}
export async function deleteShortFmpCache(ticker) {
  await shortFmpStore().delete(ticker.toUpperCase()).catch(() => {});
}

/* ---------- Quick Swing: per-ticker score blobs ---------- */
export async function listQuickswingRows() {
  const s = qsRowStore();
  const { blobs } = await s.list();
  const rows = await Promise.all(blobs.map(b => s.get(b.key, { type: "json" }).catch(() => null)));
  return rows.filter(Boolean);
}
export async function getQuickswingRow(ticker) {
  return qsRowStore().get(ticker.toUpperCase(), { type: "json" }).catch(() => null);
}
export async function putQuickswingRow(ticker, row) {
  await qsRowStore().setJSON(ticker.toUpperCase(), row);
}
export async function deleteQuickswingRow(ticker) {
  await qsRowStore().delete(ticker.toUpperCase()).catch(() => {});
}

/* ---------- Quick Swing: paper-trade backtest log ----------
   One blob per ticker: { open: {...}|null, closed: [...newest-first] }. Records
   the "as-if" trade that would result from acting on the BUY/exit verdicts.
   Written from the rescan loop; read by the quickswing-backtest endpoint.
   Removable with the rest of the QUICK SWING FEATURE block. */
export async function listQuickswingTrades() {
  const s = qsTradesStore();
  const { blobs } = await s.list();
  const logs = await Promise.all(blobs.map(b => s.get(b.key, { type: "json" }).catch(() => null)));
  return logs.filter(Boolean);
}
export async function getQuickswingTrades(ticker) {
  return qsTradesStore().get(ticker.toUpperCase(), { type: "json" }).catch(() => null);
}
export async function putQuickswingTrades(ticker, log) {
  await qsTradesStore().setJSON(ticker.toUpperCase(), log);
}
export async function deleteQuickswingTrades(ticker) {
  await qsTradesStore().delete(ticker.toUpperCase()).catch(() => {});
}

/* ---------- Quick Swing: Telegram alert dedup state ----------
   One tiny blob per ticker holding the last verdict we actually *sent* a
   Telegram alert for. The alert cron diffs the freshly-scored verdict against
   this so a still-open BUY doesn't re-notify every 5 minutes — only genuine
   transitions (entry / exit) fire. Removable with the QUICK SWING FEATURE block. */
export async function getQsAlertState(ticker) {
  return qsAlertStore().get(ticker.toUpperCase(), { type: "json" }).catch(() => null);
}
export async function putQsAlertState(ticker, verdict) {
  await qsAlertStore().setJSON(ticker.toUpperCase(), { verdict, at: new Date().toISOString() });
}
export async function deleteQsAlertState(ticker) {
  await qsAlertStore().delete(ticker.toUpperCase()).catch(() => {});
}

/* ---------- Quick Swing: raw FMP fan-out cache (separate from Short Term) ---------- */
const QS_FMP_TTL_MS = 24 * 60 * 60 * 1000;
export async function getQuickswingFmpCache(ticker) {
  const entry = await qsFmpStore().get(ticker.toUpperCase(), { type: "json" }).catch(() => null);
  if (!entry || !entry.ts || Date.now() - entry.ts > QS_FMP_TTL_MS) return null;
  return entry.data;
}
export async function putQuickswingFmpCache(ticker, data) {
  await qsFmpStore().setJSON(ticker.toUpperCase(), { ts: Date.now(), data });
}
export async function deleteQuickswingFmpCache(ticker) {
  await qsFmpStore().delete(ticker.toUpperCase()).catch(() => {});
}

/* ---------- Shared SPY history cache ----------
   Every ticker in a Quick Swing scan needs the same SPY series (for RS-vs-
   market and the market-regime gate) — fetched and cached ONCE per batch
   instead of once per ticker. Short TTL since it's cheap to refresh and we'd
   rather have same-day-fresh index data than stretch a 24h cache. */
const SPY_HIST_TTL_MS = 6 * 60 * 60 * 1000;
export async function getSpyHistCache() {
  const entry = await spyHistStore().get("SPY", { type: "json" }).catch(() => null);
  if (!entry || !entry.ts || Date.now() - entry.ts > SPY_HIST_TTL_MS) return null;
  return entry.data;
}
export async function putSpyHistCache(hist) {
  await spyHistStore().setJSON("SPY", { ts: Date.now(), data: hist });
}

/* ---------- EPS estimate snapshots (for 30-day revision detection) ----------
   Stored as { "YYYY-MM-DD": fwdEpsNumber, ... } per ticker. On each scan, we
   write today's value and look back ~30 days to detect direction of change. */
export async function getEpsSnapshot(ticker) {
  return (await epsSnapStore().get(ticker.toUpperCase(), { type: "json" }).catch(() => null)) || {};
}
export async function recordEpsSnapshot(ticker, fwdEps) {
  if (fwdEps == null || !isFinite(fwdEps)) return;
  const t = ticker.toUpperCase();
  const today = new Date().toISOString().slice(0, 10);
  const cur = await getEpsSnapshot(t);
  cur[today] = fwdEps;
  // Trim anything older than 120 days — we only need ~30-day lookback
  const cutoff = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);
  const cleaned = Object.fromEntries(Object.entries(cur).filter(([d]) => d >= cutoff));
  await epsSnapStore().setJSON(t, cleaned);
}
