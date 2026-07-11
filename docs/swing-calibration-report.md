# Swing Tab — Risk-First Calibration Report

_Repo: gnocchi.website screener · branch `feat/swing-risk-calibration` · generated 2026-07-10._
_Method: deterministic off-cache reconstruction using the offline study twin (`scripts/swing-validate/lib.mjs` → `netlify/lib/short-study.mjs`), on the 90-survivor and broad 488-name universes, with the LIVE gates re-applied (uptrend px>50>200 via `TREND.buy≥2`; $300M/day per-name liquidity floor). Every finding below was put through a perspective-diverse adversarial-verification pass (3 skeptics per finding, prompted to REFUTE against look-ahead / survivorship / OOS / effective-N / multiple-testing / plateau / portfolio-risk), plus an industry-exit-conventions survey and a completeness critic. The headline framing here is the one that SURVIVED that pass — several first-round claims were refuted and are corrected below._

Artifacts: `scratchpad/swing-validate/calib-{core,portfolio-ci,entry-filters,exit-sector}.json`. Tests: `tests/swing-{factors,signal,engine}.test.mjs` (green). Prior work this builds on: [swing-validation-report.md](swing-validation-report.md).

---

## TL;DR

Two changes ship, and one of them is the real fix for the complaint that started this.

1. **The −47% HON "trade" was a stock-split data bug, not a risk-management failure.** FMP's `historical-price-eod/full` feed is **unadjusted** (no `adjClose`); HON executed a **1:2 split on 2026-06-29** (confirmed via FMP's `/stable/splits`), so its price halved (464.42 → 232.21) overnight and the engine booked a phantom −47% STOP. **Fix:** back-adjust every ticker's price series for splits before any factor or exit reads it (`adjustSplits`, wired into the live scorer + the seed replay). Once adjusted, HON's −48% "gap" becomes the real +3.8%, and the worst *genuine* trade in the whole backtest is ~−31% (COIN, on the 2024-08-05 macro crash) — **inside** the new stop.

2. **Exit: a plain 63-day hold + a loose 40% catastrophe stop** replaces the incumbent (4×ATR stop + 50/200 death-cross + 63-day cap). The death-cross and the tight 4×ATR stop both **clip winners**; dropping them raises out-of-sample per-trade expectancy (3.72 vs 2.79) and matches standard trend-following practice. The 40% cap is a rarely-fired backstop that bounds the single-trade non-gap tail (−64% ride-down → −40%) at ~zero portfolio cost.

**Honest framing:** the exit change is justified by **OOS expectancy + industry convention**, NOT by a statistical portfolio-risk win — name-clustered bootstrap CIs for the new rule and the incumbent overlap heavily. This remains a mega-cap momentum/**beta** screen; every positive number is a survivorship upper bound.

---

## 1. Root cause of the −47% HON: unadjusted split (the real fix)

`historical-price-eod/full` returns raw OHLC with no split/spinoff adjustment. Of the **six** >30% overnight "gaps" in the entire gated backtest, exactly **one** is a data artifact:

| Gap | Cause | Real? |
|---|---|---|
| **HON −48.1%** (2026-06-29) | 1:2 stock split (FMP `/stable/splits`) | ❌ data artifact |
| TTD −30.4% (2025-02-13) | Q4 earnings miss | ✅ real |
| DELL **+31.7%** (2024-03-01) | AI earnings pop | ✅ real (a win) |
| ORCL **+32.2%** (2025-09-10) | earnings pop | ✅ real (a win) |
| CVNA **+35.7% / +37.7%** | earnings pops | ✅ real (wins) |

A magnitude-only gap guard was **rejected** — it would corrupt real earnings moves (e.g. CVNA +37.7%). The fix uses FMP's authoritative splits calendar. `adjustSplits(hist, splits)` (in `quickswing-pipeline.mjs`, shared) back-adjusts every bar before a split by the cumulative `numerator/denominator` factor (volume inversely); it is a no-op for the ~all names/bars with no split and for real earnings gaps. Wired into `short-pipeline.mjs` (live scorer, so factors + the fold signal are clean) and `short-backtest-seed.mjs` (historical replay). A split also distorts the SMA/ATR/near-high factors for ~200 bars, so adjusting at the source fixes those too. Because the fix lives in the shared `cleanHist` neighbor, other strategies can adopt it with the same two-line wiring.

---

## 2. Exit calibration — before / after (risk-first)

Measured on universe-488 gated, split effects aside. **Single-path portfolio metrics are razor-fragile** (capital-slot reshuffling), so central estimates below are the name-clustered **bootstrap medians** (400 draws); the single-path headline the first pass leaned on (maxDD −9.54 / Sortino 0.47) was a lucky draw and is NOT used.

| Rule | per-trade exp | OOS exp | worst (adj.) | portfolio maxDD (boot median) | Sortino (boot median) |
|---|---|---|---|---|---|
| **Incumbent** maCross_atr40 (4×ATR + death-cross + 63d) | 2.79 | 2.95 | ~−31% real | ~−21.7 | ~0.236 |
| **Shipped** hold63 + 40% cap | 3.88 | 3.72 | ~−31% real | ~−16 to −18 | ~0.27 |

**What is robust:** (a) adding an ATR stop, a chandelier trail, OR the death-cross exit **strictly worsens both expectancy and drawdown** (they clip winners) — this survived every skeptic; (b) OOS per-trade expectancy is higher for the hold63 family; (c) the 40% cap catches the handful of real >40% slow-bleeds (e.g. MSTR/CVNA under the incumbent) and converts the −64% no-stop ride-down to −40%.

**What is NOT claimed:** portfolio-risk *dominance*. Bootstrap CIs for CAGR, maxDD, and Sortino overlap heavily between the new rule and the incumbent; the effective-N is far below the nominal 179 names (the residual expectancy edge is Technology-concentrated and decays OOS); and the config was chosen from a ~90-config grid without a formal multiple-testing haircut. So the case rests on OOS expectancy + convention, not statistics.

**Cap level.** Swept 12–45%. Tight caps (12–30%) degrade every metric. The 40–45% region is a **worst-trade plateau** where the cap is nearly a no-op on the portfolio path (it fires ~100/6098 times) — so 40% is chosen as a rarely-fired catastrophe backstop, explicitly NOT a portfolio-risk optimizer, and it does NOT bound overnight gaps.

---

## 3. Industry-convention → risk/reward (what standard practice does)

The exit choice was grounded in conventional trend/momentum practice, not just the in-sample sweep:

| Convention | Our rule | Verdict on our config |
|---|---|---|
| Time exit ~3 months (Jegadeesh-Titman) | `hold63` | 63 sessions ≈ the canonical momentum window ✅ |
| 50/200 death-cross exit | `maCross` | Documented to **cause premature exits** in ongoing bull trends and lag — dropping it is orthodox ✅ |
| Tight % / tight ATR trading stop | — | Practice **warns against** tight stops on multi-week momentum (CFA: performance is fragile when too tight, a plateau on the wide side) ✅ |
| Catastrophe / disaster money-stop (Turtle 2×ATR, tested to 5×ATR) | `hardStopPct` (wide) | A ~40% fixed cap is squarely catastrophe-stop territory, not a trading stop ✅ |
| Chandelier / ATR trailing stop (LeBeau 22d/3×ATR) | `trailAtr` | The single most standard trend exit — but every chandelier variant we tested **underperformed** hold63 on this sample. Flagged as the main practice-based enhancement to re-check on clean, split-adjusted, delisted-inclusive data. |

Net: "let it run with a wide disaster backstop, drop the death-cross and the tight stop" is a defensible, convention-consistent configuration.

---

## 4. Tested and REJECTED (with the adversarially-corrected reasons)

- **Tighten liquidity to ≥$500M/day** — **REJECTED.** The flattering numbers (CAGR 20→30, Sortino 0.44→0.66) are a **look-ahead / selection artifact** of the name-static full-history $-vol gate; under a look-ahead-free as-of-entry trailing-60-bar gate the result **reverses** (CAGR 17.3→12.9, Sortino 0.37→0.28). The only robust residual is a modest beta-driven tail reduction (~1.4pp fewer big losers) at the cost of ~40% of breadth. Keep $300M.
- **Earnings-avoidance entry gate** (N=5/7/10d) — **REJECTED (neutral, not harmful).** It does not reduce the tail (2.79 → 2.76–2.81) and cannot block the news-gap tail (HON's next earnings was ~4 weeks out); under bootstrap it neither helps nor hurts risk-adjusted return. It costs ~6–12% of entries plus complexity for zero robust benefit.
- **ATR% ceiling** {6,7,8%} — **REJECTED.** Inert: the $300M floor already removed hyper-vol names; all bootstrap CIs overlap base.
- **Distance-above-200DMA ceiling** {15,25,40%} — **REJECTED.** Delivers a real monotone per-trade tail reduction that does NOT translate into any robust portfolio-maxDD improvement (bootstrap CIs overlap base; median even worsens) while cutting 20–55% of entries — it removes the momentum names that are the signal.
- **Structural-flat-sector exclusion** (drop Defensive/Utilities/Energy/RealEstate) — **REJECTED**, but NOT on the "worsens maxDD" basis (that −11.5→−18.8 single-path swing was refuted — bootstrapped maxDD is essentially equal). Declined on **multiple-testing prudence + per-sector IS/OOS instability** (e.g. Energy sign-flips IS −1.49 → OOS +4.78). Keep per-sector concentration caps for hygiene instead.
- **Vol-inverse position sizing** — **REJECTED as a shipped lever.** A within-noise deleveraging effect (lowers both return and drawdown; per-iteration bootstrap CI includes zero for maxDD and Sortino in every cell), and the live per-ticker as-if engine books a fixed $/trade and cannot implement sizing anyway. Portfolio-path note only.
- **Raise the entry bar above 12** — **REJECTED** (unchanged from the prior validation: monotone-to-the-edge selectivity, no plateau).
- **Factor reweighting** — **REJECTED** (prior validation: equal-weight is gate-clean).

---

## 5. Honesty ledger — survivorship, acceptance bar, open gaps

- **Survivorship:** both universes are today's survivors; the $300M floor filters all 39 reachable delisted names, so the no-stop rule's core tail (a liquid delisting death-spiral) is **un-sampled, not survived** (worst on the delisted names that do enter is −49.57 vs the ATR-stopped −23.99). Every positive number is an upper bound. A point-in-time delisted-inclusive universe is still blocked (FMP 402).
- **Acceptance bar (worst single trade bounded):** **met on the survivor set** (0 non-gap trades worse than −40% once prices are split-adjusted); on the broad universe it holds by construction (the 40% cap makes any sub-cap loss tautologically a gap), and the largest *real* residual gap is ~−31% (COIN). The genuine overnight gap tail is not *bounded* by any stop, but with split-adjustment the artifact tail (HON) is gone and no real trade breaches the cap in-sample.
- **Engine ↔ study parity:** the deployed engine (`short-backtest.mjs`) and the offline twin (`short-study.mjs::simulateShortExit`) are proven to produce the same exit reason + price (±1¢) for the shipped rule — see the parity tests + mutant PROOF in `tests/swing-engine.test.mjs`. `SBT_SEED_VERSION` bumped 3→4, which re-seeds every log under the new rule.
- **Open gaps (for a future pass):** a true rolling walk-forward (only a single IS/OOS split was run, and the tail is worse OOS); a delisted-inclusive re-run at the shipped config; re-checking a chandelier trail on clean split-adjusted data; and per-name partition of the residual gap tail into scheduled-earnings vs unscheduled-news gaps.

---

## 6. What shipped (code)

- `netlify/lib/quickswing-pipeline.mjs` — `adjustSplits(hist, splits)` (shared split back-adjustment).
- `netlify/lib/short-pipeline.mjs` — fetch `/stable/splits`; split-adjust `hist` before factors + the fold signal.
- `netlify/functions/short-backtest-seed.mjs` — split-adjust the historical replay hist.
- `netlify/lib/short-backtest.mjs` — `SBT_HARD_STOP_PCT=0.40`; `openPosition` uses the 40% catastrophe line; the death-cross (TREND) exit removed; `SBT_SEED_VERSION` 3→4.
- `netlify/lib/short-study.mjs` — `rule.hardStopPct` support in `simulateShortExit` (the offline twin of the shipped rule; parity-tested).
- `index.html` — swing popover + tooltip copy updated to the v4 exit and the split-adjustment note.
- `tests/swing-{engine,signal}.test.mjs` — hard-cap fills, the two hard-cap PROOFs, the engine↔study parity tests + mutant PROOF, and the split-adjustment tests.
