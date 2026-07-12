# Swing Tab — Hold-Time Sensitivity Report (3 → 12 months)

_Repo: gnocchi.website screener · generated 2026-07-11 · FMP cache newest bar 2026-07-07._
_Method: deterministic off-cache reconstruction using the LIVE swing entry gate (`netlify/lib/short-backtest.mjs::computeShortSignal` → `.entryStrong`, byte-identical to the site) over the broad 488-name universe cache (`scratchpad/swing-validate/universe500-cache.json`, 2021-07-08 → 2026-07-07, ~5y). Only the exit horizon is varied; the entry set and the shipped v4 exit stack (40% hard catastrophe stop, no death-cross, no ATR, no take-profit) are held fixed. Harness: `scripts/swing-validate/holdtime-sweep.mjs` (sweep) + `holdtime-byperiod.mjs` (regime cut). Artifact: `scratchpad/swing-validate/holdtime-sweep.json`._

_Trigger: the user observed the shipped panel (56% win, +18.23% avg P/L, +$216,988, "+15.51% edge vs SPY") and asked (a) why it looks so successful vs a prior 25% win rate, and (b) what happens if the 63-session (~3-month) hold is widened to 4…12 months. Decision (2026-07-11): **document only, no engine change.**_

---

## TL;DR

**Widening the hold makes every headline number bigger — and almost none of it is edge.** On a fixed set of 5,565 trades (each with a full 12-month runway, so only the exit horizon changes), average P/L rises from **2.55% (3mo) to 17.43% (12mo)** and win rate from **53% to 64%** — but SPY buy-and-hold over the *same windows* rises in near-lockstep, so the honest metric, **edge vs SPY per trade, stays inside ±1% the whole way** (−1.09% at 3mo, ~0 at 6mo, +0.2–0.4% at 7–12mo — noise, below realistic round-trip cost). The extra return is added market **beta**, not timing skill.

**The one real, defensible finding:** the current **63-day cap is too tight and clips winners** — 98% of trades exit exactly at the cap, guillotining the trend-follower's fat right tail. Loosening toward **~6 months (126 sessions)** flips edge-vs-SPY from −1.1% to roughly breakeven and lifts return-per-day. That is *not* new alpha; it is just letting a trend trade run (standard practice). Beyond ~7 months nothing improves — per-day return plateaus at ~0.07% and 12mo merely parks capital longer (1 turn/yr vs 4).

**Why the panel looks so much better than this:** the panel is a **119-trade, ~6-month, curated semis/mega-tech watchlist** slice through the H1-2026 chip rip (MRVL +194%, the LRCX/ASML/MU cluster). Across the full 488-name population at the shipped 63-day hold, edge-vs-SPY by entry year is **−1.9 / +0.9 / −1.1 / −1.1 / −0.2** for 2022–2026 — it beat SPY in one year of five. The panel's "+15.51% edge" is selection + survivorship + one hot regime, **not a repeatable edge** — the same verdict as the Bounce audit ([bounce-validation-report.md](bounce-validation-report.md)) and the semis-reversal research ([semis-reversal-research.md](semis-reversal-research.md)).

**On win rate:** 56% vs a prior "25%" compares two different strategies/exits; win rate is not a measure of edge, and it rises mechanically with hold length on the *identical* trade set (53% → 64% below). It is not evidence the timing improved.

---

## 1. Hold-time sweep — the clean test (constant cohort)

5,565 entries that all have ≥252 forward bars available, so every row is the **same trades** and only the time-stop differs. Entry gate = shipped `entryStrong` (techScore≥12 AND px>50DMA>200DMA AND avgDollarVol≥$300M/day), long-only, one sample per fresh strong transition. Exit = 40% hard catastrophe stop, then TIME cap at H. SPY = buy-and-hold over each trade's own entry→exit window.

| hold (H) | months | avg P/L | SPY same days | **edge vs SPY** | win % | ret/day held | worst | % exit at cap |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 63 (now) | 3 | 2.55% | 3.64% | **−1.09%** | 52.9 | 0.04% | −46.5% | 98.1% |
| 84 | 4 | 4.20% | 4.96% | −0.76% | 55.0 | 0.05% | −47.3% | 97.3% |
| 105 | 5 | 5.81% | 6.23% | −0.43% | 58.2 | 0.06% | −52.5% | 96.5% |
| **126** | **6** | **7.89%** | **7.84%** | **+0.06%** | 60.5 | 0.06% | −52.5% | 95.6% |
| 147 | 7 | 9.88% | 9.47% | +0.41% | 62.4 | 0.07% | −52.5% | 94.9% |
| 168 | 8 | 11.28% | 10.89% | +0.39% | 63.0 | 0.07% | −52.5% | 94.2% |
| 189 | 9 | 12.55% | 12.34% | +0.20% | 62.9 | 0.07% | −52.5% | 93.6% |
| 210 | 10 | 14.19% | 13.99% | +0.20% | 63.3 | 0.07% | −52.5% | 93.0% |
| 231 | 11 | 16.07% | 15.66% | +0.41% | 63.3 | 0.07% | −52.5% | 91.8% |
| 252 | 12 | 17.43% | 17.11% | +0.33% | 63.6 | 0.07% | −52.5% | 90.9% |

Reading it:
- **Raw return and win rate climb monotonically** with hold length — but so does the SPY benchmark. The two rise together; the gap (edge) is the flat line.
- **Edge crosses from negative to ~zero around 6 months.** At the shipped 3-month setting the strategy actually *underperforms* just holding SPY the same days by ~1.1pp/trade on this cohort. The best edge anywhere (~+0.4% at 7 and 11mo) is economically negligible and below a realistic 0.2–0.4% round-trip.
- **Per-day return** (capital efficiency) improves 0.04% → 0.07% going 3mo → ~7mo, then plateaus — the 3-month cap was the only place it was materially hurting itself (clipping winners), and that's fixed by ~7mo.
- **Tail risk per trade barely moves** (−46% to −52%; the excess past the 40% cap is overnight gap-through). Longer holds don't materially worsen the single-trade tail.

### Why NOT to read the "all-entries" version as a positive edge

Running the same sweep on *all* 8,267 entries (not just the full-runway cohort) shows edge rising to +1.8% at 12mo — but that is an artifact: `pctEOD` (trades truncated by the end of the cache) climbs to **30%** at 12mo, so recent entries in the ongoing bull get booked at a still-rising close with no room to mean-revert. The constant-cohort table above removes that confound and is the number to trust.

---

## 2. The edge is beta — regime cut by entry year

Same shipped-gate entries, cut by entry year, at the current 63-day hold and a 126-day (6mo) hold (`holdtime-byperiod.mjs`):

| entry year | n | edge vs SPY @ 3mo | edge vs SPY @ 6mo |
|---|---:|---:|---:|
| 2022 | 500 | **−1.9%** | −1.2% |
| 2023 | 1,447 | +0.9% | +3.4% |
| 2024 | 2,535 | **−1.1%** | +0.8% |
| 2025 | 2,436 | **−1.1%** | +0.3% |
| 2026 | 1,349 | −0.2% | +0.2% |

The signal's timing beats SPY in one year out of five at the shipped hold (2023, the post-2022-bottom recovery). Everywhere else it is flat-to-negative. Loosening the hold to 6mo helps a little (less winner-clipping) but never manufactures alpha — the return is the market's, not the signal's. This is entirely consistent with the swing calibration report's framing ([swing-calibration-report.md](swing-calibration-report.md)): "a mega-cap momentum/**beta** screen; every positive number is a survivorship upper bound."

---

## 3. Reconciling the panel's "+15.51% edge vs SPY"

The shipped panel replays only the last ~130 sessions (~6 months, `SBT_SEED_SESSIONS`) on the seeded watchlist — a curated, liquid semis/mega-tech set — and books 119 trades at a median 91-day hold. That slice caught the H1-2026 semiconductor rip (MRVL +194%, plus the LRCX/ASML/MU/TSM cluster), so its per-trade edge balloons. It is real *in that window on those names*, and non-transferable: the population edge over the same entry rule is ~0-to-negative (§2). This is the exact curated-few → broad-population collapse the Bounce audit documented (curated-5 PF 1.68 → broad-488 PF 1.016).

Conclusion for the user's first question — "how did it become so successful?": it did **not** become a better stock-timer. It became a long-only, high-beta mega-cap basket, measured on today's survivors, over a bull market, on a hand-picked recent window, with an exit tuned in-sample. The panel's honesty banner already says the operative truth: *no demonstrated market-timing edge — captures market beta, not alpha.*

---

## 4. Recommendation (surfaced; no engine change made per the user's decision)

1. **If the hold is ever recalibrated, ~126 sessions (6mo) is the defensible target**, not 12 — it stops the 63-day cap from clipping winners (edge −1.1% → ~0, per-day return up) without pretending to add alpha. Would bump `SBT_TIME_STOP_DAYS` 63→126 and `SBT_SEED_VERSION` 4→5 (forces a one-time re-seed). Beyond ~7mo there is no improvement, only lower capital turnover.
2. **Keep — and do not soften — the honesty copy.** "Hold longer = more money" here is "the market went up more." Any UI that surfaces longer holds should keep presenting this as beta/momentum exposure, never as a market-beating edge.
3. **Do not read win rate as success.** It rises mechanically with hold length on identical trades; it is not an edge metric for a let-winners-run strategy.

## Boundary of this study (completeness critic)

- **Sample:** 2021-07 → 2026-07, ~5y, heavily bull (SPY > 200DMA most of the window); only 2022 is a real bear leg (and there the strategy underperformed SPY at both holds). No 2008/2018/2020-scale stress in the base.
- **Survivorship:** the 488 names are today's survivors; every positive number is an upper bound. A point-in-time universe with delisted names would push edges lower, not higher.
- **Entry convention:** independent overlap-allowed transitions (the standard exit-study convention, maximizes sample); the shipped log is sequential one-position-at-a-time, so absolute cumulative-$ differs, but the cross-horizon comparison (the whole point) is unaffected.
- **Cost:** results are gross. Every edge in §1 is below a realistic 0.2–0.4% round-trip, so net-of-cost the "positive" pockets go to zero or negative.
