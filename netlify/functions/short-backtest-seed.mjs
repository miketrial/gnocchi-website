/* ===== SWING BACKTEST FEATURE ===== (removable — see checklist in
   netlify/lib/short-backtest.mjs)

   Lazy, on-demand historical backfill for the Swing backtest log. Called from the
   client only when the user opens the Swing Backtest popover — never during a
   rescan — so the per-ticker replay fetch (historical prices + profile + the
   ticker's sector ETF) is paid at most once per ticker, and only if someone looks.

   Seeds a small BATCH of not-yet-seeded tickers per request and reports how many
   remain, so the client loops without any single call hitting the function
   timeout. Mirrors quickswing-backtest-seed.mjs. */
import { listShortRows, getShortTrades, putShortTrades,
         getSpyHistCache, putSpyHistCache, getSectorHistCache, putSectorHistCache } from "../lib/store.mjs";
import { safe, delay } from "../lib/fmp-client.mjs";
import { cleanHist, adjustSplits } from "../lib/quickswing-pipeline.mjs";
import {
  replayShortTrades, strengthSeriesFor, ret126SeriesFor, mergeShortSeed, pruneShortWindow, needsShortSeed,
  annotateShortBenchmarks, dailySignalLog, SBT_SEED_VERSION, SBT_WINDOW_DAYS,
} from "../lib/short-backtest.mjs";

const BATCH = 5; // seed this many not-yet-seeded tickers per request; the client
                 // loops until nothing is left. Bumped from 2 → 5 now that the
                 // per-ticker profile fetch is gone (sector comes from the scored
                 // row), so 5 tickers stay well under the function timeout while
                 // roughly halving the total backfill wall-clock for a 127-name
                 // watchlist (the swing list is far larger than Bounce's ~22).

/* Sector -> ETF map — identical to short-pipeline.mjs's sectorEtfFor(). */
const INDUSTRY_ETF = { "Semiconductors": "SMH" };
const SECTOR_ETF = {
  "Technology": "XLK", "Healthcare": "XLV", "Utilities": "XLU", "Industrials": "XLI",
  "Consumer Cyclical": "XLY", "Consumer Defensive": "XLP", "Financial Services": "XLF",
  "Communication Services": "XLC", "Basic Materials": "XLB", "Energy": "XLE", "Real Estate": "XLRE",
};
const etfFor = (sector, industry) => INDUSTRY_ETF[industry] || SECTOR_ETF[sector] || null;

/* Cached index/ETF history — reuses the shared spy-hist blob store (same one the
   live scorer populates), falling back to a fetch. Request-scoped memo on top so
   a batch touching the same ETF fetches it once. */
async function getIndexHist(symbol, memo) {
  if (memo.has(symbol)) return memo.get(symbol);
  const isSpy = symbol === "SPY";
  let hist = await (isSpy ? getSpyHistCache() : getSectorHistCache(symbol)).catch(() => null);
  if (!hist) {
    const raw = await safe("historical-price-eod/full", symbol, "&limit=560"); await delay(150);
    hist = cleanHist(raw);
    if (hist.length >= 200) await (isSpy ? putSpyHistCache(hist) : putSectorHistCache(symbol, hist)).catch(() => {});
  }
  memo.set(symbol, hist);
  return hist;
}

export default async () => {
  const rows = await listShortRows().catch(() => []);
  const syms = rows.map(r => r?.sym).filter(Boolean);
  const rowBySym = new Map(rows.filter(r => r?.sym).map(r => [r.sym, r])); // sector/industry source (skips a per-ticker profile fetch)

  const pending = [];
  for (const sym of syms) {
    const log = await getShortTrades(sym).catch(() => null);
    if (needsShortSeed(log)) pending.push(sym);
  }

  const batch = pending.slice(0, BATCH);
  const seeded = [];
  if (batch.length) {
    const histMemo = new Map();          // symbol -> cleaned hist (SPY + ETFs)
    const strMemo = new Map();           // symbol -> strength series
    const spyHist = await getIndexHist("SPY", histMemo).catch(() => []);
    const spyStr = spyHist.length ? strengthSeriesFor(spyHist) : [];
    // SPY's trailing 126-session return series — the SPY leg of the v6.2 name
    // relative-strength entry gate (computed once per batch, like spyStr).
    const spyRet126 = spyHist.length ? ret126SeriesFor(spyHist) : [];
    strMemo.set("SPY", spyStr);

    for (const sym of batch) {
      try {
        // Fetch the ticker's own history. Its sector ETF comes from the already-
        // scored row (no per-ticker profile fetch → ~half the FMP calls, faster backfill).
        // 560 bars = 200-bar signal warmup + the 240-session v6 replay window + slack
        // (v6 widened SBT_SEED_SESSIONS 130→240 so ~9-month death-cross holds can
        // complete inside the visible log).
        const rawHist = await safe("historical-price-eod/full", sym, "&limit=560"); await delay(120);
        // Split/corporate-action back-adjust so the historical replay never books a
        // phantom split gap (e.g. HON 1:2 on 2026-06-29 → a spurious −47% STOP).
        const splits = await safe("splits", sym, "&limit=20").catch(() => []); await delay(120);
        const hist = adjustSplits(cleanHist(rawHist), splits);
        const r0 = rowBySym.get(sym) || {};
        const etf = etfFor(r0.sector, r0.industry);

        let sectorStr = [];
        if (etf) {
          const secHist = await getIndexHist(etf, histMemo);
          if (!strMemo.has(etf)) strMemo.set(etf, secHist.length ? strengthSeriesFor(secHist) : []);
          sectorStr = strMemo.get(etf);
        }

        const seed = replayShortTrades(sym, hist, spyStr, sectorStr, spyHist, spyRet126);

        const existing = await getShortTrades(sym).catch(() => null);
        const isReseed = existing && existing.seedVersion != null && existing.seedVersion !== SBT_SEED_VERSION;
        let next;
        if (isReseed) {
          // Calibration changed — old trades were booked under the old rule; replace.
          next = pruneShortWindow({ open: seed.open, closed: seed.closed, seeded: true, seedVersion: SBT_SEED_VERSION });
        } else {
          // First-time seed — merge the historical backfill with any forward trades.
          next = pruneShortWindow(mergeShortSeed(existing, seed));
        }
        annotateShortBenchmarks(next, spyHist);
        // Last-15-session daily BUY/SELL/HOLD notifier log — computed from the same
        // fetched hist + strength series (no extra FMP call), stored alongside the
        // trade log so the popover can show "what the signal fired recently".
        const dl = dailySignalLog(sym, hist, spyStr, sectorStr, spyRet126, { sessions: 15 });
        next.dailyLog = dl.days;
        next.sym = sym;               // the notifier render keys off this (trade log had no top-level sym)
        next.seeded = true;
        next.seedVersion = SBT_SEED_VERSION;
        await putShortTrades(sym, next);
        seeded.push(sym);
      } catch (e) {
        console.error(`[swing-bt] ${sym} lazy-seed error:`, e?.message || e);
      }
    }
  }

  const remaining = Math.max(0, pending.length - seeded.length);
  return new Response(JSON.stringify({ seeded, remaining }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
