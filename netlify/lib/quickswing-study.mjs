/* ===== QUICK SWING — offline study harness (analysis only, not deployed) =====
   Pure functions that turn the historical replay into two studies:

     1. Factor attribution — for each of the 7 EOD-reconstructable factors, how
        does its points-at-entry relate to the trade's forward return? (Which
        factors actually predict the bounce vs. add noise.)
     2. Exit-rule grid — replays each entry under a grid of exit rules
        (profit-target × time-stop, on top of the 2.5×ATR stop) and ranks them by
        expectancy, so we can replace today's stop-or-flip-only exit with whatever
        the data says captures the bounce best.

   Sampling model: an "entry" is a FRESH verdict transition into BUY/SELL (prev
   session's verdict was a different side) — one sample per oversold/overbought
   episode, not one per persistent day. Entries are treated as INDEPENDENT events
   (overlapping trades allowed) so a rule's per-trade expectancy is measured with
   maximum samples and no path-dependence on the exit choice. That means the grid
   ranks RULE QUALITY, not a capital-constrained portfolio — a separate
   non-overlapping sim would be needed for that (noted where it matters).

   Reuses historicalScoreDetail() from quickswing-pipeline.mjs, so every factor
   value here is byte-identical to what the live/replay scorer computes.
   Removable with the QUICK SWING FEATURE block (analysis tooling only). */
import { histAsOf, historicalScoreDetail } from "./quickswing-pipeline.mjs";

export const FACTOR_KEYS = ["RSI", "%B", "CLX", "REV", "RS", "DRY", "EXP"];
const QS_STOP_ATR_MULT = 2.5; // must match computeStop in quickswing-pipeline.mjs
const sideSign = (side) => (side === "short" ? -1 : 1);

function sma(closes, n) {
  if (!closes || closes.length < n) return null;
  let s = 0; for (let k = 0; k < n; k++) s += closes[k];
  return s / n;
}

/* ---------- Stats helpers ---------- */
export function mean(a) { return a.length ? a.reduce((s, x) => s + x, 0) / a.length : null; }
export function winRate(a) { return a.length ? a.filter(x => x > 0).length / a.length : null; }
export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = mean(xs), my = mean(ys);
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; num += a * b; dx += a * a; dy += b * b; }
  const den = Math.sqrt(dx * dy);
  return den > 0 ? num / den : null;
}
export function profitFactor(rets) {
  let win = 0, loss = 0;
  for (const r of rets) { if (r > 0) win += r; else loss += -r; }
  return loss > 0 ? win / loss : (win > 0 ? Infinity : null);
}

/* ---------- 1. Labeling: entries + forward bars for one ticker ----------
   `hist`/`spyHist` are newest-first (index 0 = most recent). For a signal at
   index i, forward bars are the more-recent indices i-1, i-2, … i-maxHorizon. */
export function labelTicker(sym, hist, spyHist, earningsHist, { minBars = 200, maxHorizon = 10, vixHist = null } = {}) {
  const out = [];
  if (!Array.isArray(hist) || hist.length < minBars + 2) return out;
  const len = hist.length;

  // Detail (verdict + factors) and 5-SMA at every index with enough history.
  const detailAt = new Array(len).fill(null);
  const sma5At = new Array(len).fill(null);
  for (let i = len - 1; i >= 0; i--) {
    const hAsOf = hist.slice(i);
    if (hAsOf.length < minBars) continue;
    const date = hist[i].date;
    const spyAsOf = spyHist ? histAsOf(spyHist, date) : null;
    if (spyAsOf && spyAsOf.length < minBars) continue; // keep the SPY regime well-defined
    detailAt[i] = historicalScoreDetail(hAsOf, spyAsOf, earningsHist, date, undefined, vixHist);
    sma5At[i] = sma(hAsOf.map(b => b.close), 5);
  }

  const sideOf = (v) => (v === "BUY" ? "long" : v === "SELL" ? "short" : null);
  const factorVal = (d, key) => d?.factors?.find(f => f.key === key)?.value ?? null;

  for (let i = 0; i < len; i++) {
    const d = detailAt[i];
    if (!d) continue;
    const side = sideOf(d.verdict);
    if (!side) continue;
    const prevSide = sideOf(detailAt[i + 1]?.verdict);
    if (prevSide === side) continue; // not a fresh transition — skip the persistent signal

    const fwd = [];
    for (let h = 1; h <= maxHorizon && i - h >= 0; h++) {
      const j = i - h;
      const b = hist[j];
      const dj = detailAt[j];
      fwd.push({
        date: b.date, open: b.open, high: b.high, low: b.low, close: b.close,
        rsi2: factorVal(dj, "RSI"), pctB: factorVal(dj, "%B"),
        sma5: sma5At[j] ?? null, verdict: dj?.verdict ?? null,
      });
    }
    if (!fwd.length) continue;

    out.push({
      sym, side, entryDate: hist[i].date, entryClose: hist[i].close,
      atr5: d.atr5 ?? null, regimeFavorable: d.regimeFavorable,
      factors: d.factors, fwd,
    });
  }
  return out;
}

/* Forward return at horizon H (percent), signed so positive = trade went your way. */
export function fwdReturn(rec, H) {
  const bar = rec.fwd[Math.min(H, rec.fwd.length) - 1];
  if (!bar) return null;
  return sideSign(rec.side) * ((bar.close - rec.entryClose) / rec.entryClose) * 100;
}

/* ---------- 2. Factor attribution ----------
   For each factor: entries bucketed by the factor's points on the ENTRY side
   (buy points for longs, sell points for shorts) → avg forward return + win rate
   per bucket, plus an overall points→return correlation (IC). A factor whose
   higher buckets don't earn higher forward returns is not pulling its weight. */
export function attributionReport(records, { horizon = 3 } = {}) {
  const report = {};
  for (const key of FACTOR_KEYS) {
    const buckets = { 0: [], 1: [], 2: [], 3: [] };
    const xs = [], ys = [];
    for (const rec of records) {
      const f = rec.factors.find(ff => ff.key === key);
      if (!f) continue;
      const pts = rec.side === "short" ? f.sell : f.buy;
      const ret = fwdReturn(rec, horizon);
      if (pts == null || ret == null) continue;
      const b = Math.max(0, Math.min(3, Math.round(pts)));
      buckets[b].push(ret);
      xs.push(pts); ys.push(ret);
    }
    report[key] = {
      n: xs.length,
      ic: pearson(xs, ys),
      buckets: Object.fromEntries(
        Object.entries(buckets).map(([k, arr]) => [k, { n: arr.length, avgRet: mean(arr), winRate: winRate(arr) }])
      ),
    };
  }
  return report;
}

/* ---------- 3. Exit-rule grid ---------- */
function targetHit(rule, rec, bar) {
  const long = rec.side === "long";
  switch (rule.target) {
    case "firstUp":   return long ? bar.close > rec.entryClose : bar.close < rec.entryClose;
    case "rsi65":     return bar.rsi2 != null && (long ? bar.rsi2 >= 65 : bar.rsi2 <= 35);
    case "rsi70":     return bar.rsi2 != null && (long ? bar.rsi2 >= 70 : bar.rsi2 <= 30);
    case "close5sma": return bar.sma5 != null && (long ? bar.close >= bar.sma5 : bar.close <= bar.sma5);
    case "pctB50":    return bar.pctB != null && (long ? bar.pctB >= 0.5 : bar.pctB <= 0.5);
    case "pctX": {
      const g = long ? (bar.close - rec.entryClose) / rec.entryClose : (rec.entryClose - bar.close) / rec.entryClose;
      return g >= (rule.pctX ?? 0.03);
    }
    default: return false; // "none"
  }
}

function pnlPct(rec, exitPrice) {
  return sideSign(rec.side) * ((exitPrice - rec.entryClose) / rec.entryClose) * 100;
}

/* Simulate one entry under one exit rule → {pnl, hold, reason}. Exit priority per
   forward bar: (1) ATR stop intrabar, (2) profit target at the close, (3) verdict
   flip at the close, (4) time stop. Runs out of bars → close at last close. */
export function simulateExit(rec, rule) {
  const long = rec.side === "long";
  const stopPrice = (rule.useAtrStop !== false && rec.atr5 > 0)
    ? (long ? rec.entryClose - QS_STOP_ATR_MULT * rec.atr5 : rec.entryClose + QS_STOP_ATR_MULT * rec.atr5)
    : null;

  for (let k = 0; k < rec.fwd.length; k++) {
    const bar = rec.fwd[k];
    const day = k + 1;

    if (stopPrice != null) {
      if (long && bar.low > 0 && bar.low <= stopPrice) {
        const fill = bar.open > 0 && bar.open <= stopPrice ? bar.open : stopPrice; // gap-through fills at open
        return { pnl: pnlPct(rec, fill), hold: day, reason: "STOP" };
      }
      if (!long && bar.high > 0 && bar.high >= stopPrice) {
        const fill = bar.open > 0 && bar.open >= stopPrice ? bar.open : stopPrice;
        return { pnl: pnlPct(rec, fill), hold: day, reason: "STOP" };
      }
    }
    if (targetHit(rule, rec, bar)) return { pnl: pnlPct(rec, bar.close), hold: day, reason: "TARGET" };
    if (rule.useFlip && ((long && bar.verdict === "SELL") || (!long && bar.verdict === "BUY"))) {
      return { pnl: pnlPct(rec, bar.close), hold: day, reason: "FLIP" };
    }
    if (rule.timeStop && day >= rule.timeStop) return { pnl: pnlPct(rec, bar.close), hold: day, reason: "TIME" };
  }
  const last = rec.fwd[rec.fwd.length - 1];
  return { pnl: pnlPct(rec, last.close), hold: rec.fwd.length, reason: "EOD" };
}

export function aggregateRule(records, rule) {
  const rets = [], holds = [], reasons = {};
  for (const rec of records) {
    const r = simulateExit(rec, rule);
    rets.push(r.pnl); holds.push(r.hold);
    reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  }
  const exp = mean(rets), avgHold = mean(holds);
  return {
    n: rets.length,
    expectancy: exp,
    // Return per day held — the fair comparison when rules have very different
    // hold times (a 9-day "let it ride" earning 2% is worse per-day than a 2-day
    // target exit earning 0.8%, and ties up capital 4× longer).
    expPerDay: exp != null && avgHold ? exp / avgHold : null,
    winRate: winRate(rets),
    profitFactor: profitFactor(rets),
    avgHold,
    reasons,
  };
}

/* Default grid: {none, firstUp, rsi65, close5sma, pctB50} × {no time stop, 3d, 4d},
   ATR stop always on, flip on. `none` + no-time-stop ≈ today's behavior (baseline). */
export function defaultExitGrid() {
  const targets = ["none", "firstUp", "rsi65", "rsi70", "close5sma", "pctB50"];
  const times = [null, 2, 3, 4];
  const rules = [];
  for (const target of targets) {
    for (const timeStop of times) {
      rules.push({ target, timeStop, useAtrStop: true, useFlip: true, label: `${target}${timeStop ? `+${timeStop}d` : ""}` });
    }
  }
  return rules;
}

export function exitGridReport(records, rules = defaultExitGrid()) {
  return rules
    .map(rule => ({ rule: rule.label, ...aggregateRule(records, rule) }))
    .sort((a, b) => (b.expPerDay ?? -1e9) - (a.expPerDay ?? -1e9)); // fair metric for a short-horizon strategy
}
