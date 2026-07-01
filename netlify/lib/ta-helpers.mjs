/* ---------- Shared technical-analysis helpers ----------
   Used by both short-pipeline.mjs (2-12wk swing) and quickswing-pipeline.mjs
   (1-2 day mean-reversion) so the math can't drift between the two scoring
   engines. Everything here operates on newest-first OHLCV arrays — each
   element needs {high, low} and either {close} or {price} (FMP's "light"
   feed uses `price`; the "full" feed we actually fetch uses `close`). */

export function round2(x) {
  return x == null ? null : Number(x.toFixed(2));
}

/* ---------- Scoring result shape ----------
   Each check returns { points: 0-3 | null, verdict, summary, value }.
   points null = "na" (data unavailable); 0 = bad, 1 = weak, 2 = ok, 3 = good. */
export function na(summary) {
  return { points: null, verdict: "na", summary, value: null };
}
export function scored(points, summary, value) {
  const verdict = points >= 3 ? "good" : points >= 2 ? "ok" : points >= 1 ? "weak" : "bad";
  return { points, verdict, summary, value };
}

/* ---------- Average True Range ----------
   True Range for one bar: needs today's high/low and yesterday's close.
   Wilder's definition — the largest of the three gaps a stop could get run
   through overnight (today's range, or a gap up/down from yesterday's close). */
export function trueRange(hi, lo, prevClose) {
  if (hi == null || lo == null || prevClose == null) return null;
  return Math.max(hi - lo, Math.abs(hi - prevClose), Math.abs(lo - prevClose));
}
/* Average True Range over `n` periods starting at index `from` in a
   newest-first array (index 0 = most recent bar). Each element needs
   {high, low} and either {close} or {price}. Needs n+1 bars (the (n+1)th
   bar only supplies its close, as "yesterday" for the nth bar's TR).
   Simple average, not Wilder's exponential smoothing — deliberate choice
   to keep the math (and the moving stop-line curve) easy to reason about;
   the two variants converge after ~30 bars and diverge by single-digit %
   before that. */
export function atrFrom(arr, from, n) {
  let s = 0, c = 0;
  for (let k = from; k < from + n && k + 1 < arr.length; k++) {
    const d = arr[k], p = arr[k + 1];
    const tr = trueRange(d?.high, d?.low, p?.close ?? p?.price);
    if (tr != null) { s += tr; c++; }
  }
  return c ? s / c : null;
}
