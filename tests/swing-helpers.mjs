/* Shared synthetic-data builders for the Swing test suite. Pure + deterministic:
   every bar carries a valid ISO date, positive close, and OHLC, so the factor
   ladders and the backtest engine see well-formed input. Dates descend by
   calendar day from a fixed base (index 0 = newest) — the factors index by
   array position, and the engine tests that care about date arithmetic set
   dates explicitly. */

// Subtract `i` calendar days from an ISO date (no wall-clock use).
export function isoMinus(base, i) {
  const t = Date.parse(base + "T00:00:00Z") - i * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}

// Build a newest-first hist from a newest-first close array. Per-bar overrides
// via `over` (index -> {open,high,low,close,volume}).
export function mkHist(closes, { startDate = "2026-07-08", vol = 1_000_000, hl = 0.01, over = {} } = {}) {
  return closes.map((c, i) => {
    const o = over[i] || {};
    const close = o.close ?? c;
    return {
      date: o.date ?? isoMinus(startDate, i),
      open: o.open ?? close,
      high: o.high ?? close * (1 + hl),
      low: o.low ?? close * (1 - hl),
      close,
      volume: o.volume ?? vol,
    };
  });
}

// Newest-first closes from [[count,val],...] segments (newest segment first).
export function seg(segments) {
  const out = [];
  for (const [count, val] of segments) for (let k = 0; k < count; k++) out.push(val);
  return out;
}

// A 3-segment trend series: index0 = P, next 49 = A, rest (to n) = B.
// sma50 = (P + 49A)/50, sma200 = (P + 49A + (n-50)B)/n — hand-computable.
export function trendHist(P, A, B, n = 200) {
  return mkHist(seg([[1, P], [49, A], [n - 50, B]]));
}
