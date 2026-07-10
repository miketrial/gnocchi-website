# Swing Tab — Validation Report

_Repo: gnocchi.website screener · branch `feat/bounce-rescan-both-lists` · FMP cache pulled 2026-07-07 (newest bar) · generated 2026-07-10._
_Method: deterministic off-cache reconstruction using the LIVE engine functions (byte-identical to the site), then multi-agent adversarial verification against the §3 reality gates (look-ahead / survivorship / OOS / multiple-testing / cost / plateau / determinism). Every headline claim below survived a skeptic agent trying to refute it; claims that only partly survived are reported with their caveats._

Artifacts: `scratchpad/swing-validate/{p2-scoring,p4-calibration,p56-robustness}.json`, `pit-cache.json`. Harness: `scripts/swing-validate/lib.mjs`. Tests: `tests/swing-*.test.mjs` (89 tests + 16 negative-control proofs, wired into `npm test`, green).

---

## TL;DR — is the Swing tab any good?

**Modestly good, but oversold by its own framing.** Honestly it is a **2-factor (Near-High + Sector-RS) ~63-day-hold** with a **~1.2pp per-trade edge over SPY**, not the robust 11-factor engine the "22/33 strong" score implies. Long-only is correct. The incumbent 4×ATR-stop exit **hurts** expectancy. Half the score (the 5 fundamentals) is **un-auditable** from price history. The backtest math is clean and deterministic — but the **shipped live forward-fold has a look-ahead bug** (books on the in-progress partial bar) that the offline study does not.

---

## Factor scorecard (the 6 EOD-reconstructable factors — HIGH-confidence tier)

| Factor | Verdict | Conf | Evidence (fwd-21d, survivors / PIT) |
|---|---|---|---|
| **Near-High** (re-tuned) | **KEEP** | HIGH | IC +0.063 / +0.065, **genuinely monotone** buckets (−4.85, 0.40, 0.88, 1.80). Best of the six. Caveat: edge concentrated in the recent ~30% of the window, ~flat/negative 2022-23. |
| **Sector-RS** | **KEEP** | MED | IC +0.064 / +0.061, survives Bonferroni (t≈3.97). Caveat: **not** truly monotone (bucket 2 dips) and **sign-flips to −0.14** in a full-calendar-year block — regime-dependent, not stable. |
| **Liquidity** | **KEEP (as gate)** | MED | A $-volume floor (entry needs liqPts≥1), not a ranking factor. Ranking IC ≈ 0 by design. |
| **Trend** | **DEMOTE-WEIGHT** | MED | IC −0.018, non-monotone U-shape (weakest-trend bucket has the *highest* fwd return). Magnitude is **not statistically significant** (|t|<1.96) — "no reliable signal", not strictly "anti-predictive". |
| **3M-Momentum** | **DEMOTE-WEIGHT** | MED | IC −0.028, negative **both** IS and OOS — the more robustly non-predictive of the two trend factors. |
| **Volume-Surge** | **DROP** | HIGH | Pure noise: IC +0.004 (t=0.27, p=0.78), sign-flips IS +0.028 / OOS −0.04, jagged buckets. Independently re-derived. |
| 5 Fundamentals (Analyst / Valuation / Quality / Leverage / Catalyst) | **NOT-ASSESSABLE** | — | Require point-in-time fundamentals; **cannot** be reconstructed from EOD price history. ~Half the 33-pt score is therefore unaudited here. |

**Redundancy:** no collinearity (all |corr| < 0.4). Notably Trend anti-correlates with the two *good* factors (Trend↔Near-High −0.33, Trend↔Sector-RS −0.37) — raw trend strength pulls *against* the pullback-to-strength signal, which is why the trend factors dilute rather than add.

---

## Calibration (each param re-decided on the corrected universe, §3-gated)

| Param | Current | Recommendation | Gate status |
|---|---|---|---|
| **Exit rule** | `maCross_atr40` = 4×ATR stop + 50/200 death-cross + 63d | **Relax toward `hold63`** (plain 63-day hold), or at minimum **drop the death-cross early-exit and loosen the stop to ≥5×ATR** | **PASSES on expectancy**: 5.04% vs 3.45%, OOS 6.22 vs 4.06, wins every walk-forward fold, cost-invariant, monotone-in-stop-tightness plateau. Present on the **expectancy plateau**, NOT the portfolio-DD figure (see rejected). |
| **SBT_STOP_ATR_MULT** | 4.0 | **Loosen (≥5.0) or drop — do not tighten** | PASSES: expectancy is monotone in looseness; tightening strictly hurts, so 4.0 is on the wrong side of the plateau. |
| **SBT_ENTRY_MIN** | 12/18 | **Hold at 12** (13 defensible as a robust step; **reject 14+**) | The raise-to-14 **FAILS** the plateau gate — per-trade expectancy rises monotonically all the way to bar 17 with **no optimum**; total captured PnL peaks at 13; median trade is negative at every bar. "Higher bar ⇒ higher expectancy" is trivial selectivity, not proof that 12 is too permissive. |
| **Uptrend entry gate** (px>50>200) | ON in live engine, **OFF in offline study** | Keep ON; report the **gated** headline as primary | Honesty fix: ~20.6% of study entries (796/3873) are not live-tradeable. Gated headline ≈ exp 3.5%, edge 1.2, OOS 2.5. |
| **SBT_TIME_STOP_DAYS** | 63 | **Keep 63** | The winning rule *is* a 63-session hold; no shorter/longer cap dominates. |
| Factor weights | equal 0–3 | **Zero Volume-Surge; demote Momentum & Trend; lean on Near-High + Sector-RS** | IC-level pass only — **not yet re-backtested as a composite** (see open work). |

**Long-only: confirmed.** Even with the reachable delisted pool added, shorts lose: raw fwd-21d −2.28%, all 18 short exit rules negative, worst short trade −122% to −150%. The delisted pool made shorts marginally *worse*.

**Survivorship gap: 0.15pp** (incumbent rule: survivors 3.45% vs +delisted 3.29%) — small, and stable even at raised bars. **This is a lower bound**: the reachable pool is 39 names (page-0 only; page ≥1 is paywalled), and although 11 of them genuinely collapsed to near-zero (REE, ORGN, OLPX, SNBR…), a strength/momentum long rarely *buys* a falling knife, so those names contributed ~zero long entries. True bias ceiling is behind the FMP paywall.

**Benchmarks (matched 21-day horizon):** score entries +1.25% **underperform** equal-weight-universe +2.04% and naive top-decile-63d-momentum +2.87%. The score only clears the momentum baseline once the bar is cranked to ~14. The headline ~5% is a **63-day hold** return, beating SPY by ~1.2pp gross.

**Regime / robustness:** positive edge in every regime bucket (best in bull/high-VIX pullbacks: +12% hold63); expectancy survives multiple-testing (Bonferroni, t=10–14); cost-robust (40bps roundtrip barely dents it).

---

## Engine correctness (P3) — bugs found, with repro

1. **[HIGH] Look-ahead: the live forward-fold books on the in-progress partial today-bar.** `short-rescan-background.mjs` folds `row.bt` (from `computeShortSignal(cleanHist(hist),…)`), and during market hours `hist[0]` is FMP's live partial bar — neither `cleanHist` nor `computeShortSignal` drops it. Repro (`scratchpad/repro-partial-bar.mjs`): swapping the final close for an intraday tick **flips `entryStrong` on 5/90 names** and changes persisted entry/stop prices; because `mergeShortSeed` lets the forward trade win, the non-final fill **permanently overrides** the deterministic seed replay. The persisted production log is therefore **non-deterministic** (depends on which minute the rescan fires). *The offline validation is NOT contaminated (it folds completed cache bars); only the shipped log is.* **Proposed fix:** guard the fold to completed sessions (skip `recordShortTransition` when `row.bt.bar.date` is today-ET during market hours), or drop the in-progress bar before computing `btSignal`. Needs ET/market-hours wiring → flagged for review, not auto-applied.
2. **[MEDIUM] `mergeShortSeed` double-counts an entry that is OPEN in the forward log but CLOSED in the seed.** Repro (`scratchpad/audit-merge-dup.mjs`) confirmed. **✅ FIXED** (seed the dedup set with the open key; forward wins) + regression test added.
3. **[MEDIUM] Stale/delisted open positions never close** → they linger open forever and are silently excluded from win-rate/avg-return (per-log survivorship optimism). **Proposed:** force-close at a synthetic tape-end mark.
4. **[LOW, docs] Contradictory comment** at `short-pipeline.mjs:63` claimed `hist[0]` is "yesterday's close". **✅ FIXED** — corrected to state it is today's in-progress bar (root-cause of #1's re-introduction risk).

Determinism / idempotency / fill-realism otherwise check out: gaps fill pessimistically, `barsHeld` counts once per session date, stop/death-cross/time priority is correct, `computeShortSignal.techScore` is byte-identical to the live scorer's 6-factor sum (proven by test), and the as-of date helpers (`spyCloseAsOf`/`strengthAsOf`) have no off-by-one.

---

## What was tested and REJECTED (kept honest by adversarial verification)

- **Raise SBT_ENTRY_MIN to 14** — selectivity artifact, no true optimum, fails the plateau gate.
- **"The ATR stop makes the portfolio worse on every axis (−32% vs −13% maxDD)"** — the maxDD is razor-fragile (flips to −19% at 20bps; ranges −22% to −37% across configs) and the CAGR damage is mostly the death-cross target exit, not the ATR stop. Only the **expectancy penalty** is robust.
- **Enabling shorts / bidirectional** — long-only confirmed even with the delisted pool.
- **"Near-High & Sector-RS are monotonic and OOS-stable"** — keep both factors, but drop the qualifiers (Sector-RS sign-flips in a full year; Near-High's edge is recent-regime-concentrated).
- **"The score beats benchmarks"** — only after raising the bar to ~14 and only vs SPY at the 63-day horizon.

## Open work / gaps (completeness critic)

- **HIGH:** the 5 fundamental factors (~half the 33-pt score) are entirely unvalidated offline — needs the live forward log / a dated-fundamentals source.
- **HIGH:** the reweighted composite (zero-VOL, demote MOM/TREND) is IC-level only — never re-backtested end-to-end as a new entry rule.
- **HIGH:** the production look-ahead's P&L impact is unquantified (proven present, not sized).
- **MED:** portfolio sim is a single deterministic path (no CI); universe is 90 survivors (live screener runs ~500); factor edge is univariate (no orthogonalized/multivariate joint test); 4.2-year window is short for the regime-concentrated edge.

## Open decision for the user (plan §8)

A fully clean point-in-time universe needs historical index constituents + delisted pagination — both **402 (paywalled)** on the current FMP plan. Options: **(A)** proceed best-effort + measured residual bias [done; recommended], **(B)** upgrade the FMP plan, **(C)** supply a static historical index-membership dataset. This report ran fully under (A).
