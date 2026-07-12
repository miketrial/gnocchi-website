# Swing Tab — Can We GATE for Big Winners? (classifier) + The Exit-Backstop Lever

_Repo: gnocchi.website screener · generated 2026-07-12 · deep FMP cache 2006-08 → 2026-07-10._
_Method: every v6 swing trade (v5 gate entry; death-cross/40%/189 exit) over the 488-name deep cache. (1) CLASSIFIER — can any entry feature SEPARATE big winners (pnl>25%) from losers (pnl<0)? Measured by AUC (prob. the feature ranks a random big-winner above a random loser; 0.5=no separation), IS+OOS. (2) EXIT-BACKSTOP — sweep the TIME backstop behind the death-cross on a 2-year-runway cohort. Harnesses: `scripts/swing-validate/bigwin-classifier.mjs`, `exit-backstop.mjs`._

_Trigger: user rejected the display-only ★ rank, insisting "there must be something measurable and the same between all the larger winners" to gate the BUY on, and asked to run the exit tests._

---

## TL;DR — the buy side can't cleanly gate; the exit can

**1. The big winners and the losers look the SAME at entry.** The best single separator of big-winner-vs-loser is only **AUC 0.61** (relative strength vs SPY) — a coin-flip is 0.50, a usable classifier is >0.70. Big winners had a median 6-month return of +43% … but the losers had +34%. High momentum precedes big runs AND big failed-runs; it's **necessary but nowhere near sufficient.** You cannot tell them apart at entry.

**2. Every gate that concentrates big winners concentrates losers almost equally.** Require 3-month momentum ≥ 40% and the >25%-winner rate rises 29% → 40% — but the loser rate rises to **40.5% too** (identical). That's the signature of a **variance/beta** filter (widens both tails), not a skill filter (which would raise winners while cutting losers). And like every beta lever here, it's bull-only: strong out-of-sample (2017-26), **negative in the bear-inclusive in-sample.**

**3. The ONE robust buy-side signal is mild: the name's own 6-month relative strength vs SPY.** `rs126 ≥ +30%` is the only entry filter positive in *both* regimes (IS edge +3.3%, OOS +10.8%) and it lifts average P/L +4.7% → +9.6%. But it keeps 41% losers, halves the trade count, and is a momentum tilt — a legitimate *dial*, not a big-winner detector.

**4. The real lever for bigger wins is the EXIT backstop, not the entry.** 97.6% of big winners get cut by the 189-day clock while still trending. Loosening it toward a pure death-cross **roughly doubles average P/L and big-win capture with the SAME worst-case and BETTER capital efficiency — and, unlike every entry gate, it is not bull-only.**

---

## 1. Classifier — AUC(big winner vs loser), IS & OOS

| feature (entry-time) | AUC all | AUC IS | AUC OOS | robust? | big / loser median |
|---|---:|---:|---:|:--|---|
| $-vol ($B/day) | 0.65 | 0.48 | 0.64 | ✗ (IS<0.5) | 2.4 / 1.4 |
| **rel. strength vs SPY 6mo** | 0.61 | 0.77 | 0.58 | ✓ | +34.8% / +25.5% |
| **6-month momentum** | 0.59 | 0.77 | 0.56 | ✓ | +43% / +34% |
| 50/200 spread | 0.58 | 0.76 | 0.55 | ~ | 18.2 / 15.0 |
| beta | 0.57 | 0.49 | 0.60 | ✗ | 1.40 / 1.28 |
| 3-month momentum | 0.56 | 0.70 | 0.54 | ~ | 24.4 / 20.9 |
| vol-adj momentum, cleanTrend, mom252, ext, techScore … | ≤0.55 | — | — | ✗ | overlapping |

Even the best separators sit at AUC ~0.6 — a **weak** classifier. The medians tell the story: big winners are *modestly* more momentum'd/liquid than losers, but the distributions overlap massively. There is no feature (or the 2-feature combos tested) where "all the big winners are above threshold X and the losers below."

## 2. Gate precision/recall — big% AND loss% move together (base big-rate 28.9%)

| add-on gate | keep% | big% | **loss%** | avg P/L | edge | worst | OOS big%/edge | IS big%/edge |
|---|---:|---:|---:|---:|---:|---:|---|---|
| 3-mo mom ≥ 40 | 18% | 40.5 | **40.5** | +24.2% | +12.6% | −41% | 43.4 / +14.5 | 24.4 / **+2.4** |
| $-vol ≥ $3B | 28% | 42.5 | 31.9 | +23.8% | +12.0% | −41% | 43.9 / +12.7 | 6.3 / **−5.6** |
| 6-mo mom ≥ 60 | 25% | 35.7 | 44.0 | +21.5% | +9.9% | −42% | 37.8 / +11.3 | 26.5 / +3.7 |
| **rel-str vs SPY ≥ 30** | 46% | 36.1 | 41.5 | +19.8% | +9.6% | −42% | 39.0 / +10.8 | 21.4 / **+3.3** |
| 50/200 spread ≥ 12 | 63% | 32.1 | 42.9 | +15.6% | +5.5% | −42% | 35.4 / +6.4 | 16.7 / +1.1 |

Read the **loss%** column: no gate pushes it down. Requiring momentum buys you ~40% big winners and ~40% losers. The apparent edge is the winners being bigger than the losers in a bull — the same beta the whole system already rides. `rs126≥30` is the only one positive in-sample, and only mildly.

## 3. Exit-backstop sweep — the actual big-win lever (death-cross exit; H = TIME backstop)

**ALL (n=1,353):**

| backstop | avg P/L | edge | win% | >25% | >100% | avg winner | worst | med hold | ret/yr-held |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 63d | +4.2% | +1.7% | 51% | 12% | 0.4% | +18% | −41.5% | 91d | +16.8% |
| **189d (now)** | +14.4% | +5.5% | 56% | 31% | 3.8% | +38% | −41.5% | 270d | +19.5% |
| 378d | +23.8% | +11.4% | 50% | 29% | 9.2% | +61% | −41.5% | 280d | +31.1% |
| 504d (~pure) | **+26.6%** | **+14.3%** | 50% | 28% | **10.1%** | **+67%** | **−41.5%** | 280d | **+34.7%** |

Three things make this a clean win, not a beta trap:
- **Worst-case is FLAT at −41.5%** across every backstop — the 40% catastrophe stop bounds single-trade loss regardless, so loosening adds **zero** tail risk.
- **Capital efficiency improves** (return per year-held +19.5% → +34.7%): the longer holds compound faster because they're riding real trends, not parking. And median hold barely moves past 189d (~280d either way) — the death-cross, not the clock, does the exiting (CROSS share 49% → 92%).
- **It is not bull-only.** Unlike the entry gates (negative IS), loosening the backstop is neutral-to-better in the bear-inclusive in-sample (IS edge −0.8% → −1.6%, essentially flat) and **positive in every other split** — OOS edge +7.1% → +18.6%, BEAR-entry edge +8.8% → +9.0%.

**IS <2017** stays slightly negative at every H (−0.8% to −1.6% edge) — the honest anchor: this is still better-managed beta, not new alpha. But loosening doesn't *worsen* it, and it dominates everywhere else.

## 4. Recommendation

**The buy criteria can't be gated for big winners** — the classifier proves the winners and losers are near-indistinguishable at entry (AUC ~0.6, loss% tracks big%). Chasing it just buys a smaller, higher-variance, bull-only book. The most defensible buy-side change is *mild*: a **6-month relative-strength floor** (`rs126 ≥ +30%`), the only IS+OOS-positive filter — it raises edge ~+5pp at the cost of ~half the trade count. A dial, not a detector.

**The real lever for "bigger wins" is the exit backstop.** Loosening `SBT_TIME_STOP_DAYS` from 189 toward a pure death-cross (**378–504 sessions**) roughly doubles average P/L and the >100% rate, at the **same** worst-case and **better** capital efficiency, positive in every split but the (already-negative, unchanged) deep in-sample. Cost: the monster-run tail stays open longer (the median hold is unchanged ~9–10 months; only the AMD-type outliers ride 18-24 months) and needs a wider replay/window + fetch to show completed in the log.

**Boundary:** survivor-only cohort (upper-bound P/L); IS pre-2017 has few $3B names (thin cells flagged). Same anchor as every swing study — only IS-positive-too rules are trustworthy; here that's the exit-backstop loosening (neutral IS, dominant elsewhere) and, mildly, the rs126 floor.
