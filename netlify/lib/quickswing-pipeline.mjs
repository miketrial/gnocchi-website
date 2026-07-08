/* ---------- Quick Swing (1-2 day, bidirectional BUY/SELL) pipeline ----------
   Pure FMP — zero Anthropic calls. A different trade philosophy from
   short-pipeline.mjs: that one is trend-following ("price is going up, buy
   the pullback, ride it for weeks"). This one is mean-reversion ("price is
   stretched too far from normal, bet on a snap-back over 1-2 days") — lower
   hit-rate by nature, so it leans on tighter stops and hard gates instead of
   graduated scoring for the riskiest conditions (earnings, illiquidity).

   BIDIRECTIONAL MODEL: unlike the original buy-only version, six of the
   factors below are "mirrored" — each produces an independent BUY read
   (oversold/capitulation/bullish-reversal) and SELL read (overbought/blow-
   off/bearish-reversal) from the same underlying number, via the mirror()
   helper. Two factors (Volume Dry-Up, ATR% Expansion) are non-directional —
   they answer "is a move coming" without saying which way, so their points
   feed BOTH the buy and sell totals equally, surfaced in the UI as standalone
   context badges rather than a directional column. ADR% and Liquidity are no
   longer scored factors at all — they're gates/multipliers applied
   identically to both the buy and sell totals (a 1-2 day trade is exactly as
   exposed to illiquidity or the wrong volatility regime whether you're
   entering or exiting). Earnings blackout remains a hard block on the final
   verdict regardless of direction.

   Each mirrored check returns { buy: {points,verdict,summary}, sell: {...},
   value, reason }. Non-directional checks and gates keep the original
   { points, verdict, summary, value } shape from na()/scored().

   Factor 9 (after-hours move) is post-close only — confirmed via FMP that
   aftermarket-quote is a real, live endpoint, but there is no separate
   premarket endpoint on this plan (premarket-quote/premarket-trade both
   404, same signature as a deliberately bogus endpoint name; corroborated
   by a web search turning up no documented premarket route). Revisit if
   FMP ever adds one.

   Factors 1, 2, and 5 (RSI(2), %B, RS vs SPY) are live during market hours —
   see injectLiveBar. The rest stay end-of-day-only on purpose: Volume Climax
   and Volume Dry-Up compare against a FULL day's average, so mid-session
   volume-so-far reads as a false "dry-up" purely because the day isn't over;
   Reversal Candle's whole signal is "where price ended up in the day's
   range," unanswerable before the close. Liquidity and ADR% are slow-moving
   structural stats where a live tick adds nothing.

   Every per-ticker factor is computed from data already fetched elsewhere in
   the app (historical-price-eod/full + earnings + a live /stable/quote) —
   confirmed against FMP's live API that there is no native Bollinger Bands,
   ATR, Relative-Strength-rank, or distribution-day endpoint, so all of this
   is self-computed arithmetic, not a new data source. ATR% Expansion is the
   same story — pure arithmetic on OHLCV already fetched, via the existing
   atrFrom() helper, no new endpoint required. SPY's own price history + live
   quote (needed for relative-strength-vs-market and the market-regime gate)
   and ^VIX's live quote (the market-wide volatility gate) are both fetched
   ONCE per scan batch (see getMarketRegime) and shared across every ticker,
   not re-fetched per ticker — ^VIX is the one genuinely NEW FMP fetch this
   file makes (confirmed live on /stable/quote), everything else above is
   arithmetic on data already being pulled.

   ---------- REMOVAL CHECKLIST (if this feature doesn't earn its keep) ----------
   Delete, in order:
     1. netlify/lib/quickswing-pipeline.mjs        (this file)
     2. netlify/functions/quickswing-rescan-background.mjs
     3. netlify/functions/quickswing-watchlist.mjs
     3b. netlify/functions/quickswing-delete.mjs
     3c. Telegram alert layer (notifications):
         netlify/functions/quickswing-alert-cron.mjs
         netlify/functions/quickswing-alert-background.mjs
         netlify/functions/quickswing-summary-cron.mjs
         netlify/functions/quickswing-summary-background.mjs
         netlify/lib/quickswing-alert.mjs
         netlify/lib/quickswing-summary.mjs
         netlify/lib/telegram.mjs
         (also unset the TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID Netlify env vars)
     4. netlify.toml — remove the block between the
        "===== QUICK SWING FEATURE =====" / "===== END QUICK SWING FEATURE ====="
        comment markers
     5. netlify/lib/store.mjs — remove the "Quick Swing: per-ticker score
        blobs", "Quick Swing: Telegram alert dedup state", "Quick Swing: raw FMP
        fan-out cache", and "Shared SPY history cache" sections (each is
        delimited by its own header comment)
     6. index.html — grep for QUICK SWING and remove every marked HTML/JS/CSS
        block (start and end markers are paired, one feature per pair)
     7. Optional cleanup: delete the "qs-rows", "qs-alert-state", "qs-summary-snap",
        "qs-fmp", and "spy-hist" Netlify Blobs stores (Netlify dashboard → Blobs) — stale data,
        not referenced by anything else once the above is gone.
   NOT removable without also touching short-pipeline.mjs (shared, keep):
     netlify/lib/ta-helpers.mjs, netlify/lib/fmp-client.mjs — short-pipeline.mjs
     depends on these too; they pre-date nothing here breaking if quickswing
     goes away, just stop being imported by two files instead of one. */
import {
  getQuickswingFmpCache, putQuickswingFmpCache, deleteQuickswingFmpCache,
  getSpyHistCache, putSpyHistCache, getVixHistCache, putVixHistCache, getQuickswingRow,
} from "./store.mjs";
import { round2, na, scored, trueRange, atrFrom } from "./ta-helpers.mjs";
import { safe, delay } from "./fmp-client.mjs";
import { recordQuickswingTransition, emptyLog, annotateBenchmarks, BT_SEED_DAYS, QS_STOP_ATR_MULT } from "./quickswing-backtest.mjs";

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
export function cleanHist(hist) {
  const seen = new Set();
  const out = [];
  for (const d of hist || []) {
    const date = d?.date;
    const close = d?.price ?? d?.close;
    if (!validPricePoint(date, close)) continue;
    if (seen.has(date)) continue;
    seen.add(date);
    // `open` carried through for the overnight-gap profile (prior close → open);
    // falls back to close so a feed missing it just reads as a zero gap, never NaN.
    out.push({ date, open: d?.open ?? close, close, high: d?.high ?? close, low: d?.low ?? close, volume: d?.volume ?? null });
  }
  out.sort((a, b) => b.date.localeCompare(a.date)); // newest first
  return out;
}

/* Prepend today's in-progress session as a synthetic bar, built from a live
   /stable/quote, so RSI(2)/%B/RS-vs-SPY can react intraday instead of only
   once at close. Only three of the factors get this treatment — the
   volume-based checks (Climax, Dry-Up) compare against a FULL day's average
   and would read as a false "dry-up" all morning purely because the session
   isn't over; Reversal Candle's whole logic is "where did price end up
   relative to the day's range," which isn't answerable until the day ends.
   If FMP's own daily bar for today already exists (quote's date <= hist[0]'s
   date), skip — the real bar already covers it, don't double-count. */
function injectLiveBar(hist, quote) {
  if (!hist || !hist.length || !quote) return hist;
  const price = quote.price;
  if (!(price > 0) || !quote.timestamp) return hist;
  const quoteMs = quote.timestamp * 1000;
  const quoteDate = new Date(quoteMs).toISOString().slice(0, 10);
  if (quoteDate < hist[0].date) return hist; // quote older than newest bar → stale, ignore
  if (quoteDate === hist[0].date) {
    // FMP's EOD feed (historical-price-eod/full) already carries TODAY's
    // in-progress bar during market hours — same date as the live quote — so the
    // old `quoteDate <= hist[0].date` guard made this a no-op and `priceIsLive`
    // was permanently false intraday. Stamp the existing today-bar as live and
    // refresh its close to the latest tick. We keep open/high/low/volume from the
    // EOD bar (identical to the quote's day range) so scoring is unchanged; only
    // the live flag + freshest close are corrected.
    if (!(quote.price > 0)) return hist;
    return [{ ...hist[0], close: quote.price, live: true }, ...hist.slice(1)];
  }
  // quoteDate > hist[0].date: EOD feed lags → synthesize today's bar from the quote.
  // Never synthesize a bar dated on a weekend. US markets are closed Sat/Sun,
  // so a quote timestamp landing on one means it's stale weekend data (e.g.
  // Friday's close still showing on Sunday), not a genuine in-progress session
  // — injecting it would give RSI(2)/%B/RS a false extra "flat" day and skew
  // the read. A real intraday quote (9:30–16:00 ET) is always a weekday in UTC
  // too, so this never blocks a legitimate live bar. (Weekday exchange holidays
  // are already handled by the date check above: FMP returns the prior close's
  // timestamp on a holiday, so quoteDate <= hist[0].date and we skip.)
  const dow = new Date(quoteMs).getUTCDay(); // 0 = Sunday, 6 = Saturday
  if (dow === 0 || dow === 6) return hist;
  const livePoint = {
    date: quoteDate,
    open: quote.open ?? price,
    close: price,
    high: quote.dayHigh ?? price,
    low: quote.dayLow ?? price,
    volume: quote.volume ?? null,
    live: true,
  };
  return [livePoint, ...hist];
}

/* ---------- Bidirectional scoring helpers ----------
   A "mirrored" factor scores an independent BUY read and SELL read from the
   same underlying value (e.g. one RSI(2) number implies both an oversold-buy
   score and an overbought-sell score). `reason` picks whichever side is
   currently the stronger read, for a single-line summary/tooltip; the full
   split is still available via `.buy`/`.sell` for the row's buyVerdicts/
   sellVerdicts arrays. */
function sideVerdict(points) {
  return points >= 3 ? "good" : points >= 2 ? "ok" : points >= 1 ? "weak" : "bad";
}
function mirror(buyPoints, buyLabel, sellPoints, sellLabel, prefix, value) {
  const buy = { points: buyPoints, verdict: sideVerdict(buyPoints), summary: `${prefix} — ${buyLabel}` };
  const sell = { points: sellPoints, verdict: sideVerdict(sellPoints), summary: `${prefix} — ${sellLabel}` };
  const reason = buyPoints >= sellPoints ? buy.summary : sell.summary;
  return { buy, sell, value, reason };
}
function naMirror(summary) {
  const side = { points: null, verdict: "na", summary };
  return { buy: side, sell: { ...side }, value: null, reason: summary };
}

/* ---------- 1. RSI(2) — oversold (BUY) / overbought (SELL) extremity ----------
   Simple-average gains/losses (Cutler's RSI), not Wilder's smoothing — same
   "keep it simple" call as the ATR choice in short-pipeline.mjs. RSI(2) is
   Larry Connors' short-horizon variant: far more reactive than the standard
   14-day RSI, tuned to catch 1-2 day extremes rather than multi-week trend.
   Overbought thresholds mirror the oversold ones (95/90/80 vs 5/10/20). */
function checkRsi2(hist) {
  const n = 2;
  if (!hist || hist.length < n + 1) return naMirror("Need 3 days of price history");
  let gains = 0, losses = 0;
  for (let i = 0; i < n; i++) {
    const chg = hist[i].close - hist[i + 1].close;
    if (chg > 0) gains += chg; else losses += -chg;
  }
  const avgGain = gains / n, avgLoss = losses / n;
  const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  let buyPoints, buyLabel;
  if (rsi <= 5)       { buyPoints = 3; buyLabel = "deeply oversold"; }
  else if (rsi <= 10) { buyPoints = 2; buyLabel = "oversold"; }
  else if (rsi <= 20) { buyPoints = 1; buyLabel = "stretched down"; }
  else                { buyPoints = 0; buyLabel = "not oversold"; }
  let sellPoints, sellLabel;
  if (rsi >= 95)       { sellPoints = 3; sellLabel = "deeply overbought"; }
  else if (rsi >= 90)  { sellPoints = 2; sellLabel = "overbought"; }
  else if (rsi >= 80)  { sellPoints = 1; sellLabel = "stretched up"; }
  else                 { sellPoints = 0; sellLabel = "not overbought"; }
  return mirror(buyPoints, buyLabel, sellPoints, sellLabel, `RSI(2) ${rsi.toFixed(1)}`, rsi);
}

/* ---------- 2. Bollinger %B(20, 2σ) — below (BUY) / above (SELL) the band ----------
   %B < 0 means price is below the lower band; %B > 1 means above the upper
   band — the more extreme, the more stretched. Population standard deviation
   (divide by N, not N-1) — the convention most charting platforms use since
   it describes the exact window, not a sample estimate of a larger population. */
function checkBollinger(hist) {
  const n = 20;
  if (!hist || hist.length < n) return naMirror("Need 20 days of price history");
  const closes = hist.slice(0, n).map(d => d.close);
  const sma = closes.reduce((s, x) => s + x, 0) / n;
  const variance = closes.reduce((s, x) => s + (x - sma) ** 2, 0) / n;
  const sd = Math.sqrt(variance);
  const upper = sma + 2 * sd, lower = sma - 2 * sd;
  const price = closes[0];
  const pctB = upper === lower ? 0.5 : (price - lower) / (upper - lower);
  let buyPoints, buyLabel;
  if (pctB <= 0)        { buyPoints = 3; buyLabel = "below lower band"; }
  else if (pctB <= 0.1) { buyPoints = 2; buyLabel = "hugging lower band"; }
  else if (pctB <= 0.25){ buyPoints = 1; buyLabel = "lower half of band"; }
  else                  { buyPoints = 0; buyLabel = "middle/upper band"; }
  let sellPoints, sellLabel;
  if (pctB >= 1.0)       { sellPoints = 3; sellLabel = "above upper band"; }
  else if (pctB >= 0.9)  { sellPoints = 2; sellLabel = "hugging upper band"; }
  else if (pctB >= 0.75) { sellPoints = 1; sellLabel = "upper half of band"; }
  else                   { sellPoints = 0; sellLabel = "middle/lower band"; }
  return mirror(buyPoints, buyLabel, sellPoints, sellLabel, `%B ${pctB.toFixed(2)}`, { pctB, sma, upper, lower });
}

/* ---------- 3. Volume climax — exhaustion-selling (BUY) / blow-off-top (SELL) ----------
   A huge volume spike on a DOWN day often marks capitulation/exhaustion (the
   sellers who were going to sell, already have) — a BUY read. The mirror: a
   huge spike on an UP day after a stretch of up days often marks a blow-off
   top (the buyers who were going to buy, already have) — a SELL read. A
   spike on the "wrong" day for either direction gets a small consolation
   read on the other side (e.g. a high-volume up day gives weak BUY credit —
   "could be the bounce" — while also registering as a weaker SELL exhaustion
   warning if it follows a down day). */
function checkVolumeClimax(hist) {
  if (!hist || hist.length < 21) return naMirror("Need 21 days of volume history");
  const h0 = hist[0], h1 = hist[1];
  if (h0.volume == null || h1.volume == null) return naMirror("Missing recent volume bar");
  const vols = hist.slice(1, 21).map(d => d.volume).filter(v => v != null && v > 0);
  if (vols.length < 15) return naMirror("Volume history too sparse");
  const avg20 = vols.reduce((s, x) => s + x, 0) / vols.length;
  const rv = sane(h0.volume / avg20, 0, 50);
  if (rv == null) return naMirror("Volume ratio out of plausible range — data suspect");
  const isDown = h0.close < h1.close;
  const isUp = h0.close > h1.close;
  let buyPoints, buyLabel;
  if (rv >= 2.5 && isDown)      { buyPoints = 3; buyLabel = "climactic selling — likely capitulation"; }
  else if (rv >= 1.5 && isDown) { buyPoints = 2; buyLabel = "heavy selling, watch for exhaustion"; }
  else if (rv >= 1.5 && isUp)   { buyPoints = 1; buyLabel = "high volume up day — could be the bounce"; }
  else                          { buyPoints = 0; buyLabel = "no climax signal"; }
  let sellPoints, sellLabel;
  if (rv >= 2.5 && isUp)        { sellPoints = 3; sellLabel = "climactic buying — possible blow-off top"; }
  else if (rv >= 1.5 && isUp)   { sellPoints = 2; sellLabel = "heavy buying, watch for exhaustion"; }
  else if (rv >= 1.5 && isDown) { sellPoints = 1; sellLabel = "high volume down day — could be the top rolling over"; }
  else                          { sellPoints = 0; sellLabel = "no climax signal"; }
  return mirror(buyPoints, buyLabel, sellPoints, sellLabel,
    `Last session ${rv.toFixed(2)}x avg, ${isDown ? "down" : isUp ? "up" : "flat"}`, rv);
}

/* ---------- 4. Reversal candle — bullish (BUY) / bearish (SELL) reversal tell ----------
   Position of the close within the day's own high-low range. A close near
   the day's high after a red day is a rough "buyers stepped in" tell (BUY);
   the mirror is a close near the day's low after a green day — "sellers
   stepped in" (SELL). Needs the high/low we get from the "full" (not
   "light") FMP feed. */
function checkReversalCandle(hist) {
  if (!hist || hist.length < 2) return naMirror("Need 2 days of price history");
  const h0 = hist[0], h1 = hist[1];
  const range = h0.high - h0.low;
  if (!(range > 0)) return naMirror("Zero-range session — data suspect");
  const posInRange = (h0.close - h0.low) / range;
  const priorWasDown = h1.close < (hist[2]?.close ?? h1.close);
  const priorWasUp = h1.close > (hist[2]?.close ?? h1.close);
  let buyPoints, buyLabel;
  if (posInRange >= 0.8 && priorWasDown)      { buyPoints = 3; buyLabel = "closed at highs after a down day — strong reversal tell"; }
  else if (posInRange >= 0.6 && priorWasDown) { buyPoints = 2; buyLabel = "closed upper half after a down day"; }
  else if (posInRange >= 0.8)                 { buyPoints = 1; buyLabel = "closed at highs, no prior down day"; }
  else                                        { buyPoints = 0; buyLabel = "no reversal tell"; }
  let sellPoints, sellLabel;
  if (posInRange <= 0.2 && priorWasUp)      { sellPoints = 3; sellLabel = "closed at lows after an up day — strong reversal tell"; }
  else if (posInRange <= 0.4 && priorWasUp) { sellPoints = 2; sellLabel = "closed lower half after an up day"; }
  else if (posInRange <= 0.2)               { sellPoints = 1; sellLabel = "closed at lows, no prior up day"; }
  else                                       { sellPoints = 0; sellLabel = "no reversal tell"; }
  return mirror(buyPoints, buyLabel, sellPoints, sellLabel,
    `Closed ${(posInRange * 100).toFixed(0)}% up the day's range`, posInRange);
}

/* ---------- 5. Relative Strength vs SPY (simplified) — beating (BUY context) / lagging (SELL context) ----------
   IBD-style weighted return — 40% weight on the most recent 3 months, 20%
   each on 6/9/12 months — computed for the ticker AND for SPY, then just
   compared. This is the SIMPLIFIED version: a true IBD "RS Rating" is a
   percentile rank against the entire market (thousands of tickers scored
   the same way), which is a market-wide batch job. This just answers "is
   this ticker beating the index," which is enough context for a swing
   entry/exit without needing to score every stock in existence on every scan. */
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
  if (tickerStrength == null || spyStrength == null) return naMirror("Need 3+ months of price history (ticker and SPY)");
  const delta = tickerStrength - spyStrength;
  let buyPoints, buyLabel;
  if (delta >= 0.15)      { buyPoints = 3; buyLabel = "strongly beating the market"; }
  else if (delta >= 0.05) { buyPoints = 2; buyLabel = "beating the market"; }
  else if (delta >= -0.05){ buyPoints = 1; buyLabel = "roughly in line with the market"; }
  else                    { buyPoints = 0; buyLabel = "lagging the market"; }
  let sellPoints, sellLabel;
  if (delta <= -0.15)      { sellPoints = 3; sellLabel = "strongly lagging the market"; }
  else if (delta <= -0.05) { sellPoints = 2; sellLabel = "lagging the market"; }
  else if (delta <= 0.05)  { sellPoints = 1; sellLabel = "roughly in line with the market"; }
  else                     { sellPoints = 0; sellLabel = "beating the market"; }
  return mirror(buyPoints, buyLabel, sellPoints, sellLabel,
    `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}pp vs SPY`, { tickerStrength, spyStrength, delta });
}

/* ---------- 6. After-hours move — drop (BUY-side stretch) / pop (SELL-side stretch) ----------
   A large post-close move (news, guidance, M&A rumor) re-prices the setup
   before tomorrow's open — a 1-2 day hold can't just ignore that the way a
   multi-week hold might. A sharp drop adds to the "stretched down" read; a
   sharp pop adds to the "stretched up" read — a clean mirror, replacing the
   old asymmetric "pop gives weak buy credit" treatment. Post-close only —
   see the file header for why there's no premarket leg. */
function checkAfterHoursMove(hist, ahQuote) {
  const regularClose = hist?.[0]?.close;
  if (!regularClose) return naMirror("Need today's regular-session close");
  if (!ahQuote) return naMirror("No after-hours quote available");
  const AH_STALE_MS = 18 * 60 * 60 * 1000; // stale = leftover from a prior session, not tonight's
  if (!ahQuote.timestamp || Date.now() - ahQuote.timestamp > AH_STALE_MS) {
    return naMirror("After-hours quote is stale — outside today's post-close session");
  }
  const bid = ahQuote.bidPrice, ask = ahQuote.askPrice;
  const ahPrice = (bid != null && ask != null) ? (bid + ask) / 2 : (ask ?? bid);
  if (!(ahPrice > 0)) return naMirror("No usable after-hours price");
  const chg = (ahPrice - regularClose) / regularClose;
  let buyPoints, buyLabel;
  if (chg <= -0.05)        { buyPoints = 3; buyLabel = "sharp after-hours drop — more stretched into tomorrow"; }
  else if (chg <= -0.03)   { buyPoints = 2; buyLabel = "notable after-hours weakness"; }
  else if (chg <= -0.015)  { buyPoints = 1; buyLabel = "mild after-hours weakness"; }
  else                     { buyPoints = 0; buyLabel = "after-hours flat or up"; }
  let sellPoints, sellLabel;
  if (chg >= 0.05)        { sellPoints = 3; sellLabel = "sharp after-hours pop — more stretched into tomorrow"; }
  else if (chg >= 0.03)   { sellPoints = 2; sellLabel = "notable after-hours strength"; }
  else if (chg >= 0.015)  { sellPoints = 1; sellLabel = "mild after-hours strength"; }
  else                    { sellPoints = 0; sellLabel = "after-hours flat or down"; }
  return mirror(buyPoints, buyLabel, sellPoints, sellLabel,
    `${chg >= 0 ? "+" : ""}${(chg * 100).toFixed(1)}% after-hours`, { ahPrice, regularClose, chg });
}

/* ---------- 7. Volume dry-up — non-directional "a move is coming" context ----------
   Low volume during a consolidation (nobody's selling, nobody's buying)
   often precedes a breakout OR a breakdown equally well — it says a move is
   imminent, not which way. Unlike the mirrored factors above, this feeds the
   SAME points into both the buy and sell totals (see scoreTickerQuickSwing)
   rather than taking a directional side. Compares the most recent 5 days'
   avg volume against the 20 days before that. */
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
  if (ratio <= 0.5)      { points = 3; label = "volume has dried up sharply — coiling, expect a move"; }
  else if (ratio <= 0.7) { points = 2; label = "volume contracting — coiling"; }
  else if (ratio <= 0.9) { points = 1; label = "mild volume contraction"; }
  else                   { points = 0; label = "no dry-up — normal or rising volume"; }
  return scored(points, `Last 5d volume ${(ratio * 100).toFixed(0)}% of prior 20d avg — ${label}`, ratio);
}

/* ---------- 8. ATR% Expansion — non-directional "high volatility right now" context ----------
   NEW factor. ADR% (below) answers "does this stock typically move enough to
   matter" (a structural, slow-moving stat); this answers "is volatility
   ITSELF expanding right now" — a genuinely different, faster-moving read.
   Ratio of a short (5-day) ATR to a longer (20-day) ATR: >1 means the last
   week has been choppier than the last month. This is the concrete "high
   volatility" gate the screener needs — an RSI(2) oversold read during ATR
   expansion is a higher-conviction signal than the same read during ATR
   contraction (a quiet, directionless tape). Purely arithmetic on OHLCV
   already fetched, via the existing atrFrom() helper — no new FMP data. */
function checkAtrExpansion(hist) {
  const atr5 = atrFrom(hist, 0, 5);
  const atr20 = atrFrom(hist, 0, 20);
  if (atr5 == null || atr20 == null || !(atr20 > 0)) return na("Need 21 days of high/low/close history");
  const ratio = sane(atr5 / atr20, 0, 20);
  if (ratio == null) return na("ATR ratio out of plausible range — data suspect");
  let points, label;
  if (ratio >= 1.5)      { points = 3; label = "volatility sharply expanding — high-conviction window"; }
  else if (ratio >= 1.2) { points = 2; label = "volatility expanding"; }
  else if (ratio >= 1.0) { points = 1; label = "volatility steady to slightly up"; }
  else                   { points = 0; label = "volatility contracting — signals less reliable right now"; }
  return scored(points, `5d ATR ${ratio.toFixed(2)}x the 20d ATR — ${label}`, ratio);
}

/* ---------- Overnight-gap profile — how much of the risk lands where you can't act ----------
   Decomposes recent daily bars into the OVERNIGHT leg (prior close → today's
   open) — the part of a name's move that prints while the regular session is
   shut, i.e. that you cannot trade around. A stock that routinely gaps ±3%
   overnight carries far more uncatchable risk on a 1-2 day hold than one that
   opens roughly flat: for the same oversold setup, the gappy name is the worse
   bet because the move that erases (or overshoots) your edge is more likely to
   land before you can act on it. avgAbsOvn is the mean absolute overnight gap
   over the trailing window; nights3 is how often that gap topped 3%.

   Confirmed on the live watchlist that this discriminates hard (avg |gap| ran
   0.8% for AMZN to 2.8% for SNDK; >3% nights ran 3% to 39%), while the DIRECTION
   of the next session vs the gap was a ~50/50 coin flip across every name — so
   this is used only for MAGNITUDE (a non-directional risk read), never to guess
   which way tomorrow opens. Pure arithmetic on the OHLCV already fetched (needs
   the `open` cleanHist now carries) — no new endpoint. */
const GAP_LOOKBACK = 60; // sessions of close→open history behind the profile
export function overnightGapProfile(hist, lookback = GAP_LOOKBACK) {
  if (!hist || hist.length < 21) return null;
  const bars = hist.slice(0, lookback + 1); // newest-first; bars[i+1] is the prior close
  const gaps = [];
  for (let i = 0; i < bars.length - 1; i++) {
    const open = bars[i].open, prevClose = bars[i + 1].close;
    if (!(open > 0) || !(prevClose > 0)) continue;
    const g = sane(open / prevClose - 1, -0.9, 9); // reject splits/bad ticks
    if (g != null) gaps.push(Math.abs(g));
  }
  if (gaps.length < 15) return null; // too sparse to characterize
  const avgAbsOvn = gaps.reduce((s, v) => s + v, 0) / gaps.length;
  const nights3 = gaps.filter(g => g >= 0.03).length / gaps.length;
  return { avgAbsOvn, nights3, n: gaps.length };
}

/* ---------- Overnight-gap conviction damper (non-directional) ----------
   Turns avgAbsOvn into a multiplier on the directional score: the gappier the
   name, the stronger the raw read has to be to still clear the entry threshold.
   Mirrors the shape of the other non-directional multipliers (VIX, ADR, regime).
   Applied to BOTH the BUY and SELL scores: a name that routinely gaps overnight
   is exactly as dangerous to short into as it is to buy into — the move that
   erases (or overshoots) your edge lands while the market is shut either way, so
   a gappy overbought read needs to be stronger to earn a fresh short, same as a
   gappy oversold read needs to be stronger to earn a fresh long. Tiers and
   penalties are calibrated on an 8-ticker / 250-session backtest replay — see
   the gap-damper study in the commit that added this. */
export const GAP_DAMPER_TIERS = [
  { maxAvg: 0.015, mult: 1.00 }, // calm overnight (~AMZN/TSM) — no penalty
  { maxAvg: 0.022, mult: 0.90 }, // moderate (~AVGO/NOW/GEV/DELL)
  { maxAvg: 0.030, mult: 0.78 }, // gappy (~MU)
  { maxAvg: Infinity, mult: 0.65 }, // very gappy (~SNDK)
];
function gapMultiplier(profile, tiers = GAP_DAMPER_TIERS) {
  if (!tiers || !profile || profile.avgAbsOvn == null) return 1.0; // unknown/disabled — don't penalize
  for (const t of tiers) if (profile.avgAbsOvn <= t.maxAvg) return t.mult;
  return 1.0;
}

/* ---------- GATE: ADR% — Average Daily Range, a volatility-suitability gate ----------
   Qullamaggie-style: is this stock volatile enough per-day for a 1-2 day
   trade to matter at all? Too low = not enough movement; too high = whipsaw
   risk that swamps a tight stop. No longer a scored factor feeding one
   direction — it's a multiplier applied to BOTH the buy and sell totals in
   scoreTickerQuickSwing, since a too-quiet or too-wild regime makes both an
   entry AND an exit signal less meaningful, not just an entry. */
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

/* ---------- GATE: Liquidity — same $-volume convention as short-pipeline.mjs ----------
   No longer a scored factor — a multiplier applied to both buy and sell
   totals. Illiquidity risk cuts both ways: a thin stock can gap against a
   fresh entry just as easily as it can trap you on the way out. */
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

/* ---------- GATE: Earnings blackout ----------
   A hard block, not a graduated score — applies to the final verdict
   regardless of direction. A 1-2 day hold can't absorb an earnings gap
   whether you'd be entering fresh or watching for an exit; the earnings
   proximity itself is the dominant consideration in that window, not the
   technical BUY/SELL score. Underlying buy/sell scores are still computed
   and shown on the row for context — only the headline verdict is blocked. */
function earningsGate(earningsHist) {
  // No calendar data at all → we CANNOT evaluate the blackout. Fail open (many
  // names legitimately have no near print), but flag it so the row/UI surfaces
  // "unavailable" rather than silently implying "no earnings risk". A genuine
  // fetch hiccup and a genuinely earnings-free name look identical here, so the
  // honest move is to mark the gate un-evaluated, not to imply it passed.
  if (!earningsHist || !earningsHist.length) return { blocked: false, reason: "Earnings calendar data unavailable — blackout not evaluated", dataMissing: true };
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

/* ---------- VIX — market-wide volatility gate (shared, computed ONCE per batch) ----------
   Distinct from per-ticker ATR% Expansion: that answers "is THIS stock
   choppier than usual"; this answers "is the WHOLE MARKET choppier than
   usual right now." Confirmed live on FMP's stable /quote endpoint (see
   comment in getMarketRegime for the fetch). Standard, widely-recognized
   VIX bands — deliberately absolute thresholds rather than a ratio-to-its-
   own-history like ATR Expansion uses, since VIX is already a normalized
   index with well-known conventional levels (a beginner can look these up
   anywhere and get the same bands). Non-directional, same spirit as Vol
   Dry-Up / ATR Expansion — a spiked VIX doesn't say which way a stock will
   move, just that whatever signal IS firing deserves more weight, so it
   multiplies both the buy and sell totals identically rather than favoring
   one side. */
function classifyVix(level) {
  if (level == null || !isFinite(level)) return null;
  if (level < 15) return { label: "low / complacent", multiplier: 0.85 };
  if (level < 20) return { label: "normal", multiplier: 1.0 };
  if (level < 30) return { label: "elevated", multiplier: 1.15 };
  return { label: "high fear", multiplier: 1.3 };
}

/* ---------- Market regime (SPY-level, computed ONCE per scan batch) ----------
   CANSLIM's "M" — don't fight the tape. This is a portfolio-wide gate, not
   a per-ticker factor: scoring "is SPY above its own 200DMA" separately for
   every ticker in a scan would just repeat the same answer N times. Also
   computes IBD-style distribution days (index down ≥0.2% on higher volume
   than the prior day, rolling 25-session window, a day dropping off early
   if the index is currently >5% above that day's close).

   An unfavorable regime dampens BUY (don't fight the tape for new longs) but
   BOOSTS SELL (an unfavorable tape is exactly when exit signals should carry
   MORE weight, not less) — see the regime multiplier in scoreTickerQuickSwing. */
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
    return { ok: false, reason: "Insufficient SPY history", hist: spyHist, liveHist: spyHist, vix: null };
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
  // Fetched once per scan batch (not per ticker) so relative-strength's SPY
  // leg is anchored to "right now," matching the live bar injected into each
  // ticker's own hist — comparing a live ticker return to a stale SPY return
  // would silently mis-measure the delta.
  const spyLiveQuote = (await safe("quote", "SPY").catch(() => []))?.[0] || null;
  const liveHist = injectLiveBar(spyHist, spyLiveQuote);
  // VIX — also fetched once per batch, same reasoning as SPY. Confirmed live
  // on the /quote endpoint (returns price, priceAvg50/200, dayHigh/Low).
  const vixQuote = (await safe("quote", "^VIX").catch(() => []))?.[0] || null;
  const vixLevel = vixQuote?.price ?? null;
  const vixClass = classifyVix(vixLevel);
  const vix = vixClass ? { level: vixLevel, label: vixClass.label, multiplier: vixClass.multiplier } : null;
  // VIX EOD history — for the backtest replay's VIX leg (the live /quote endpoint
  // has today's level but no series). Cached once per batch, same as SPY hist.
  let vixHist = await getVixHistCache().catch(() => null);
  if (!vixHist) {
    const rawVix = await safe("historical-price-eod/full", "^VIX", "&limit=320").catch(() => []);
    vixHist = cleanHist(rawVix);
    if (vixHist.length >= 60) await putVixHistCache(vixHist).catch(() => {});
  }
  return {
    ok: true, price, sma50, sma200, uptrend, distributionDays: distDays,
    favorable: uptrend && distDays <= 5, label, hist: spyHist, liveHist, vix, vixHist,
  };
}

/* ---------- Composite BUY/SELL verdict ----------
   maxScore = 24: six mirrored factors x 3 points + two shared/context
   factors x 3 points, per direction. Gates (liquidity, ADR/volatility)
   scale both totals down/up via multipliers rather than hard-blocking —
   only the earnings gate is a hard block, applied to the final verdict. */
const QS_MAX_SCORE = 24;

// Factor order for the mirrored array (used to descore by key).
const MIRRORED_KEYS = ["RSI", "%B", "CLX", "REV", "RS", "AH"];
// Factors that are still computed and shown in the grid but DO NOT vote on the
// BUY/SELL score. REV (reversal candle) was found inverted for a next-day
// mean-reversion horizon — it credits a strong close, but weak closes bounce
// more next day; removing it modestly beat keeping it across a 90-name / 2-year
// A/B and never hurt (scripts/investigate-rev.mjs, scripts/ab-rev.mjs). Kept in
// the grid as context. QS_MAX_SCORE stays 24 on purpose: descoring a factor
// lowers reachable scores, which also raises the entry bar — part of the
// measured improvement.
const QS_DESCORED = new Set(["REV"]);

function liqMultiplierFor(points) {
  if (points == null) return 1.0; // unknown — don't penalize
  return points === 3 ? 1.0 : points === 2 ? 0.85 : points === 1 ? 0.6 : 0.35;
}
function adrMultiplierFor(points) {
  if (points == null) return 1.0; // unknown — don't penalize
  return points === 3 ? 1.0 : points === 1 ? 0.7 : 0.4; // checkAdr never yields 2
}
const QS_WEAK_THRESHOLD = 0.30; // weak-signal floor (was 0.40 — see extreme-read note below)
/* forceBuy/forceSell come from an "extreme read": RSI(2) pinned at an oversold/
   overbought extreme, or %B outside the Bollinger band. Those are valid mean-
   reversion signals on their own even when the weighted score is muted — e.g. a
   very volatile name whose bands are too wide for %B to confirm, or an
   unfavorable regime damping the score. Without this, a textbook Connors RSI(2)=0
   plunge could sit at ~4/24 and read NEUTRAL, which defeats the screener. */
function deriveVerdict({ buyScore, sellScore, blocked, forceBuy = false, forceSell = false }) {
  const buyPct = buyScore / QS_MAX_SCORE, sellPct = sellScore / QS_MAX_SCORE;
  if (blocked) return { verdict: "BLOCKED", tier: null };
  if (buyPct >= 0.75) return { verdict: "BUY", tier: "strong" };
  if (buyPct >= 0.55) return { verdict: "BUY", tier: "moderate" };
  if (sellPct >= 0.75) return { verdict: "SELL", tier: "strong" };
  if (sellPct >= 0.55) return { verdict: "SELL", tier: "moderate" };
  if (Math.max(buyPct, sellPct) >= QS_WEAK_THRESHOLD) {
    if (buyPct === sellPct) return { verdict: "NEUTRAL", tier: null };
    return { verdict: buyPct > sellPct ? "BUY" : "SELL", tier: "weak" };
  }
  // Extreme-read override — only when the opposite side isn't already stronger.
  if (forceBuy && buyPct >= sellPct) return { verdict: "BUY", tier: "weak" };
  if (forceSell && sellPct >= buyPct) return { verdict: "SELL", tier: "weak" };
  return { verdict: "NEUTRAL", tier: null };
}

/* Extract the extreme-read flags from the mirrored factor array (index 0 = RSI(2)
   value, index 1 = Bollinger { pctB }). Shared by the live scorer and the
   historical replay so both honor the same override. */
function extremeReads(mirrored) {
  const rsi = mirrored?.[0]?.value;
  const pctB = mirrored?.[1]?.value?.pctB;
  const forceBuy = (rsi != null && rsi <= 5) || (pctB != null && pctB <= 0);
  const forceSell = (rsi != null && rsi >= 95) || (pctB != null && pctB >= 1);
  return { forceBuy, forceSell };
}

/* ---------- BUY conviction gate ----------
   A verdict of BUY only survives if the stock is a market LEADER — RS vs SPY
   ≥ 0 (beating or matching the market over the weighted 3-12mo lookback). A
   mean-reversion long works far better fading a dip in a leader than catching
   a falling knife in a laggard. Backtested across 30 tickers / 250 sessions,
   this lifted the win rate 69%→75% and avg P/L +1.8%→+2.8%, holding across both
   favorable and unfavorable regimes. (A stricter variant also requiring ≥3 of 6
   factors to agree reached 78%, but muted too many oversold-leader setups for
   comfort — see the win-rate study.) Gates fresh BUY *entries*; the mirror
   (sellConvictionOk) gates fresh SELL entries. */
function buyConvictionOk(mirrored) {
  const rsDelta = mirrored?.[4]?.value?.delta;
  return rsDelta != null && rsDelta >= 0; // must be beating/matching SPY (a leader)
}
/* ---------- SELL conviction gate (mirror of buyConvictionOk) ----------
   A fresh SELL only stands if the stock is a market LAGGARD — RS vs SPY ≤ 0
   (lagging or matching the market). The symmetric logic to the leader gate: a
   mean-reversion short works far better fading a rip in a laggard (already
   rolling over) than shorting a genuine relative-strength leader on a blow-off
   (leaders keep gapping up on you). Only gates SELL entries — an in-progress
   short is not re-gated, same as the BUY side. */
function sellConvictionOk(mirrored) {
  const rsDelta = mirrored?.[4]?.value?.delta;
  return rsDelta != null && rsDelta <= 0; // must be lagging/matching SPY (a laggard)
}

/* ---------- Sticky verdict (hysteresis) ----------
   The live scorer runs on today's IN-PROGRESS bar (RSI(2), %B and RS all swap
   the live price in as the "close"), so the raw score wanders all day and a name
   sitting near the BUY/NEUTRAL line chatters BUY↔NEUTRAL on every price wiggle.
   Hysteresis gives the verdict memory: a directional call you're already in
   survives a shallow cool-off, and only releases to NEUTRAL once the read truly
   fades (score below the hold floor) or the opposite side takes over. Entry
   still needs the normal thresholds (0.55 / 0.30-weak); we just lower the bar to
   *stay* in — a classic deadband. Only ever upgrades a fresh NEUTRAL back to the
   held direction; never overrides a fresh BUY/SELL/BLOCKED, so genuine reversals
   still flip instantly. Live-only: the backtest replay runs on completed daily
   closes (no intraday noise) and is left untouched. */
// Tuned on 30 tickers × 250 daily bars (legacy component cache). A held BUY's
// forward 2-day return holds at +1.3–1.6% while its score stays ≥0.20, then
// falls off a cliff to +0.2–0.5% below it — so 0.20 is where "BUY" stops meaning
// much. It also flickers LESS than the old 0.22 (holds down to 5/24 vs 6/24), and
// the extra days it holds are the high-expectancy ones (+1.34%). Going lower only
// buys marginal flicker cuts by holding near-dead setups, eroding the signal.
const QS_HOLD_FLOOR = 0.20; // an open BUY/SELL survives down to this (vs the 0.30 weak entry)
function applyVerdictHysteresis({ verdict, tier, prevVerdict, buyScore, sellScore, blocked, forceBuy, forceSell }) {
  if (blocked || verdict !== "NEUTRAL") return { verdict, tier, held: false };
  const buyPct = buyScore / QS_MAX_SCORE, sellPct = sellScore / QS_MAX_SCORE;
  // `held: true` marks a call the raw read had cooled to NEUTRAL but hysteresis
  // kept alive — surfaced in the row so the UI can explain the stickiness.
  if (prevVerdict === "BUY" && (buyPct >= QS_HOLD_FLOOR || forceBuy) && buyPct >= sellPct) {
    return { verdict: "BUY", tier: "weak", held: true };
  }
  if (prevVerdict === "SELL" && (sellPct >= QS_HOLD_FLOOR || forceSell) && sellPct >= buyPct) {
    return { verdict: "SELL", tier: "weak", held: true };
  }
  return { verdict, tier, held: false };
}

/* ---------- Suggested stop distance ----------
   Turns atr5 (already computed for other purposes) into an actual, actionable
   price level. The multiple is QS_STOP_ATR_MULT (2.5×ATR) so the line SHOWN here
   is the same line the backtest actually EXITS on — one coherent stop, not a
   tighter cosmetic suggestion alongside a wider enforced rule. 2.5× is the
   calibrated level (see the stop-loss study in quickswing-backtest.mjs); the old
   1.5× was too tight and stopped out winners. BUY reads as a long entry (stop
   below price); SELL is ambiguous on its own — it could mean "exit an existing
   long" or "short entry candidate" — so it's computed as the short-entry case
   (stop above price) and the UI must label it "if shorting" rather than imply the
   tool is telling you to short. No stop for NEUTRAL/BLOCKED — nothing to protect. */
function computeStop(verdict, price, atr5) {
  if (!(price > 0) || !(atr5 > 0)) return null;
  const basis = `${QS_STOP_ATR_MULT}x ATR(5)`;
  if (verdict === "BUY") {
    const stopPrice = round2(price - QS_STOP_ATR_MULT * atr5);
    return { price: stopPrice, pctFromEntry: round2(((stopPrice - price) / price) * 100), basis, side: "long" };
  }
  if (verdict === "SELL") {
    const stopPrice = round2(price + QS_STOP_ATR_MULT * atr5);
    return { price: stopPrice, pctFromEntry: round2(((stopPrice - price) / price) * 100), basis, side: "short" };
  }
  return null;
}

/* ---------- Signal-agreement count ----------
   Breadth, not magnitude: of the 6 mirrored (directional) factors, how many
   independently lean toward the winning direction — separate from the
   point-weighted buy/sell score. A stock where 5 of 6 factors mildly agree
   is a broader, more corroborated read than one factor screaming (3/3
   points) while the rest are silent, even if the raw weighted score comes
   out similar — this is informational for now, not (yet) a gate on the
   verdict/tier itself. Only scoped to the 6 mirrored factors — Vol Dry-Up
   and ATR Expansion aren't directional, so they can't "agree" either way. */
function computeAgreement(mirrored, direction) {
  if (!direction) return { count: 0, of: mirrored.length, direction: null };
  const count = mirrored.filter(c => {
    const b = c.buy.points ?? 0, s = c.sell.points ?? 0;
    if (b === 0 && s === 0) return false; // no signal at all from this factor
    return direction === "BUY" ? b > s : s > b;
  }).length;
  return { count, of: mirrored.length, direction };
}

/* ---------- Main entry point ---------- */
export async function scoreTickerQuickSwing(ticker, { skipCache = false, marketRegime = null } = {}) {
  const sym = ticker.toUpperCase();

  if (!skipCache) {
    const cached = await getQuickswingFmpCache(sym);
    if (cached && cached._v === 5) return cached.row;
  } else {
    await deleteQuickswingFmpCache(sym).catch(() => {});
  }

  let rawHist = [], earningsHist = [], ahQuoteRaw = [], liveQuoteRaw = [];
  try {
    rawHist = await safe("historical-price-eod/full", sym, "&limit=320"); await delay(200);
    earningsHist = await safe("earnings", sym, "&limit=6"); await delay(200);
    ahQuoteRaw = await safe("aftermarket-quote", sym); await delay(200);
    liveQuoteRaw = await safe("quote", sym);
  } catch (e) {
    console.error(`[quickswing] ${sym} fetch error:`, e?.message || e);
  }
  const ahQuote = ahQuoteRaw?.[0] || null;
  const liveQuote = liveQuoteRaw?.[0] || null;

  const hist = cleanHist(rawHist);
  // liveHist swaps in today's in-progress session (from the live quote) as
  // the newest bar — used only by the factors where an incomplete day is
  // still a meaningful read (see injectLiveBar). Falls back to hist itself
  // outside market hours / on a fetch miss, since injectLiveBar is a no-op
  // when the quote isn't newer than the latest completed daily bar.
  const liveHist = injectLiveBar(hist, liveQuote);
  const regime = marketRegime || await getMarketRegime();
  const spyHist = regime?.hist || null;
  const spyLiveHist = regime?.liveHist || spyHist;

  const eGate = earningsGate(earningsHist);

  // Six mirrored (directional) factors — each yields an independent buy/sell read.
  const mirrored = [
    checkRsi2(liveHist),                          // 0 — live
    checkBollinger(liveHist),                     // 1 — live
    checkVolumeClimax(hist),                      // 2 — EOD only (needs a full day's volume to compare against)
    checkReversalCandle(hist),                    // 3 — EOD only (needs the completed day's range)
    checkRelativeStrength(liveHist, spyLiveHist), // 4 — live
    checkAfterHoursMove(hist, ahQuote),           // 5 — post-close only
  ];
  // Two shared (non-directional) factors — same points feed both sides.
  const shared = [
    checkVolumeDryUp(hist),   // 6 — EOD only
    checkAtrExpansion(hist),  // 7 — EOD only (structural-ish, but reacts faster than ADR%)
  ];
  // Two gates — multipliers on both totals, not scored array entries.
  const adr = checkAdr(hist);
  const liq = checkLiquidity(hist);

  const reasons = [...mirrored.map(c => c.reason), ...shared.map(c => c.summary)];
  const raw = [...mirrored.map(c => c.value), ...shared.map(c => c.value)];
  const buyVerdicts = [...mirrored.map(c => c.buy.verdict), ...shared.map(c => c.verdict)];
  const sellVerdicts = [...mirrored.map(c => c.sell.verdict), ...shared.map(c => c.verdict)];

  // REV (and anything in QS_DESCORED) is computed for the grid but excluded from
  // the score sums — see the QS_DESCORED note. Shared factors are never descored.
  const rawBuyScore = mirrored.reduce((s, c, i) => s + (QS_DESCORED.has(MIRRORED_KEYS[i]) ? 0 : (c.buy.points ?? 0)), 0) + shared.reduce((s, c) => s + (c.points ?? 0), 0);
  const rawSellScore = mirrored.reduce((s, c, i) => s + (QS_DESCORED.has(MIRRORED_KEYS[i]) ? 0 : (c.sell.points ?? 0)), 0) + shared.reduce((s, c) => s + (c.points ?? 0), 0);

  const liqMultiplier = liqMultiplierFor(liq.points);
  const adrMultiplier = adrMultiplierFor(adr.points);
  // Unfavorable regime: don't fight the tape for new longs (dampen BUY), but
  // weight exits MORE when the tape is weak (boost SELL). Unknown regime
  // (insufficient SPY data) applies no adjustment either way.
  const regimeFavorable = regime?.ok ? regime.favorable : null;
  const regimeMultiplierBuy = regimeFavorable === false ? 0.85 : 1.0;
  const regimeMultiplierSell = regimeFavorable === false ? 1.15 : 1.0;
  // VIX — non-directional, so the SAME multiplier applies to both sides
  // (unlike the regime multiplier above, which favors one direction).
  const vixMultiplier = regime?.vix?.multiplier ?? 1.0;
  // Overnight-gap damper — non-directional: a gappy name needs a stronger read to
  // earn a fresh entry on EITHER side, since more of its move lands where you
  // can't act whether you're going long or short. Applied to both totals.
  const gapProfile = overnightGapProfile(hist);
  const gapMult = gapMultiplier(gapProfile);

  const buyScore = Math.min(QS_MAX_SCORE, Math.round(rawBuyScore * liqMultiplier * adrMultiplier * regimeMultiplierBuy * vixMultiplier * gapMult));
  const sellScore = Math.min(QS_MAX_SCORE, Math.round(rawSellScore * liqMultiplier * adrMultiplier * regimeMultiplierSell * vixMultiplier * gapMult));

  const { forceBuy, forceSell } = extremeReads(mirrored);
  // Last persisted verdict for this ticker — the state hysteresis needs to keep
  // an in-progress call from whipsawing between scans. Null on first-ever scan.
  const prevVerdict = await getQuickswingRow(sym).then(r => r?.verdict ?? null).catch(() => null);
  let { verdict, tier } = deriveVerdict({ buyScore, sellScore, blocked: eGate.blocked, forceBuy, forceSell });
  // High-conviction gate: a NEW BUY must be a market leader (RS ≥ 0), a NEW SELL
  // must be a laggard (RS ≤ 0). A directional call we're already holding is NOT
  // re-gated — RS ticking across zero on an in-progress bar shouldn't whipsaw an
  // open call to NEUTRAL (a top cause of the intraday flicker).
  if (verdict === "BUY" && prevVerdict !== "BUY" && !buyConvictionOk(mirrored)) { verdict = "NEUTRAL"; tier = null; }
  if (verdict === "SELL" && prevVerdict !== "SELL" && !sellConvictionOk(mirrored)) { verdict = "NEUTRAL"; tier = null; }
  // Sticky verdict: hold an existing directional call through a shallow dip.
  let held;
  ({ verdict, tier, held } = applyVerdictHysteresis({ verdict, tier, prevVerdict, buyScore, sellScore, blocked: eGate.blocked, forceBuy, forceSell }));

  const priceIsLive = liveHist[0]?.live === true;
  const price = liveHist[0]?.close ?? hist[0]?.close ?? null;
  const atr5 = round2(atrFrom(hist, 0, 5));
  const stop = computeStop(verdict, price, atr5);
  const agreementDirection = buyScore === sellScore ? null : (buyScore > sellScore ? "BUY" : "SELL");
  const agreement = computeAgreement(mirrored, agreementDirection);

  const row = {
    sym,
    price,
    priceIsLive,
    dataAsOf: hist[0]?.date ?? null,
    verdict, tier,
    held: !!held, // true = raw read cooled to NEUTRAL but hysteresis held the call
    buyScore: `${buyScore}/${QS_MAX_SCORE}`,
    sellScore: `${sellScore}/${QS_MAX_SCORE}`,
    reasons, raw, buyVerdicts, sellVerdicts,
    stop,
    agreement,
    atr5,
    atrExpansionRatio: shared[1]?.value ?? null,
    liquidity: { value: liq.value, points: liq.points, label: liq.summary },
    volatility: { adrPct: adr.value, points: adr.points, label: adr.summary },
    vix: regime?.vix ? { level: regime.vix.level, label: regime.vix.label } : null,
    overnightGap: gapProfile
      ? { avgAbsOvn: round2(gapProfile.avgAbsOvn * 100), nights3Pct: Math.round(gapProfile.nights3 * 100), mult: gapMult }
      : null,
    liqMultiplier, adrMultiplier, regimeMultiplierBuy, regimeMultiplierSell, vixMultiplier, gapMult,
    blocked: eGate.blocked,
    blockedReason: eGate.blocked ? eGate.reason : null,
    earnings: { daysUntil: eGate.daysUntil ?? null, date: eGate.date ?? null, dataMissing: eGate.dataMissing || false },
    marketRegime: regime?.ok ? { favorable: regime.favorable, label: regime.label, distributionDays: regime.distributionDays } : null,
    scored_at: new Date().toISOString(),
  };

  await putQuickswingFmpCache(sym, { _v: 5, row }).catch(() => {});
  return row;
}

/* ---------- Historical backtest seed ----------
   The live pipeline only produces a verdict for "right now." To give the
   backtest log something to show the moment a ticker is first added, replay
   the screener over the trailing EOD price history and synthesize the same
   BUY/exit trades it WOULD have booked.

   Deliberately EOD-only: the after-hours and live-intraday legs can't be
   reconstructed from a historical daily bar, and VIX history isn't on the
   stable /quote endpoint — so those are treated as neutral (AH = n/a, VIX
   multiplier = 1). Every deterministic factor (RSI2, %B, Vol Climax, Reversal,
   RS-vs-SPY, Vol Dry-Up, ATR Expansion, ADR/Liquidity gates, earnings gate,
   SPY market regime) IS reconstructed as of each historical close, so the seed
   is a faithful replay of the parts of the model that don't depend on
   right-now-only data. Numbers can therefore differ slightly from what the
   live tool showed on those days — this is a plausible reconstruction, not a
   recording. */

/* Newest-first slice of `hist` as of (and including) `asOfDate`. */
export function histAsOf(hist, asOfDate) {
  return hist.filter(d => d.date <= asOfDate);
}

/* Market-regime favorability reconstructed from SPY as of a past date. Returns
   true/false/null (null = not enough SPY history to judge → no adjustment). */
function historicalRegimeFavorable(spyAsOf) {
  if (!spyAsOf || spyAsOf.length < 200) return null;
  const closes = spyAsOf.map(d => d.close);
  const sma50 = closes.slice(0, 50).reduce((s, x) => s + x, 0) / 50;
  const sma200 = closes.slice(0, 200).reduce((s, x) => s + x, 0) / 200;
  const uptrend = closes[0] > sma50 && sma50 > sma200;
  const distDays = distributionDayCount(spyAsOf);
  return uptrend && (distDays == null || distDays <= 5);
}

/* Was the ticker inside the 5-day pre-earnings blackout as of `asOfDate`? */
function historicalEarningsBlocked(earningsHist, asOfDate) {
  if (!earningsHist || !earningsHist.length) return false;
  const next = earningsHist
    .filter(e => e.date > asOfDate)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  if (!next) return false;
  const daysUntil = Math.ceil((new Date(next.date) - new Date(asOfDate)) / 86400000);
  return daysUntil <= 5;
}

/* Most recent ^VIX close on/before `dateStr`, from a newest-first VIX EOD series
   (handles weekends/holidays like spyCloseAsOf). null when unavailable. */
function vixCloseAsOf(vixHist, dateStr) {
  if (!Array.isArray(vixHist) || !vixHist.length) return null;
  for (const b of vixHist) if (b.date <= dateStr) return b.close;
  return null;
}

/* Full EOD-subset score detail for one historical close — the reconstructable
   part of scoreTickerQuickSwing, reusing the same factor functions and
   multipliers. Returns the verdict PLUS the per-factor buy/sell points and value
   (for the factor-attribution study) and the entry bar / atr5 (for the exit
   study). historicalVerdict() below delegates here and returns just .verdict, so
   the seed replay's behavior is unchanged. The AH leg is n/a historically (no
   after-hours series), so it is excluded from the returned `factors`. */
export function historicalScoreDetail(hAsOf, spyAsOf, earningsHist, asOfDate, gapTiers = GAP_DAMPER_TIERS, vixHist = null, opts = {}) {
  const mRsi = checkRsi2(hAsOf);
  const mBoll = checkBollinger(hAsOf);
  const mClx = checkVolumeClimax(hAsOf);
  const mRev = checkReversalCandle(hAsOf);
  const mRs = checkRelativeStrength(hAsOf, spyAsOf);
  const mAh = naMirror("No historical after-hours data"); // AH leg — not reconstructable
  const mirrored = [mRsi, mBoll, mClx, mRev, mRs, mAh];
  const dry = checkVolumeDryUp(hAsOf);
  const exp = checkAtrExpansion(hAsOf);
  const shared = [dry, exp];
  const adr = checkAdr(hAsOf);
  const liq = checkLiquidity(hAsOf);

  // Factor-attribution A/B hook: opts.maskFactors is a Set of factor keys whose
  // points are zeroed before scoring, so a study can measure "what if we dropped
  // factor X". No mask (the production path) = exact original behavior.
  const mask = opts.maskFactors instanceof Set ? opts.maskFactors : null;
  const keyed = [["RSI", mRsi], ["%B", mBoll], ["CLX", mClx], ["REV", mRev], ["RS", mRs], ["AH", mAh]];
  const keyedShared = [["DRY", dry], ["EXP", exp]];
  const rawBuyScore = keyed.reduce((s, [k, c]) => s + (mask?.has(k) ? 0 : (c.buy.points ?? 0)), 0)
    + keyedShared.reduce((s, [k, c]) => s + (mask?.has(k) ? 0 : (c.points ?? 0)), 0);
  const rawSellScore = keyed.reduce((s, [k, c]) => s + (mask?.has(k) ? 0 : (c.sell.points ?? 0)), 0)
    + keyedShared.reduce((s, [k, c]) => s + (mask?.has(k) ? 0 : (c.points ?? 0)), 0);

  const liqMultiplier = liqMultiplierFor(liq.points);
  const adrMultiplier = adrMultiplierFor(adr.points);
  const regimeFavorable = historicalRegimeFavorable(spyAsOf);
  const regimeMultiplierBuy = regimeFavorable === false ? 0.85 : 1.0;
  const regimeMultiplierSell = regimeFavorable === false ? 1.15 : 1.0;
  // VIX leg: reconstructed from ^VIX EOD history (available on historical-price-
  // eod/full, even though it's absent from the /quote endpoint the live scorer
  // uses). When vixHist isn't supplied it degrades to neutral (1.0). The AH leg
  // stays neutral (naMirror above) — there is no historical after-hours series.
  const vixMult = classifyVix(vixCloseAsOf(vixHist, asOfDate))?.multiplier ?? 1.0;
  // Overnight-gap damper reconstructs cleanly from EOD bars (prior close → open),
  // so — unlike the AH leg — the replay honors it exactly as the live scorer does,
  // on both sides. `gapTiers` is threaded through so the calibration harness can
  // A/B it (pass null to disable for the baseline arm).
  const gapMult = gapMultiplier(overnightGapProfile(hAsOf), gapTiers);

  const buyScore = Math.min(QS_MAX_SCORE, Math.round(rawBuyScore * liqMultiplier * adrMultiplier * regimeMultiplierBuy * vixMult * gapMult));
  const sellScore = Math.min(QS_MAX_SCORE, Math.round(rawSellScore * liqMultiplier * adrMultiplier * regimeMultiplierSell * vixMult * gapMult));
  const blocked = historicalEarningsBlocked(earningsHist, asOfDate);
  const { forceBuy, forceSell } = extremeReads(mirrored);
  let { verdict } = deriveVerdict({ buyScore, sellScore, blocked, forceBuy, forceSell });
  // Same high-conviction gates as the live scorer — a BUY must be a market leader
  // (RS ≥ 0), a SELL must be a laggard (RS ≤ 0). (The replay gates every entry;
  // the live scorer only gates fresh ones, but a re-gate that returns NEUTRAL is
  // never itself an exit in the trade log, so the two converge on closed trades.)
  if (verdict === "BUY" && !buyConvictionOk(mirrored)) verdict = "NEUTRAL";
  if (verdict === "SELL" && !sellConvictionOk(mirrored)) verdict = "NEUTRAL";

  const b0 = hAsOf[0];
  return {
    verdict, buyScore, sellScore, forceBuy, forceSell, blocked,
    regimeFavorable,
    bar: { date: b0.date, open: b0.open, high: b0.high, low: b0.low, close: b0.close },
    atr5: atrFrom(hAsOf, 0, 5),
    // Per-factor points on each side + raw value. Shared factors (DRY/EXP) feed
    // both sides equally, so buy === sell for those.
    factors: [
      { key: "RSI", buy: mRsi.buy.points, sell: mRsi.sell.points, value: mRsi.value },
      { key: "%B",  buy: mBoll.buy.points, sell: mBoll.sell.points, value: mBoll.value },
      { key: "CLX", buy: mClx.buy.points, sell: mClx.sell.points, value: mClx.value },
      { key: "REV", buy: mRev.buy.points, sell: mRev.sell.points, value: mRev.value },
      { key: "RS",  buy: mRs.buy.points, sell: mRs.sell.points, value: mRs.value },
      { key: "DRY", buy: dry.points, sell: dry.points, value: dry.value },
      { key: "EXP", buy: exp.points, sell: exp.points, value: exp.value },
    ],
    gates: { adr: adr.points, liq: liq.points },
  };
}

/* Compute just the headline verdict for one historical close. Thin wrapper over
   historicalScoreDetail — passes QS_DESCORED so the seed replay scores the same
   factors the live scorer does (REV excluded), keeping the Backtest Log and the
   live table consistent. (historicalScoreDetail itself stays neutral — scores
   whatever it's told — so the attribution/A-B tooling can still toggle REV.) */
function historicalVerdict(hAsOf, spyAsOf, earningsHist, asOfDate, gapTiers = GAP_DAMPER_TIERS, vixHist = null) {
  return historicalScoreDetail(hAsOf, spyAsOf, earningsHist, asOfDate, gapTiers, vixHist, { maskFactors: QS_DESCORED }).verdict;
}

/* Replay the last `daysBack` sessions and fold each day's verdict through the
   same transition logic the live loop uses, producing a seeded trade log. */
export function replayQuickSwingTrades(sym, hist, spyHist, earningsHist, { daysBack = BT_SEED_DAYS, gapTiers, vixHist = null } = {}) {
  let log = emptyLog();
  if (!hist || hist.length < 21) return log; // not enough bars to score anything
  // Oldest → newest over the trailing window, so trades open/close in order.
  const dates = hist.slice(0, daysBack).map(b => b.date).reverse();
  for (const date of dates) {
    const hAsOf = histAsOf(hist, date);
    if (hAsOf.length < 21) continue;
    const spyAsOf = spyHist ? histAsOf(spyHist, date) : null;
    // gapTiers === undefined → production default (damper on); pass null to disable.
    const verdict = historicalVerdict(hAsOf, spyAsOf, earningsHist, date,
      gapTiers === undefined ? GAP_DAMPER_TIERS : gapTiers, vixHist);
    const b0 = hAsOf[0];
    const syntheticRow = {
      sym,
      price: b0.close,
      open: b0.open,    // for the stop-loss gap-vs-touch fill in recordQuickswingTransition
      low: b0.low,      // a long stop breach on a daily bar is the LOW piercing the stop
      high: b0.high,    // a short stop breach is the HIGH piercing the stop above
      atr5: atrFrom(hAsOf, 0, 5), // pins the entry-time stop at entry ± 2.5×ATR
      priceIsLive: false,
      verdict,
      scored_at: `${date}T21:00:00.000Z`, // ~US market close
    };
    log = recordQuickswingTransition(syntheticRow, log);
  }
  // Tag each closed trade with SPY's return over the same dates (buy-and-hold
  // benchmark) — spyHist is right here, so it's free to compute during replay.
  annotateBenchmarks(log, spyHist);
  return log;
}

/* Fetch what the replay needs and produce the seed log. Own FMP fetch (hist +
   earnings); SPY history is passed in from the shared regime object to avoid a
   redundant index fetch. Called once, the first time a ticker is tracked. */
export async function seedQuickSwingBacktest(sym, { daysBack = BT_SEED_DAYS, spyHist = null, vixHist = null } = {}) {
  const t = sym.toUpperCase();
  let rawHist = [], earningsHist = [];
  try {
    rawHist = await safe("historical-price-eod/full", t, "&limit=320"); await delay(200);
    earningsHist = await safe("earnings", t, "&limit=12");
  } catch (e) {
    console.error(`[quickswing] ${t} seed fetch error:`, e?.message || e);
    return emptyLog();
  }
  const hist = cleanHist(rawHist);
  return replayQuickSwingTrades(t, hist, spyHist, earningsHist, { daysBack, vixHist });
}
