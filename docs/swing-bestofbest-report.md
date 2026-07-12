# Swing Tab — "Best of the Best" Entry-Filter Calibration + Adversarial Stress Test

_Repo: gnocchi.website screener · generated 2026-07-11 · FMP cache newest bar 2026-07-07._
_Method: shipped live entry gate (`computeShortSignal.entryStrong`) over the broad 488-name cache (2021-07→2026-07), 6-month (126-session) hold, 40% catastrophe stop, long-only. Point-in-time entry filters only (no look-ahead). Every candidate filter judged on **edge vs SPY** (raw return just buys beta), split IS/OOS, then put through four adversarial attacks. Scripts: `scripts/swing-validate/{entry-filter-sweep,entry-filter-beta,entry-filter-pit,stress-bestofbest,stress-delisted-highflyers}.mjs`. Artifact: `scratchpad/swing-validate/entry-filter-sweep.json`._

_Trigger: user asked (a) why avg edge vs SPY is ~0 when single trades near +200%, and (b) to calibrate the screener to buy only "the best of the best" — guidelines a stock must beat to be bought and be included in the backtest. Then chose to STRESS-TEST the resulting rule before trusting it._

---

## TL;DR

**Why avg edge is ~0 despite +200% trades:** the P/L is a lottery. On the 6mo hold the **median trade returns +4.0% and LOSES to SPY by −2.6%**; only **44.5%** of trades beat the index. **The top 1% of trades = 27% of all profit, top 10% = 93%.** One +194% MRVL is one ticket in 8,000; averaged in, it barely moves the mean, and SPY over the same days earned nearly as much. That is a beta/lottery basket, not a repeatable edge — which is exactly why "keep only the best" is the right question.

**The calibration that works — require `techScore ≥ 15 of 18`** (the reconstructable technical core; shipped gate is ≥12). It cuts 8,267 → ~420 trades (~5%) and lifts edge-vs-SPY from +0.9% to **+11.2%** per 6mo trade, **stable in and out of sample** (IS +9.4% / OOS +12.6%) and **monotonic** across tiers (12→14→15→16). Optional stackers with the same effect: `$-vol ≥ $3B/day` (+7.9%) and the leader combo `TREND=3 & SECRS≥2 & MOM≥2` (+9.7%, IS≈OOS).

**But the stress test reframes it — it is amplified beta + name-ownership, NOT found alpha.** Decomposing the +11.2%:
- **~40% is leverage.** These are 1.6× beta names; beta-adjusting (subtract beta×SPY, not 1×SPY) drops the edge to **+6.6%**.
- **~73% is name-ownership, not timing.** For names that ever hit `techScore≥15`, buying them at *any random bar* already earned +6.5% edge; buying at the signal earned +9.0% — a genuine but modest **+2.5% timing lift**, and it helps in only ~48% of names.
- **It is bull-conditional.** Entered when SPY > 200DMA, edge is +14.3%; entered when SPY < 200DMA (downtrend), it collapses to **+0.9%** (n=65). No severe bear (2008/2020) is in the data at all.
- **It is not noise** (z = 5.6 vs random equal-size baskets) and the **survivorship penalty is small for THIS rule**: 0 of 17 verified former-high-flyer delistings ever passed the gate — the $300M/day floor + uptrend requirement structurally rejects the go-to-zero names.

**Net:** the durable, regime-robust, skill-attributable piece is small (~+2–2.5%/trade at most). `techScore≥15` is a legitimate **conviction/concentration** rule (fewer, stronger, mega-cap, sector-leading names — and the liquidity floor genuinely protects against blowups), but its big backtest number is mostly a high-beta bull-market bet on survivors. Expect ~market-plus-a-little in bulls and full beta drawdowns in bears — not +11%/trade forward.

---

## 1. The concentration answer (6mo hold, all 8,267 trades)

| metric | value |
|---|---|
| mean trade P/L | +8.1% |
| **median trade P/L** | **+4.0%** |
| mean edge vs SPY | +0.9% |
| **median edge vs SPY** | **−2.6%** |
| **% of trades that beat SPY** | **44.5%** |
| top 1% of trades' share of total P/L | 27% |
| top 5% share | 66% |
| top 10% share | 93% |

The strategy's entire result lives in <10% of trades you cannot identify in advance. This is the mechanical reason "any ticker in the screener" produces ~0 average edge.

## 2. Entry-filter sweep — edge vs SPY (point-in-time only, IS/OOS split at 2024-07)

| filter | n | edge vs SPY | IS edge | OOS edge |
|---|---:|---:|---:|---:|
| baseline (techScore≥12) | 8,267 | +0.9% | +0.7% | +1.0% |
| techScore ≥14 | 1,300 | +5.9% | +4.5% | +7.0% |
| **techScore ≥15** | 424 | **+11.2%** | +9.4% | +12.6% |
| techScore ≥16 | 123 | +14.3% | +16.8% | +11.8% |
| MOM=3 (3m ret≥15%) | 4,287 | +3.0% | +1.7% | +3.7% |
| TREND=3 (>8% over 50DMA) | 3,100 | +3.2% | +1.8% | +3.9% |
| SECRS≥2 (sector leads SPY) | 1,809 | +4.0% | +5.0% | +2.7% |
| $-vol ≥ $3B/day | 523 | +7.9% | +7.3% | +8.3% |
| combo TREND=3 & SECRS≥2 & MOM≥2 | 328 | +9.7% | +9.7% | +9.7% |
| BoB: ts≥15 & SECRS≥2 & MOM=3 | 217 | +11.5% | +10.7% | +12.4% |

## 3. Adversarial stress test of `techScore≥15`

| attack | result | verdict |
|---|---|---|
| **Beta decomposition** | avg beta 1.62; beta-adjusted edge +6.6% (from +11.2%) | ~40% of edge is leverage |
| **Regime (SPY vs 200DMA)** | bull edge +14.3% → bear edge **+0.9%** (n=65); baseline bear −5.1% | edge is bull-conditional |
| **Name vs timing (Control A)** | anytime-in-name +6.5%, at-signal +9.0% → **timing lift +2.5%**, helps 48% of names | mostly name-ownership |
| **Matched random basket (Control B)** | random 337-basket mean +1.0%, 99.9%ile +7.5%; techScore≥15 +11.7%, **z=5.6** | not noise (but ignores beta) |
| **Survivorship (delisted high-flyers)** | 0 of 17 verified delistings (NKLA/WE/RIDE/SAVE/FSR/…) ever passed the gate; peak $-vol mostly <$300M | penalty small for THIS rule |

VIX-tercile attack could not run — `vixHist` is null for the broad universe cache (noted).

## 4. Guidelines (what a stock must clear to be bought)

Primary gate: **`techScore ≥ 15 / 18`** on the reconstructable technical core — concretely, near-max on most of:

| factor | "best of the best" bar |
|---|---|
| Trend | price **>8% above** a rising 50DMA, 50DMA > 200DMA |
| 3-mo momentum | **≥ +15%** over 63 days |
| Near-high | in the **5–18% pullback zone** off the 52-wk high (strong, not extended) |
| Liquidity | **≥ $3B/day** dollar-volume (mega-cap; stricter than shipped $300M) |
| Volume | up-day **accumulation** (surge + positive 10-day money flow) |
| Sector RS | sector **leading SPY by ≥ 8%** |

On the live 33-point score this maps to roughly **≥27/33** (vs the current 22/33 "strong" bar). Frame it honestly as a higher-beta, high-conviction **bull tilt**, never as market-beating alpha.

## 5. Boundary / open work

- **No severe bear in the data.** 2022 forward windows were the recovery; the bear-regime edge (+0.9%) is n=65 and mild. The 1.6-beta concentrate will draw down ~1.6× the market in a real bear — untested here. Pulling pre-2021 history (2008/2018/2020) for names that existed then is the next stress.
- **Survivorship tested but not fully closed.** The 17 delistings all failed the gate *in the scoreable window*; their momentum peaks (2020–early-2021) predate the cache's 200-bar warmup, so the "would it have bought them at the top?" case is untested. Crashed-but-alive names (PTON/ROKU/PLUG/ENPH…) ARE in the survivor universe and ARE captured as losing trades.
- **Thin & tail-driven.** ~420 trades over 5y across 488 names (~1 per 8 names/yr); a few moonshots dominate — expect high variance on any real watchlist.
- **Multiple testing.** ~15 filters tried; monotonicity + beta-adjust + cross-cache + IS/OOS consistency mitigate but do not eliminate the search bias.

_No engine change made — this report is the deliverable, per the working pattern on this project ([bounce-validation-report.md](bounce-validation-report.md), [swing-holdtime-report.md](swing-holdtime-report.md))._
