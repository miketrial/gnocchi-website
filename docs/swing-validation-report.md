# Swing Tab — Validation Report

_Repo: gnocchi.website screener · branch `feat/bounce-rescan-both-lists` · FMP cache pulled 2026-07-07 (newest bar) · generated 2026-07-10._
_Method: deterministic off-cache reconstruction using the LIVE engine functions (byte-identical to the site), then multi-agent adversarial verification against the §3 reality gates (look-ahead / survivorship / OOS / multiple-testing / cost / plateau / determinism). Every headline claim below survived a skeptic agent trying to refute it; claims that only partly survived are reported with their caveats._

Artifacts: `scratchpad/swing-validate/{p2-scoring,p4-calibration,p56-robustness}.json`, `pit-cache.json`. Harness: `scripts/swing-validate/lib.mjs`. Tests: `tests/swing-*.test.mjs` (89 tests + 16 negative-control proofs, wired into `npm test`, green).

---

## TL;DR — is the Swing tab any good?

**⚠ Superseded by Phase 2 (see the section at the bottom). The honest answer is now: a mega-cap momentum/beta screen with no demonstrated, transferable timing alpha — the entry signal slightly *erodes* the beta it captures.** Phase 1's read below ("a 2-factor 63-day hold with ~1.2pp SPY edge") turned out to be a 90-survivor artifact: on a broad 488-name universe those two factors collapse to ~0, and the ~1.2pp "edge" is mega-cap-tech beta over the 2022-2026 bull, not signal skill.

_Phase 1 read (kept for the record):_ Modestly good but oversold — a 2-factor (Near-High + Sector-RS) ~63-day hold with a ~1.2pp SPY edge, long-only correct, incumbent 4×ATR stop hurts expectancy. The backtest math is clean and deterministic; the shipped live forward-fold had a partial-bar look-ahead bug (**fixed** — see P3).

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

> **⚠ Superseded by Phase 2:** these KEEP/DROP verdicts are measured on the 90 survivors only. On the broad 488-name universe **Near-High and Sector-RS collapse to ~0 (they do NOT transfer)**, and given the true effective-N (~89–488 clustered names) **no factor is statistically distinguishable from zero**. Read this table as a survivor-sample description, not a shippable factor ranking.

---

## Calibration (each param re-decided on the corrected universe, §3-gated)

| Param | Current | Recommendation | Gate status |
|---|---|---|---|
| **Exit rule** | `maCross_atr40` = 4×ATR stop + 50/200 death-cross + 63d | **Relax toward `hold63`** (plain 63-day hold), or at minimum **drop the death-cross early-exit and loosen the stop to ≥5×ATR** | **PASSES on expectancy**: 5.04% vs 3.45%, OOS 6.22 vs 4.06, wins every walk-forward fold, cost-invariant, monotone-in-stop-tightness plateau. Present on the **expectancy plateau**, NOT the portfolio-DD figure (see rejected). |
| **SBT_STOP_ATR_MULT** | 4.0 | **Loosen (≥5.0) or drop — do not tighten** | PASSES: expectancy is monotone in looseness; tightening strictly hurts, so 4.0 is on the wrong side of the plateau. |
| **SBT_ENTRY_MIN** | 12/18 | **Hold at 12** (13 defensible as a robust step; **reject 14+**) | The raise-to-14 **FAILS** the plateau gate — per-trade expectancy rises monotonically all the way to bar 17 with **no optimum**; total captured PnL peaks at 13; median trade is negative at every bar. "Higher bar ⇒ higher expectancy" is trivial selectivity, not proof that 12 is too permissive. |
| **Uptrend entry gate** (px>50>200) | ON in live engine, **OFF in offline study** | Keep ON; report the **gated** headline as primary | Honesty fix: ~20.6% of study entries (796/3873) are not live-tradeable. Gated headline ≈ exp 3.5%, edge 1.2, OOS 2.5. |
| **SBT_TIME_STOP_DAYS** | 63 | **Keep 63** | The winning rule *is* a 63-session hold; no shorter/longer cap dominates. |
| Factor weights | equal 0–3 | ~~Zero Volume-Surge; demote Momentum & Trend~~ → **Phase 2: ship NO weight change** | Phase 2 re-backtested the composites end-to-end: dropVOL / IC-weighted / lean all **fail** to beat equal-weight at matched entry count (wins only in the overfit low-n tail). Equal-weight is the gate-clean default. |

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

---

# Phase 2 — closing the three big gaps (transferability, reweighting, fundamentals)

_Added 2026-07-10. Built the broad ~500-name universe, a dated point-in-time fundamentals reconstruction, and an end-to-end reweighted-composite re-backtest. Every finding below survived a second adversarial-verification pass. Drivers: `scripts/swing-validate/{universe-500,fundamentals-pull,p7-composite,p8-fundamentals,p9-universe500}.mjs`; artifacts: `scratchpad/swing-validate/{p7-composite-*,p8-fundamentals,p9-universe500}.json`._

**The one number that reframes everything.** The 90-name study universe was hand-picked liquid mega-caps. Re-run on a broad **488-name universe** (`company-screener` top-500-by-cap) and on a **liquidity-tiered** view, the picture changes:

| Finding | 90 survivors | Broad 488 (representative) |
|---|---|---|
| Near-High IC (fwd-21d) | +0.063 | **+0.006** (collapses) |
| Sector-RS IC | +0.064 | **−0.006** (collapses / flips) |
| Trend / Momentum IC | −0.018 / −0.028 | +0.029 / +0.028 (both were always inside the ~0.03 noise floor — sign-flip noise, not failed edges) |
| `hold63` edge vs SPY | +1.22pp | **+0.06pp** (≈ zero) |

**No factor transfers.** The only two technical factors that ever cleared the effective-N noise floor on the survivors (Near-High, Sector-RS) collapse to ~0 on the broad universe **at every horizon** (5/10/21/42/63d). With ~89–488 distinct names clustered over one 2022-2026 bull regime, the name-clustered SE on any IC is ~0.11, so **no factor — of the 6 technical or 5 fundamental — establishes a transferable, statistically distinguishable edge.**

**The "edge" is beta, and the signal erodes it.** The hold63 SPY-edge is monotone in liquidity (≥$100M/day +0.12pp → ≥$300M +1.10 → ≥$500M +2.72 → ≥$1B +5.65), but `avgSPY` is flat across every tier — so the gradient comes entirely from the stocks' own rising 63-day returns (mega-cap-tech beta), not from beating SPY through timing. **Timing-vs-beta test (survivorship-neutral — same names both legs):** signal-conditional entries *underperform* unconditional random-entry buy-and-hold of the **same names** at every tier and horizon (≥$300M: signal +1.10 vs unconditional +2.42, **−1.32pp**; broad fwd-63d −2.17pp). And name-clustered t-stats show the sub-mega-cap tiers are **significantly negative** (100–300M/day t=−5.1; 300M–1B t=−3.1), not merely noisy — a real negative-edge region, not dilution.

**Reweighting the composite: no win.** `dropVOL` / IC-weighted / `lean`(Near-High+Sector-RS) all fail to beat the equal-weight score at matched entry count on **both** universes; their only "wins" are in the low-n, high-selectivity tail where OOS is wildly unstable across adjacent thresholds (classic overfit, fails plateau + multiple-testing). **Ship no factor-weight change — equal-weight is the gate-clean default.**

**Fundamentals (dated PIT, reused live ladders for Quality/Leverage, re-implemented as-of-D for Catalyst/Analyst): no edge, mild drag.** Per-factor ICs (Quality −0.081, Catalyst −0.032, Leverage +0.041, Analyst +0.030) all sit within ~1 name-clustered SE of zero, so the honest read is **the fundamental block ≈ 0 with a mild drag** (high-fundamental entries 0.71% vs low-fundamental 1.8%, block lift −1.09pp; block ~uncorrelated with the technical score, −0.041) — *not* four signed effects. Valuation is not PIT-assessable (forward-EPS estimate vintage isn't dated). Caveat: 90-survivors only.

## Phase 2 — recommendations (surfaced; behavior changes need your call)
1. **Ship no factor-weight change** — equal-weight survives; every reweighting overfits. (No code change needed.)
2. **Liquidity guardrail** — restrict Swing entries to ≥$300M/day (ideally ≥$500M) recent-median $-volume: below that the edge is flat-to-**negative** (significant, not noise). A monotone gradient (clears multiple-testing), a defensive filter that removes a real negative-edge region — *not* an alpha claim.
3. **Honest relabel / disclaimer** — present the Swing tab as a mega-cap momentum/**beta** screen, not a market-beating signal. No transferable timing alpha survived; the signal dilutes the tier's raw buy-and-hold by ~1.3pp; every positive number is a survivorship upper bound.
4. **Keep** the 63-day hold and `SBT_ENTRY_MIN=12` — nothing new passed all §3 gates, so "ship nothing new" is itself the gated recommendation.

## Phase 2 — biggest remaining gate
Both universes are **today's survivors** (delisted absent), so even the mega-cap beta is an **upper bound**. The single most valuable next test is a delisted-inclusive universe: does even the beta survive once names that went to zero are included, or does it erase? (The reachable delisted pool is page-0-only; the rest is paywalled — the open FMP-plan decision above.)
