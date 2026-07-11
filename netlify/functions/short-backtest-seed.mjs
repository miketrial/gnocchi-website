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
import { cleanHist } from "../lib/quickswing-pipeline.mjs";
import {
  replayShortTrades, strengthSeriesFor, mergeShortSeed, pruneShortWindow, needsShortSeed,
  annotateShortBenchmarks, dailySignalLog, SBT_SEED_VERSION, SBT_WINDOW_DAYS,
} from "../lib/short-backtest.mjs";

const BATCH = 2; // swing replays are heavier than Bounce's (130-session vs 15) —
                 // keep the batch small so a cold-start call stays well under the
                 // function timeout; the client loops until nothing is left.

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
    const raw = await safe("historical-price-eod/full", symbol, "&limit=420"); await delay(150);
    hist = cleanHist(raw);
    if (hist.length >= 200) await (isSpy ? putSpyHistCache(hist) : putSectorHistCache(symbol, hist)).catch(() => {});
  }
  memo.set(symbol, hist);
  return hist;
}

export default async () => {
  const rows = await listShortRows().catch(() => []);
  const syms = rows.map(r => r?.sym).filter(Boolean);

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
    strMemo.set("SPY", spyStr);

    for (const sym of batch) {
      try {
        // Fetch the ticker's own history + profile (for its sector ETF).
        const rawHist = await safe("historical-price-eod/full", sym, "&limit=420"); await delay(150);
        const hist = cleanHist(rawHist);
        const profile = await safe("profile", sym); await delay(120);
        const p0 = profile?.[0] || {};
        const etf = etfFor(p0.sector, p0.industry);

        let sectorStr = [];
        if (etf) {
          const secHist = await getIndexHist(etf, histMemo);
          if (!strMemo.has(etf)) strMemo.set(etf, secHist.length ? strengthSeriesFor(secHist) : []);
          sectorStr = strMemo.get(etf);
        }

        const seed = replayShortTrades(sym, hist, spyStr, sectorStr, spyHist);

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
        const dl = dailySignalLog(sym, hist, spyStr, sectorStr, { sessions: 15 });
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
