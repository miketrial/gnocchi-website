# Swing Tab — Deep Entry-Timing Study (2006–2026, through real bears)

_Repo: gnocchi.website screener · generated 2026-07-11 · deep FMP pull 2006-08 → 2026-07 (5000-bar cap)._
_Method: pulled max daily history for the 488-name universe + SPY + 12 sector ETFs + ^VIX (`scripts/swing-validate/pull-deep-cache.mjs` → `scratchpad/swing-validate/deep-cache.json`, 165MB). Scored the live entry across 20 years (`deep-entry-study.mjs`): entry = fresh transition into techScore≥12 & uptrend, **$-volume floor DECOUPLED and swept** (per the "decrease volume if needed" ask); exit fixed = 40% catastrophe stop + 126-session (6mo) hold, long-only. Splits: IS entryDate<2017 / OOS ≥2017 (each half holds real bears). Regime = SPY vs 200DMA; crisis-window tags for GFC / euro-2011 / China-2015 / Q4-2018 / COVID / 2022. Acceptance = edge vs SPY positive **out-of-sample AND in bear regime**, not in-sample. Coverage (survivor-only): 308 names have 2008 data, 376 have 2018, 392 have 2020._

_Trigger: user asked to pull pre-2021 bear data, lower the volume threshold if useful, and find the best combination of entry metrics — "deciding when to buy is an extremely important factor."_

---

## TL;DR — three findings, one of them reverses a prior conclusion

**1. The deep out-of-sample data DEMOTES `techScore`.** On the survivor-only but bear-inclusive history, `techScore≥15`'s **in-sample (2006–2016) edge is ~0 (+0.19%)**; its headline +9.7% is entirely a post-2017 (bull-heavy) OOS phenomenon. My earlier "stable IS/OOS" for this rule was an artifact of an all-bull 2021–2026 window — a real 2006–2016 in-sample (including the GFC) erases the in-sample edge. Pure entry-strength tiers are **not** a robust when-to-buy rule.

**2. LIQUIDITY is the robust lever — and it points OPPOSITE to "decrease the threshold."** Sweeping the floor: edge is flat-to-**declining** from $25M → $300M/day (and **negative in bear regime at every one**), then rises sharply — $1B/day: +2.8% (OOS +3.6%, bear +3.5%); $3B/day: +7.0% (OOS +7.2%). The most-liquid mega-caps are the only floor whose edge survives out-of-sample **and** turns bear-positive. Lowering the volume threshold makes the rule worse. Economic sense: flight-to-quality — the biggest names fall less in stress (partly beta<1), which is a real, usable defensiveness, not alpha.

**3. NO metric combination makes "buy into a real grinding bear" profitable.** Per-crisis, entering *during* the actual declines was negative-to-flat across every filter: GFC −0.8%, euro-2011 −2.1%, China-2015 −2.7%, Q4-2018 +2.1%, 2022 +1.7% (baseline). The large positive "bear-regime" aggregates are dominated by the **COVID V-snapback** and post-bottom recovery entries, not by protection during declines. The technical gate mostly keeps you *out* during crashes (few uptrends), and when it fires mid-decline it's ~a coin flip.

**Best credible combination (only one clears every hurdle):** `techScore≥14 & $-vol≥$1B/day & sector-RS≥2` — n=317, edge +12.3%, **beta-adjusted +8.1%**, IS +2.1%, OOS +13.8%, bear +10.5% (n=57). It is the sole combo positive in-sample, out-of-sample, and in bear regime with adequate n. Still: ~1/3 is leverage, the bear number leans on COVID, and it's survivor-only. Treat as a high-conviction mega-cap tilt, not proven alpha.

---

## 1. Entry census (2006–2026)

69,155 entries · IS(<2017) 28,817 · OOS(≥2017) 40,338 · bull-regime 61,900 · bear-regime 7,255.
Crisis-window entries: GFC 2,311 · euro-2011 817 · China-2015 963 · Q4-2018 635 · COVID 400 · 2022 1,981.

## 2. techScore tier — in-sample edge collapses once a real bear is in IS

| tier | n | edge | beta-adj | IS edge | OOS edge | BEAR edge | BEAR avg P/L | worst |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| ≥12 | 69,155 | +1.6% | +1.3% | +1.9% | +1.5% | −1.6% | +2.1% | −73.6% |
| ≥14 | 6,417 | +4.3% | +3.0% | +2.5% | +5.3% | +0.3% | +3.5% | −70.3% |
| ≥15 | 1,500 | +6.9% | +4.7% | **+0.2%** | +9.7% | +2.1% | +6.9% | −52.5% |
| ≥16 | 271 | +7.2% | +3.5% | **−2.9%** | +9.6% | **−4.8%** | −4.2% | −49.8% |

The higher tiers' edge is post-2017; `≥16` is outright negative in-sample and in bears (overfit, tiny n).

## 3. Liquidity floor sweep (the robust, counter-intuitive result)

| floor | n | edge | beta-adj | OOS edge | BEAR edge | worst |
|---|---:|---:|---:|---:|---:|---:|
| $25M | 65,872 | +1.4% | +1.2% | +1.3% | −1.6% | −70.3% |
| $50M | 61,255 | +1.1% | +0.8% | +0.9% | −1.5% | −70.3% |
| $100M | 52,646 | +0.5% | +0.3% | +0.3% | −1.8% | −70.3% |
| $300M (shipped) | 22,449 | +0.3% | +0.1% | +0.1% | −1.4% | −70.3% |
| **$1B** | 4,953 | +2.8% | +1.7% | +3.6% | +3.5% | −52.5% |
| **$3B** | 1,193 | +7.0% | +4.5% | +7.2% | +24.3%\* | −43.7% |

\*the $3B bear number is small-n and covid-driven — see §5; do not read it as reliable bear protection.

## 4. Other factors & beta buckets

| filter | n | edge | beta-adj | OOS edge | BEAR edge |
|---|---:|---:|---:|---:|---:|
| MOM=3 (3m ≥+15%) | 33,920 | +3.4% | +2.7% | +3.8% | −1.0% |
| TREND=3 | 24,016 | +4.3% | +3.4% | +4.9% | +0.5% |
| SECRS=3 | 2,402 | +6.7% | +3.9% | +6.8% | +0.1% |
| beta<1.0 | 33,401 | −0.9% | +0.8% | −1.6% | −3.6% |
| beta 1.0–1.5 | 24,774 | +2.6% | +1.7% | +2.5% | +0.4% |
| beta≥1.5 | 10,980 | +7.0% | +2.2% | +9.4% | +12.4% |

High-beta shows the highest raw edge (incl. "bear," because SPY<200DMA entries often catch recoveries that high-beta names lead) but only ~30% survives beta-adjustment — confirming most of it is leverage.

## 5. Per-crisis — buying DURING each named bear (edge vs SPY, n)

| filter | GFC | euro-2011 | China-2015 | Q4-2018 | COVID | 2022 |
|---|---|---|---|---|---|---|
| baseline | −0.8 (2311) | −2.1 (817) | −2.7 (963) | +2.1 (635) | −1.3 (400) | +1.7 (1981) |
| $1B floor | +0.3 (136) | −1.9 (53) | −1.4 (79) | −7.4 (32) | +18.4 (60) | +1.7 (152) |
| $3B floor | **−13.3** (23) | +26.2 (10) | +11.6 (5) | −9.8 (8) | +44.4 (25) | **−10.2** (12) |
| techScore≥15 | −2.4 (47) | −13.2 (10) | +5.6 (10) | +7.6 (10) | +63.3 (11) | +3.7 (75) |

The "bear edge" positives are COVID (a fast V) plus scattered recovery entries. Entering into the GFC or 2022 grind with any filter was flat-to-negative. **There is no when-to-buy rule here that protects you during a sustained decline.**

## 6. Strict-robust combos (require n≥300 AND IS>0 AND OOS>0 AND BEAR>0)

Only three of thirteen candidates survive all four hurdles:

| combo | n | edge | beta-adj | IS | OOS | BEAR (n) | worst |
|---|---:|---:|---:|---:|---:|---:|---:|
| **techScore≥14 & $1B & SECRS≥2** | 317 | +12.3% | +8.1% | +2.1% | +13.8% | +10.5% (57) | −52.5% |
| techScore≥15 & MOM=3 | 1,272 | +7.1% | +4.8% | +0.2% | +10.2% | +2.2% (170) | −49.8% |
| techScore≥15 | 1,500 | +6.9% | +4.7% | +0.2% | +9.7% | +2.1% (204) | −52.5% |

Every combo that topped the raw-robustness ranking (e.g. `ts≥15 & $3B`, robust 23.5) had **negative in-sample edge and n<200** — textbook overfitting, rejected. Only `techScore≥14 & $1B & SECRS≥2` has a meaningfully positive in-sample edge.

## 7. Guidelines & boundary

**When-to-buy guideline (evidence-ranked):**
1. **Liquidity first — require ≥$1B/day** (raise, don't lower, the floor). This is the most robust single lever and the one that turns bear-regime edge positive.
2. **Stack sector leadership (SECRS≥2) and a strong technical core (techScore≥14).** The combo `techScore≥14 & $1B & SECRS≥2` is the only rule positive across IS/OOS/bear.
3. **Do not chase entry-strength alone (techScore≥15/16)** — its edge is post-2017 bull-only and ~0 in a real in-sample.
4. **Accept that no rule makes buying into a real grinding bear profitable** — the gate's value is staying in mega-cap quality during bull/recovery, not timing crash bottoms.

**Boundary:** survivor-only (delisted names absent — every number is an upper bound; the $300M+uptrend gate did structurally reject 17/17 tested go-to-zero names, see [swing-bestofbest-report.md](swing-bestofbest-report.md)). 2008/2011/2015 coverage is the 308–376 names that existed *and* survived. beta-adjustment removes leverage but not survivorship. The best combo's bear edge leans on COVID's fast recovery. No engine change made — this report is the deliverable.
