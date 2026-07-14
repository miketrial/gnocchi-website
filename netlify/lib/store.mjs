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
const shortTradesStore = () => getStore("short-trades"); // key = TICKER, per-ticker swing paper-trade backtest log
const epsSnapStore     = () => getStore("eps-snapshots");// key = TICKER (object: {YYYY-MM-DD: fwdEps})
const qsRowStore       = () => getStore("qs-rows");      // key = TICKER, per-ticker quickswing-pipeline score blob
const qsTradesStore    = () => getStore("qs-trades");    // key = TICKER, per-ticker paper-trade backtest log
const qsFmpStore       = () => getStore("qs-fmp");       // key = TICKER, per-ticker raw FMP fan-out cache (24h TTL)
const qsAlertStore     = () => getStore("qs-alert-state");// key = TICKER, last verdict a Telegram alert was sent for (dedup)
const qsDailyStore     = () => getStore("qs-daily");     // key = TICKER, the day's auto Top-N (Most-Active scan), replaced wholesale at 9:45 ET
const qsUniverseStore  = () => getStore("qs-universe");  // key = "latest", cached resolved most-active symbol list ({ts, day, symbols})
const spyHistStore     = () => getStore("spy-hist");     // key = index/ETF symbol ("SPY", "VIX", "XLK", "SMH", ...), one shared blob per symbol per scan batch

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

/* ---------- Generic named lock ----------
   Same check-then-set as the rescan lock, but with a caller-chosen name + TTL.
   Used by the daily Most-Active scan (name "qs-daily-scan"), which can run
   ~7-8 min — longer than the 6-min rescan lock — so it needs its own longer
   lease to keep the 9:45 cron and a manual "Scan now" click from stacking a
   second 2,000-call fan-out on top of a run already in flight. */
export async function acquireLock(name, jobId, ttlMs) {
  const cur = await lockStore().get(name, { type: "json" }).catch(() => null);
  if (cur && cur.until > Date.now()) return false; // someone holds a fresh lock
  await lockStore().setJSON(name, { jobId, startedAt: Date.now(), until: Date.now() + ttlMs });
  return true;
}
export async function releaseLock(name, jobId) {
  const cur = await lockStore().get(name, { type: "json" }).catch(() => null);
  if (!cur || cur.jobId === jobId) await lockStore().delete(name).catch(() => {});
}
// Non-blocking peek: is a fresh named lock currently held? Used by the alert loop
// to avoid writing qs-daily rows while the daily scan is mid-replace.
export async function isLockHeld(name) {
  const cur = await lockStore().get(name, { type: "json" }).catch(() => null);
  return !!(cur && cur.until > Date.now());
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
    held:       (v && typeof v.held       === 'object' && !Array.isArray(v.held))       ? v.held       : {},
  };
}
export async function setWatchState({ flags, demoted, activity, sigHistory, held }) {
  await settingsStore().setJSON("watch-state", {
    flags, demoted, activity, sigHistory, held: held || {},
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

/* ---------- Swing: paper-trade backtest log ----------
   One blob per ticker: { open: {...}|null, closed: [...newest-first], seeded,
   seedVersion }. The as-if long-only trade that acting on the swing signal would
   produce. Written from the short rescan loop; read by the short-backtest
   endpoint. Removable with the SWING BACKTEST FEATURE block. */
export async function listShortTrades() {
  const s = shortTradesStore();
  const { blobs } = await s.list();
  const logs = await Promise.all(blobs.map(b => s.get(b.key, { type: "json" }).catch(() => null)));
  return logs.filter(Boolean);
}
export async function getShortTrades(ticker) {
  return shortTradesStore().get(ticker.toUpperCase(), { type: "json" }).catch(() => null);
}
export async function putShortTrades(ticker, log) {
  await shortTradesStore().setJSON(ticker.toUpperCase(), log);
}
export async function deleteShortTrades(ticker) {
  await shortTradesStore().delete(ticker.toUpperCase()).catch(() => {});
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
export async function putQsAlertState(ticker, verdict, pos = null) {
  // `verdict` = last verdict we alerted on (entry dedup). `pos` = the open
  // "alert position" (entry price/side/stop/sessions-held) the take-profit /
  // time-stop exit alert tracks; null when flat. Older blobs have no `pos`.
  await qsAlertStore().setJSON(ticker.toUpperCase(), { verdict, pos, at: new Date().toISOString() });
}
export async function deleteQsAlertState(ticker) {
  await qsAlertStore().delete(ticker.toUpperCase()).catch(() => {});
}

/* ---------- Quick Swing: Market Open snapshot dedup ----------
   The ET trading day we last sent the once-daily Market Open snapshot for. The
   alert worker sends the snapshot (and re-baselines the per-ticker alert dedup to
   the open state) on the first regular-session scan whose ET date differs from
   this — so a setup that was already BUY/SELL at the prior close is surfaced each
   morning instead of being swallowed by transition dedup. Removable with the
   QUICK SWING FEATURE block. */
export async function getQsOpenDigestDate() {
  const v = await settingsStore().get("qs-open-digest", { type: "json" }).catch(() => null);
  return v?.date ?? null;
}
export async function putQsOpenDigestDate(date) {
  await settingsStore().setJSON("qs-open-digest", { date, at: new Date().toISOString() });
}

/* ---------- Quick Swing: hourly summary snapshot ----------
   One blob ("latest") holding the market + per-ticker state captured by the most
   recent hourly summary run. The next hour's summary diffs against it to report
   "what changed in the last hour" (market direction + individual signal/price
   moves). Stamped with the ET trading day so a stale prior-day snapshot is never
   diffed against. Removable with the QUICK SWING FEATURE block. */
const qsSummaryStore = () => getStore("qs-summary-snap");
export async function getQsSummarySnapshot() {
  return qsSummaryStore().get("latest", { type: "json" }).catch(() => null);
}
export async function putQsSummarySnapshot(snap) {
  await qsSummaryStore().setJSON("latest", snap);
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

/* ---------- Quick Swing: Daily Top-N auto list (Most-Active scan) ----------
   Separate blob namespace from the manual `qs-rows` watchlist so the two lists
   stay independent: the manual list is edited only by the user; this one is
   replaced wholesale each morning by the 9:45 ET scan's top buy-scored picks.
   Same row shape as `qs-rows` (a scoreTickerQuickSwing row), so the alert loop
   and UI can consume both identically. Removable with the QUICK SWING FEATURE block. */
export async function listQsDaily() {
  const s = qsDailyStore();
  const { blobs } = await s.list();
  const rows = await Promise.all(blobs.map(b => s.get(b.key, { type: "json" }).catch(() => null)));
  return rows.filter(Boolean);
}
export async function getQsDailyRow(ticker) {
  return qsDailyStore().get(ticker.toUpperCase(), { type: "json" }).catch(() => null);
}
export async function putQsDailyRow(ticker, row) {
  await qsDailyStore().setJSON(ticker.toUpperCase(), row);
}
export async function deleteQsDailyRow(ticker) {
  await qsDailyStore().delete(ticker.toUpperCase()).catch(() => {});
}
// Atomic-ish wholesale swap: drop every existing pick, then write the new set.
// Called once at 9:45 ET so the bottom list reflects only that day's top names.
export async function replaceQsDaily(rows) {
  const s = qsDailyStore();
  const { blobs } = await s.list();
  await Promise.all(blobs.map(b => s.delete(b.key).catch(() => {})));
  await Promise.all((rows || []).map(r => s.setJSON(String(r.sym).toUpperCase(), r).catch(() => {})));
}

/* ---------- Quick Swing: cached most-active universe ----------
   The resolved list of most-active symbols the daily scan iterates. Cached
   ~20h (one blob, "latest") so a same-day re-run (manual "Scan now") reuses one
   screener call instead of re-fetching the universe. `day` is the ET trading day
   it was resolved for, so a stale prior-day list is treated as a miss. */
const QS_UNIVERSE_TTL_MS = 20 * 60 * 60 * 1000;
// Returns { symbols:[...], sectors:{SYM:sector} } or null. `sectors` powers the
// per-sector cap on the kept list without an extra fetch (the screener already
// carries sector).
export async function getQsUniverse(day = null) {
  const entry = await qsUniverseStore().get("latest", { type: "json" }).catch(() => null);
  if (!entry || !entry.ts || Date.now() - entry.ts > QS_UNIVERSE_TTL_MS) return null;
  if (day && entry.day && entry.day !== day) return null;
  return Array.isArray(entry.symbols) ? { symbols: entry.symbols, sectors: entry.sectors || {}, day: entry.day || null } : null;
}
// Accepts either a bare symbol array (back-compat) or { symbols, sectors }.
export async function putQsUniverse(data, day = null) {
  const symbols = Array.isArray(data) ? data : (data?.symbols || []);
  const sectors = Array.isArray(data) ? {} : (data?.sectors || {});
  await qsUniverseStore().setJSON("latest", { ts: Date.now(), day, symbols, sectors });
}

/* ---------- Quick Swing: health & trust (Section F) ----------
   One small blob namespace for the alert-loop heartbeat, the watchdog dedup/
   recovery state, and the daily "system OK / degraded" counters. Single-writer
   keys to avoid read-modify-write races: `heartbeat` (alert worker), `watchdog`
   (alert cron), `lastScan` (daily worker). Removable with the QUICK SWING block. */
const qsHealthStore = () => getStore("qs-health");

// Heartbeat — stamped by the alert worker on every successful finish. The cron
// reads it to tell whether the fire-and-forget worker is actually running.
export async function getQsHeartbeat() {
  return qsHealthStore().get("heartbeat", { type: "json" }).catch(() => null);
}
export async function putQsHeartbeat(data = {}) {
  await qsHealthStore().setJSON("heartbeat", { ts: Date.now(), ...data }).catch(() => {});
}

// Watchdog state — the cron's once-per-outage dedup + worst-gap-today record.
export async function getQsWatchdog() {
  return (await qsHealthStore().get("watchdog", { type: "json" }).catch(() => null)) || {};
}
export async function putQsWatchdog(state) {
  await qsHealthStore().setJSON("watchdog", state || {}).catch(() => {});
}

// Last daily-scan health snapshot — written once per scan by the daily worker,
// read by the close-of-day summary footer.
export async function getQsLastScan() {
  return qsHealthStore().get("lastScan", { type: "json" }).catch(() => null);
}
export async function putQsLastScan(data) {
  await qsHealthStore().setJSON("lastScan", { ts: Date.now(), ...data }).catch(() => {});
}

/* ---------- Quick Swing: pre-close review dedup (Section B4) ----------
   The ET trading day we last sent the once-daily ~15:50 pre-close position
   review, so it fires at most once per day. */
export async function getQsPreCloseDate() {
  const v = await settingsStore().get("qs-preclose", { type: "json" }).catch(() => null);
  return v?.date ?? null;
}
export async function putQsPreCloseDate(date) {
  await settingsStore().setJSON("qs-preclose", { date, at: new Date().toISOString() });
}

/* ---------- Quick Swing: recently-stopped marks (Section A6) ----------
   One tiny blob per ticker holding the last date a STOP fired. The daily
   discovery scan withholds a name it just stopped out of for a few sessions so
   the list doesn't keep re-buying a falling knife. Separate from qs-alert-state
   so normal state writes can't clobber it. */
const qsCooldownStore = () => getStore("qs-cooldown");
export async function putQsStopMark(ticker, date) {
  await qsCooldownStore().setJSON(ticker.toUpperCase(), { lastStopDate: date, at: new Date().toISOString() }).catch(() => {});
}
export async function listQsStopMarks() {
  const s = qsCooldownStore();
  const { blobs } = await s.list().catch(() => ({ blobs: [] }));
  const out = {};
  await Promise.all(blobs.map(async (b) => {
    const v = await s.get(b.key, { type: "json" }).catch(() => null);
    if (v?.lastStopDate) out[b.key.toUpperCase()] = v.lastStopDate;
  }));
  return out;
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

/* ---------- Shared ^VIX history cache ----------
   Same pattern as SPY: the backtest replay reconstructs the VIX multiplier as of
   each past close from ^VIX EOD history, fetched and cached ONCE per batch rather
   than per ticker. Reuses the spy-hist store under a distinct key. */
export async function getVixHistCache() {
  const entry = await spyHistStore().get("VIX", { type: "json" }).catch(() => null);
  if (!entry || !entry.ts || Date.now() - entry.ts > SPY_HIST_TTL_MS) return null;
  return entry.data;
}
export async function putVixHistCache(hist) {
  await spyHistStore().setJSON("VIX", { ts: Date.now(), data: hist });
}

/* ---------- Shared sector ETF history cache (Swing's Sector RS factor) ----------
   Same pattern as SPY/VIX above, generalized to a symbol key (SMH, XLK, XLF,
   ...) since a Swing scan batch only touches a handful of distinct sector
   ETFs (one per sector represented in the watchlist), not one per ticker.
   Reuses the spy-hist store — it's already a general "shared index history"
   cache, not SPY-specific. */
export async function getSectorHistCache(etfSymbol) {
  const entry = await spyHistStore().get(etfSymbol.toUpperCase(), { type: "json" }).catch(() => null);
  if (!entry || !entry.ts || Date.now() - entry.ts > SPY_HIST_TTL_MS) return null;
  return entry.data;
}
export async function putSectorHistCache(etfSymbol, hist) {
  await spyHistStore().setJSON(etfSymbol.toUpperCase(), { ts: Date.now(), data: hist });
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
