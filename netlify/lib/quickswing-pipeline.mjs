/* ---------- Quick Swing (1-2 day mean-reversion) pipeline ----------
   Pure FMP — zero Anthropic calls. A different trade philosophy from
   short-pipeline.mjs: that one is trend-following ("price is going up, buy
   the pullback, ride it for weeks"). This one is mean-reversion ("price is
   stretched too far from normal, bet on a snap-back over 1-2 days") — lower
   hit-rate by nature, so it leans on tighter stops and hard gates instead of
   graduated scoring for the riskiest conditions (earnings, illiquidity).

   Each check returns { points: 0-3 | null, verdict, summary, value }, same
   shape as short-pipeline.mjs. Score = sum of points across 9 checks, out
   of 27. Two additional checks are pass/fail GATES (earnings blackout,
   liquidity floor) — a gate failure excludes the ticker from this view
   entirely rather than just docking points, because a 1-2 day hold can't
   absorb an earnings gap or a wide bid/ask the way a multi-week hold can.

   Factor 9 (after-hours move) is post-close only — confirmed via FMP that
   aftermarket-quote is a real, live endpoint, but there is no separate
   premarket endpoint on this plan (premarket-quote/premarket-trade both
   404, same signature as a deliberately bogus endpoint name; corroborated
   by a web search turning up no documented premarket route). Revisit if
   FMP ever adds one.

   Every factor is computed from data already fetched elsewhere in the app
   (historical-price-eod/full + earnings) — confirmed against FMP's live API
   that there is no native Bollinger Bands, ATR, Relative-Strength-rank, or
   distribution-day endpoint, so all of this is self-computed arithmetic, not
   a new data source. The one new fetch is SPY's own price history, needed
   for relative-strength-vs-market and the market-regime gate — fetched ONCE
   per scan batch (see getMarketRegime) and shared across every ticker,
   not re-fetched per ticker.

   ---------- REMOVAL CHECKLIST (if this feature doesn't earn its keep) ----------
   Delete, in order:
     1. netlify/lib/quickswing-pipeline.mjs        (this file)
     2. netlify/functions/quickswing-rescan-background.mjs
     3. netlify/functions/quickswing-watchlist.mjs
     3b. netlify/functions/quickswing-delete.mjs
     4. netlify.toml — remove the block between the
        "===== QUICK SWING FEATURE =====" / "===== END QUICK SWING FEATURE ====="
        comment markers
     5. netlify/lib/store.mjs — remove the "Quick Swing: per-ticker score
        blobs", "Quick Swing: raw FMP fan-out cache", and "Shared SPY history
        cache" sections (each is delimited by its own header comment)
     6. index.html — grep for QUICK SWING and remove every marked HTML/JS/CSS
        block (start and end markers are paired, one feature per pair)
     7. Optional cleanup: delete the "qs-rows", "qs-fmp", and "spy-hist" Netlify
        Blobs stores (Netlify dashboard → Blobs) — stale data, not referenced
        by anything else once the above is gone.
   NOT removable without also touching short-pipeline.mjs (shared, keep):
     netlify/lib/ta-helpers.mjs, netlify/lib/fmp-client.mjs — short-pipeline.mjs
     depends on these too; they pre-date nothing here breaking if quickswing
     goes away, just stop being imported by two files instead of one. */
import {
  getQuickswingFmpCache, putQuickswingFmpCache, deleteQuickswingFmpCache,
  getSpyHistCache, putSpyHistCache,
} from "./store.mjs";
import { round2, na, scored, trueRange, atrFrom } from "./ta-helpers.mjs";
import { safe, delay } from "./fmp-client.mjs";

/* ---------- Sanity gates (reject implausible values before they reach a chip) ---------- */
function sane(value, min, max) {
  if (value == null || !isFinite(value)) return null;
  return (value >= min && value <= max) ? value : null;
}

/* One price-history point is valid only if it has a well-formed ISO date and
   a finite, strictly-positive close. Mirrors short-pipeline.mjs's guard. */
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validPricePoint(date, close) {
  if (typeof date !== "string" || !ISO_DATE_RE.test(date)) return false;
  const t = new Date(date + "T00:00:00Z").getTime();
  if (Number.isNaN(t)) return false;
  return Number.isFinite(close) && close > 0;
}

/* Build a clean, deduped, newest-first OHLCV array from FMP's raw hist feed.
   Every downstream check reads from this, never from the raw fetch. */
function cleanHist(hist) {
  const seen = new Set();
  const out = [];
  for (const d of hist || []) {
    const date = d?.date;
    const close = d?.price ?? d?.close;
    if (!validPricePoint(date, close)) continue;
    if (seen.has(date)) continue;
    seen.add(date);
    out.push({ date, close, high: d?.high ?? close, low: d?.low ?? close, volume: d?.volume ?? null });
  }
  out.sort((a, b) => b.date.localeCompare(a.date)); // newest first
  return out;
}

/* ---------- 1. RSI(2) — oversold/overbought extremity ----------
   Simple-average gains/losses (Cutler's RSI), not Wilder's smoothing — same
   "keep it simple" call as the ATR choice in short-pipeline.mjs. RSI(2) is
   Larry Connors' short-horizon variant: far more reactive than the standard
   14-day RSI, tuned to catch 1-2 day extremes rather than multi-week trend. */
function checkRsi2(hist) {
  const n = 2;
  if (!hist || hist.length < n + 1) return na("Need 3 days of price history");
  let gains = 0, losses = 0;
  for (let i = 0; i < n; i++) {
    const chg = hist[i].close - hist[i + 1].close;
    if (chg > 0) gains += chg; else losses += -chg;
  }
  const avgGain = gains / n, avgLoss = losses / n;
  const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  let points, label;
  if (rsi <= 5)       { points = 3; label = "deeply oversold"; }
  else if (rsi <= 10) { points = 2; label = "oversold"; }
  else if (rsi <= 20) { points = 1; label = "stretched down"; }
  else                { points = 0; label = "not stretched"; }
  return scored(points, `RSI(2) ${rsi.toFixed(1)} — ${label}`, rsi);
}

/* ---------- 2. Bollinger %B(20, 2σ) — how far outside its own normal range ----------
   %B < 0 means price is below the lower band; the more negative, the more
   stretched. Population standard deviation (divide by N, not N-1) — the
   convention most charting platforms use since it describes the exact
   window, not a sample estimate of a larger population. */
function checkBollinger(hist) {
  const n = 20;
  if (!hist || hist.length < n) return na("Need 20 days of price history");
  const closes = hist.slice(0, n).map(d => d.close);
  const sma = closes.reduce((s, x) => s + x, 0) / n;
  const variance = closes.reduce((s, x) => s + (x - sma) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  const upper = sma + 2 * sd, lower = sma - 2 * sd;
  const price = closes[0];
  const pctB = upper === lower ? 0.5 : (price - lower) / (upper - lower);
  let points, label;
  if (pctB <= 0)        { points = 3; label = "below lower band"; }
  else if (pctB <= 0.1) { points = 2; label = "hugging lower band"; }
  else if (pctB <= 0.25){ points = 1; label = "lower half of band"; }
  else                  { points = 0; label = "middle/upper band"; }
  return scored(points, `%B ${pctB.toFixed(2)} — ${label}`, { pctB, sma, upper, lower });
}

/* ---------- 3. Volume climax — exhaustion read, not accumulation read ----------
   Inverse of short-pipeline's Vol Surge check: for a 1-2 day mean-reversion
   bet, a huge volume spike on a DOWN day often marks capitulation/exhaustion
   (the sellers who were going to sell, already have) rather than "more
   selling to come." A spike on an UP day after a stretch of down days reads
   as a possible reversal already underway. */
function checkVolumeClimax(hist) {
  if (!hist || hist.length < 21) return na("Need 21 days of volume history");
  const h0 = hist[0], h1 = hist[1];
  if (h0.volume == null || h1.volume == null) return na("Missing recent volume bar");
  const vols = hist.slice(1, 21).map(d => d.volume).filter(v => v != null && v > 0);
  if (vols.length < 15) return na("Volume history too sparse");
  const avg20 = vols.reduce((s, x) => s + x, 0) / vols.length;
  const rv = sane(h0.volume / avg20, 0, 50);
  if (rv == null) return na("Volume ratio out of plausible range — data suspect");
  const isDown = h0.close < h1.close;
  const isUp = h0.close > h1.close;
  let points, label;
  if (rv >= 2.5 && isDown)      { points = 3; label = "climactic selling — likely capitulation"; }
  else if (rv >= 1.5 && isDown) { points = 2; label = "heavy selling, watch for exhaustion"; }
  else if (rv >= 1.5 && isUp)   { points = 1; label = "high volume up day — could be the bounce"; }
  else                          { points = 0; label = "no climax signal"; }
  return scored(points, `Last session ${rv.toFixed(2)}x avg, ${isDown ? "down" : isUp ? "up" : "flat"} — ${label}`, rv);
}

/* ---------- 4. Reversal candle — did buyers show up intraday? ----------
   Position of the close within the day's own high-low range. A close near
   the day's high after a red day is a rough "buyers stepped in" tell —
   needs the high/low we get from the "full" (not "light") FMP feed. */
function checkReversalCandle(hist) {
  if (!hist || hist.length < 2) return na("Need 2 days of price history");
  const h0 = hist[0], h1 = hist[1];
  const range = h0.high - h0.low;
  if (!(range > 0)) return na("Zero-range session — data suspect");
  const posInRange = (h0.close - h0.low) / range;
  const priorWasDown = h1.close < (hist[2]?.close ?? h1.close);
  let points, label;
  if (posInRange >= 0.8 && priorWasDown)      { points = 3; label = "closed at highs after a down day — strong reversal tell"; }
  else if (posInRange >= 0.6 && priorWasDown) { points = 2; label = "closed upper half after a down day"; }
  else if (posInRange >= 0.8)                 { points = 1; label = "closed at highs, no prior down day"; }
  else                                        { points = 0; label = "no reversal tell"; }
  return scored(points, `Closed ${(posInRange * 100).toFixed(0)}% up the day's range — ${label}`, posInRange);
}

/* ---------- 5. Relative Strength vs SPY (simplified) ----------
   IBD-style weighted return — 40% weight on the most recent 3 months, 20%
   each on 6/9/12 months — computed for the ticker AND for SPY, then just
   compared. This is the SIMPLIFIED version: a true IBD "RS Rating" is a
   percentile rank against the entire market (thousands of tickers scored
   the same way), which is a market-wide batch job. This just answers "is
   this ticker beating the index," which is enough context for a swing
   entry without needing to score every stock in existence on every scan. */
export function strengthFactor(hist) {
  if (!hist || hist.length < 64) return null; // need at least the 3-month leg
  const roc = n => (hist[0] && hist[n]) ? hist[0].close / hist[n].close - 1 : null;
  const r63 = roc(63), r126 = roc(126), r189 = roc(189), r252 = roc(252);
  // Degrade gracefully with shorter history: use whatever legs are available,
  // re-normalizing weights rather than failing outright.
  const legs = [[r63, 0.4], [r126, 0.2], [r189, 0.2], [r252, 0.2]].filter(([v]) => v != null);
  if (!legs.length) return null;
  const totalW = legs.reduce((s, [, w]) => s + w, 0);
  return legs.reduce((s, [v, w]) => s + v * (w / totalW), 0);
}
function checkRelativeStrength(hist, spyHist) {
  const tickerStrength = strengthFactor(hist);
  const spyStrength = spyHist ? strengthFactor(spyHist) : null;
  if (tickerStrength == null || spyStrength == null) return na("Need 3+ months of price history (ticker and SPY)");
  const delta = tickerStrength - spyStrength;
  let points, label;
  if (delta >= 0.15)      { points = 3; label = "strongly beating the market"; }
  else if (delta >= 0.05) { points = 2; label = "beating the market"; }
  else if (delta >= -0.05){ points = 1; label = "roughly in line with the market"; }
  else                    { points = 0; label = "lagging the market"; }
  return scored(points, `${(delta >= 0 ? "+" : "")}${(delta * 100).toFixed(1)}pp vs SPY — ${label}`, { tickerStrength, spyStrength, delta });
}

/* ---------- 6. Volume dry-up — quiet before the move ----------
   Counterintuitively bullish setup context: low volume during a
   consolidation (nobody's selling) often precedes a breakout better than a
   volume spike does. Compares the most recent 5 days' avg volume against
   the 20 days before that. */
function checkVolumeDryUp(hist) {
  if (!hist || hist.length < 26) return na("Need 26 days of volume history");
  const recent = hist.slice(0, 5).map(d => d.volume).filter(v => v != null && v > 0);
  const baseline = hist.slice(5, 25).map(d => d.volume).filter(v => v != null && v > 0);
  if (recent.length < 4 || baseline.length < 15) return na("Volume history too sparse");
  const avgRecent = recent.reduce((s, x) => s + x, 0) / recent.length;
  const avgBaseline = baseline.reduce((s, x) => s + x, 0) / baseline.length;
  const ratio = sane(avgRecent / avgBaseline, 0, 20);
  if (ratio == null) return na("Volume ratio out of plausible range — data suspect");
  let points, label;
  if (ratio <= 0.5)      { points = 3; label = "volume has dried up sharply — coiling"; }
  else if (ratio <= 0.7) { points = 2; label = "volume contracting"; }
  else if (ratio <= 0.9) { points = 1; label = "mild volume contraction"; }
  else                   { points = 0; label = "no dry-up — normal or rising volume"; }
  return scored(points, `Last 5d volume ${(ratio * 100).toFixed(0)}% of prior 20d avg — ${label}`, ratio);
}

/* ---------- 7. ADR% — Average Daily Range, a volatility-band gate ----------
   Qullamaggie-style: rank/filter candidates by how much they typically move
   per day. Too low = not enough movement to matter for a 1-2 day trade; too
   high = whipsaw risk that swamps a tight stop. Sweet spot, not "more is
   always better." */
function checkAdr(hist) {
  const n = 20;
  if (!hist || hist.length < n) return na("Need 20 days of price history");
  const days = hist.slice(0, n).filter(d => d.high > 0 && d.low > 0 && d.close > 0);
  if (days.length < 15) return na("Insufficient range data");
  const adrPct = days.reduce((s, d) => s + (d.high - d.low) / d.close, 0) / days.length * 100;
  let points, label;
  if (adrPct >= 3 && adrPct <= 8)       { points = 3; label = "sweet spot for a 1-2 day swing"; }
  else if (adrPct >= 2 && adrPct < 3)   { points = 1; label = "a bit quiet for a fast trade"; }
  else if (adrPct > 8 && adrPct <= 12)  { points = 1; label = "wide — whipsaw risk"; }
  else                                  { points = 0; label = adrPct < 2 ? "too quiet — won't move enough" : "too wild — stop will get run through"; }
  return scored(points, `ADR ${adrPct.toFixed(1)}% — ${label}`, adrPct);
}

/* ---------- 8. Liquidity — same $-volume convention as short-pipeline.mjs ---------- */
function checkLiquidity(hist) {
  if (!hist || hist.length < 20) return na("Need 20 days of price history");
  const dollarVols = hist.slice(0, 20).map(d => d.close * (d.volume ?? 0)).filter(v => v > 0);
  if (!dollarVols.length) return na("No volume data");
  const avgDollarVol = dollarVols.reduce((s, x) => s + x, 0) / dollarVols.length;
  const fmt = n => n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : `$${(n / 1e6).toFixed(1)}M`;
  let points;
  if (avgDollarVol >= 100_000_000)     points = 3;
  else if (avgDollarVol >= 20_000_000) points = 2;
  else if (avgDollarVol >= 10_000_000) points = 1;
  else                                 points = 0;
  const label = points === 3 ? "highly liquid" : points === 2 ? "liquid" : points === 1 ? "marginal" : "too thin for a fast in/out";
  return scored(points, `20-day avg $-volume ${fmt(avgDollarVol)} (${label})`, avgDollarVol);
}

/* ---------- 9. After-hours move — did something change the story after the close? ----------
   A large post-close move (news, guidance, M&A rumor) re-prices the setup
   before tomorrow's open — a 1-2 day hold can't just ignore that the way a
   multi-week hold might. A sharp drop adds to the "stretched" read, same
   spirit as RSI(2)/Bollinger; a sharp pop still gets a little credit,
   mirroring checkVolumeClimax's asymmetric down > up treatment (the bounce
   this system is looking for may already be starting). Post-close only —
   see the file header for why there's no premarket leg. */
function checkAfterHoursMove(hist, ahQuote) {
  const regularClose = hist?.[0]?.close;
  if (!regularClose) return na("Need today's regular-session close");
  if (!ahQuote) return na("No after-hours quote available");
  const AH_STALE_MS = 18 * 60 * 60 * 1000; // stale = leftover from a prior session, not tonight's
  if (!ahQuote.timestamp || Date.now() - ahQuote.timestamp > AH_STALE_MS) {
    return na("After-hours quote is stale — outside today's post-close session");
  }
  const bid = ahQuote.bidPrice, ask = ahQuote.askPrice;
  const ahPrice = (bid != null && ask != null) ? (bid + ask) / 2 : (ask ?? bid);
  if (!(ahPrice > 0)) return na("No usable after-hours price");
  const chg = (ahPrice - regularClose) / regularClose;
  let points, label;
  if (chg <= -0.05)        { points = 3; label = "sharp after-hours drop — more stretched into tomorrow"; }
  else if (chg <= -0.03)   { points = 2; label = "notable after-hours weakness"; }
  else if (chg <= -0.015)  { points = 1; label = "mild after-hours weakness"; }
  else if (chg >= 0.03)    { points = 1; label = "after-hours pop — bounce may already be starting"; }
  else                     { points = 0; label = "after-hours flat"; }
  return scored(points, `${chg >= 0 ? "+" : ""}${(chg * 100).toFixed(1)}% after-hours — ${label}`, { ahPrice, regularClose, chg });
}

/* ---------- GATE: Earnings blackout ----------
   A hard block, not a graduated score. A 1-2 day hold can't absorb an
   earnings gap the way a multi-week hold can — this excludes the ticker
   from the view entirely inside the blackout window rather than just
   docking points. */
function earningsGate(earningsHist) {
  if (!earningsHist || !earningsHist.length) return { blocked: false, reason: "No earnings calendar data" };
  const today = new Date().toISOString().slice(0, 10);
  const future = earningsHist
    .filter(e => e.epsActual == null && e.date > today)
    .sort((a, b) => a.date.localeCompare(b.date));
  const next = future[0];
  if (!next) return { blocked: false, reason: "No upcoming earnings date in FMP calendar" };
  const daysUntil = Math.ceil((new Date(next.date) - Date.now()) / 86400000);
  const BLACKOUT_DAYS = 5;
  if (daysUntil <= BLACKOUT_DAYS) {
    return { blocked: true, reason: `Earnings in ${daysUntil}d (${next.date}) — inside the blackout window for a 1-2 day hold`, daysUntil, date: next.date };
  }
  return { blocked: false, reason: `Earnings in ${daysUntil}d (${next.date}) — outside blackout window`, daysUntil, date: next.date };
}

/* ---------- Market regime (SPY-level, computed ONCE per scan batch) ----------
   CANSLIM's "M" — don't fight the tape. This is a portfolio-wide gate, not
   a per-ticker factor: scoring "is SPY above its own 200DMA" separately for
   every ticker in a scan would just repeat the same answer N times. Also
   computes IBD-style distribution days (index down ≥0.2% on higher volume
   than the prior day, rolling 25-session window, a day dropping off early
   if the index is currently >5% above that day's close). */
function distributionDayCount(hist) {
  if (!hist || hist.length < 26) return null;
  const currentClose = hist[0].close;
  let count = 0;
  for (let i = 0; i < 25 && i + 1 < hist.length; i++) {
    const today = hist[i], prior = hist[i + 1];
    if (today.volume == null || prior.volume == null) continue;
    const pctChg = (today.close - prior.close) / prior.close;
    const isDistribution = pctChg <= -0.002 && today.volume > prior.volume;
    if (!isDistribution) continue;
    // IBD rule: a distribution day stops counting once price trades 5% above
    // that day's close — the market has already moved past that warning.
    const expired = currentClose > today.close * 1.05;
    if (!expired) count++;
  }
  return count;
}
export async function getMarketRegime() {
  let spyHist = await getSpyHistCache().catch(() => null);
  if (!spyHist) {
    const raw = await safe("historical-price-eod/full", "SPY", "&limit=320");
    spyHist = cleanHist(raw);
    if (spyHist.length >= 200) await putSpyHistCache(spyHist).catch(() => {});
  }
  if (!spyHist || spyHist.length < 200) {
    return { ok: false, reason: "Insufficient SPY history", hist: spyHist };
  }
  const closes = spyHist.map(d => d.close);
  const sma50 = closes.slice(0, 50).reduce((s, x) => s + x, 0) / 50;
  const sma200 = closes.slice(0, 200).reduce((s, x) => s + x, 0) / 200;
  const price = closes[0];
  const distDays = distributionDayCount(spyHist);
  const uptrend = price > sma50 && sma50 > sma200;
  let label;
  if (uptrend && distDays <= 3)      label = "healthy uptrend — favorable for swing longs";
  else if (uptrend && distDays <= 5) label = "uptrend but distribution building — caution";
  else if (uptrend)                 label = "uptrend under pressure — 6+ distribution days";
  else                               label = "SPY below its own trend — swing longs disfavored";
  return {
    ok: true, price, sma50, sma200, uptrend, distributionDays: distDays,
    favorable: uptrend && distDays <= 5, label, hist: spyHist,
  };
}

/* ---------- Main entry point ---------- */
export async function scoreTickerQuickSwing(ticker, { skipCache = false, marketRegime = null } = {}) {
  const sym = ticker.toUpperCase();

  if (!skipCache) {
    const cached = await getQuickswingFmpCache(sym);
    if (cached && cached._v === 2) return cached.row;
  } else {
    await deleteQuickswingFmpCache(sym).catch(() => {});
  }

  let rawHist = [], earningsHist = [], ahQuoteRaw = [];
  try {
    rawHist = await safe("historical-price-eod/full", sym, "&limit=320"); await delay(200);
    earningsHist = await safe("earnings", sym, "&limit=6"); await delay(200);
    ahQuoteRaw = await safe("aftermarket-quote", sym);
  } catch (e) {
    console.error(`[quickswing] ${sym} fetch error:`, e?.message || e);
  }
  const ahQuote = ahQuoteRaw?.[0] || null;

  const hist = cleanHist(rawHist);
  const regime = marketRegime || await getMarketRegime();
  const spyHist = regime?.hist || null;

  const eGate = earningsGate(earningsHist);
  const checks = [
    checkRsi2(hist),                       // 1
    checkBollinger(hist),                  // 2
    checkVolumeClimax(hist),                // 3
    checkReversalCandle(hist),             // 4
    checkRelativeStrength(hist, spyHist),  // 5
    checkVolumeDryUp(hist),                // 6
    checkAdr(hist),                        // 7
    checkLiquidity(hist),                  // 8
    checkAfterHoursMove(hist, ahQuote),    // 9
  ];
  const score = checks.reduce((s, c) => s + (c.points ?? 0), 0);
  const total = 27;

  const price = hist[0]?.close ?? null;
  const atr5 = round2(atrFrom(hist, 0, 5));

  const row = {
    sym,
    price,
    dataAsOf: hist[0]?.date ?? null,
    score: `${score}/${total}`,
    reasons: checks.map(c => c.summary),
    raw: checks.map(c => c.value),
    verdicts: checks.map(c => c.verdict),
    atr5,
    blocked: eGate.blocked,
    blockedReason: eGate.blocked ? eGate.reason : null,
    earnings: { daysUntil: eGate.daysUntil ?? null, date: eGate.date ?? null },
    marketRegime: regime?.ok ? { favorable: regime.favorable, label: regime.label, distributionDays: regime.distributionDays } : null,
    scored_at: new Date().toISOString(),
  };

  await putQuickswingFmpCache(sym, { _v: 2, row }).catch(() => {});
  return row;
}
