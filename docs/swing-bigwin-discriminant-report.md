# Swing Tab — Big-Winner Discriminant Study (what separates the >10% wins)

_Repo: gnocchi.website screener · generated 2026-07-12 · deep FMP cache 2006-08 → 2026-07-10._
_Method: every SHIPPED v6 swing trade (v5 best-of-best entry; exit = 50/200 death-cross → 40% stop → 189-session backstop) reconstructed over the 488-name deep cache, full-runway cohort n=1,475. Each trade tagged with an ENTRY-TIME feature vector (no look-ahead) and its realized v6 outcome. Discover on IS(<2017, incl. GFC), re-check on OOS(≥2017). Harness: `scripts/swing-validate/winner-discriminant.mjs`._

_Trigger: user observed on the live panel that a few trades are big winners (AMD +100%, FLEX +62%, CRS +41%) while most wins are small, and asked what measurable entry feature separates the big ones — to add to the buy criteria and "focus on the larger wins."_

---

## TL;DR — three findings, and why a "big-win gate" is a beta trap

**1. The system is ALREADY a fat-tail machine.** The >10% winners are **43% of trades but capture 97% of all positive P/L**; the median trade makes just +3.7%. That is exactly what the v6 let-winners-run exit was built to do. The "many small wins" are not a leak — they're the trades that death-crossed out near breakeven (working as designed), not big losses dragging you down.

**2. Win SIZE is mostly path, not entry-selectable.** Rank-IC(hold-length, P/L) = **0.85**; rank-IC(SPY-return-over-the-hold, P/L) = **0.56**. A "big winner" is overwhelmingly a trade that *survived to the 189-session backstop without a death-cross* (97.6% of >25% winners exit on TIME, still trending) *in a rising market*. Neither is knowable at entry. You can't gate for "will trend for 9 months."

**3. The features that DO skew toward big winners are momentum, beta, and $3B liquidity — and they are beta amplifiers that fail the bear test.** Every one concentrates big wins beautifully in the post-2017 (bull-heavy) OOS and turns **negative in the bear-inclusive in-sample**:

| add-on gate | OOS avg / edge / %>10 | IS avg / edge | robust? |
|---|---|---|---|
| **base (v6)** | +16.7% / +6.1% / 47.7% | −1.9% / −0.8% | — |
| beta ≥ 1.6 | +28.7% / +21.2% / 51% | **−4.2% / −4.3%** | ✗ bull-only |
| mom63 ≥ +40% (= conviction) | +26.9% / +13.9% / 52.8% | **−0.4% / −2.5%** | ✗ bull-only |
| $-vol ≥ $3B/day | +25.2% / +12.7% / 62.6% | −11.5% (n=16) | ✗ thin IS |
| mom63≥25 & $3B | +28.5% / +16.6% / 64.8% | −21.3% (n=9) | ✗ thin IS |

The OOS columns look like a cheat code — until you see the IS column, where the *same rule* is negative. This is the identical trap the deep-entry study flagged: post-2017 was a mega-cap/AI bull, so "pick the highest-beta, highest-momentum name" prints in OOS and blows up through a real bear. **These are variance amplifiers, not skill.** They widen the right tail AND the left tail; you only see the right one in a bull sample.

**The one robust feature: the 50/200 MA spread (trend maturity).** `spread = (50DMA−200DMA)/200DMA` is the only continuous feature whose rank-IC keeps the same sign IS and OOS (IC_IS +0.13, IC_OOS +0.07), and `spread ≥ 8%` is the **only add-on positive in BOTH regimes** (IS +0.7%/+0.3%, OOS +16.9%/+5.7%). But its effect is *mild* — it leaves aggregate edge unchanged (+4.73% vs +4.74% base) and lifts win rate ~1pp; it's a gentle quality tilt, not a big-win magnet. techScore is similar (IC_IS +0.04 / IC_OOS +0.05) — weakly robust, already in the gate.

---

## 1. Base rates — the tail is already where the money is

n=1,475 · avg +13.1% · median **+3.7%** · edge +4.7%. Share of trades: **>10% = 43.1%**, >25% = 28.9%, >50% = 12.6%, >100% = 3.7%. The >10% cohort holds **97.4% of all positive P/L**. Takeaway: the goal isn't to manufacture more big wins at entry — it's to keep riding the ones that appear (the exit already does) and not to trade away the broad sample chasing them.

## 2. Univariate discriminants (rank-IC of feature vs P/L)

| feature | IC_IS | IC_OOS | verdict |
|---|---:|---:|---|
| 50/200 spread % | **+0.13** | **+0.07** | ✓ robust (mild) |
| techScore | +0.04 | +0.05 | ✓ robust (weak, already gated) |
| 3-mo momentum % | 0.00 | +0.02 | ✗ OOS-only |
| $-vol $B/day | −0.05 | +0.18 | ✗ sign flips |
| beta 252d | −0.02 | +0.10 | ✗ sign flips |
| ATR% (vol) | −0.07 | −0.03 | ✗ negative |
| VIX at entry | −0.06 | −0.03 | ✗ (U-shaped — both calm and panic entries pay) |

Momentum/beta/$-vol all show a strong *monotonic quintile lift in the aggregate* (e.g. beta Q5 avg +24% vs Q1 +6%; $-vol Q5 +23% vs Q1 +9%) — which is why they're tempting — but the IS/OOS sign flip proves that lift is the post-2017 bull, not a stable relationship.

## 3. Decomposition — why you can't select big wins at entry

- big winners (>25%, n=426): median hold **189 sessions**, median SPY-over-hold +18.2%, median edge +33.3%, exit **97.6% TIME**.
- small wins (0–10%, n=154): median hold **also 189 sessions**, median SPY-over-hold +11.9%.

Both ride to the 189-day backstop; what makes one +33% and the other +6% is how much the name/market rose over those 9 months — a path outcome, not an entry feature. rank-IC(hold, edge)=0.67: even the edge-above-SPY comes from *duration* (surviving without a death-cross), which the exit rule already maximizes.

## 4. What this means for the buy criteria

**Do not add a momentum/beta/$3B hard gate.** It concentrates big wins only in bull samples, goes negative through real bears, and thins an already-sparse list (the panel already shows names blocked by the $1B floor). It's the deep-entry study's rejected lever wearing a new hat.

**The honest ways to "focus on the larger wins":**

1. **Surface, don't gate (recommended).** The big-win cluster *is* the ★ conviction tier ($3B & mom≥40%) already shipped in v6. Extend ★ from a binary flag into a small **"fat-tail propensity" rank** (e.g. ★ = conviction; add +1 for beta≥1.3, +1 for 50/200 spread≥8%) so the names statistically prone to big wins float to the top for **attention and position-sizing** — without excluding the broad, more-robust list. Focus = focus, not exclude.
2. **Add the one robust feature as a soft signal.** `50/200 spread ≥ 8%` ("established trend") is IS+OOS-positive; show it as a displayed factor or fold it into the ★ score. Mild but real.
3. **(Exit, not entry — secondary.)** 97.6% of big winners exit on the 189-day TIME backstop *while still trending* — the same clip the old 63-day cap did to AMD, milder. If the goal is bigger wins, loosening/removing the 189 backstop (pure death-cross) captures more tail (cohort avg +16.9% vs +13.1%) at the cost of slower capital turnover. Separate decision from entry.

**Boundary:** survivor-only cohort (upper-bound P/L); pre-2017 has few $1B/$3B names, so liquidity-gate IS cells are thin (flagged, not trusted); IC uses Spearman (robust to the fat forward tails). Same anchor as every prior swing study: post-2017 OOS is bull-heavy; only IS-positive-too rules are trustworthy, and only `spread`/`techScore` clear that bar.
