# Real-Time Short-Horizon Reversal on Liquid NASDAQ Semiconductors — Research Report

**Date:** 2026-07-11 · **Status:** research only — no strategy code written, per brief
**Universe:** core-7 = AMD, AMAT, ASML, NVDA, MU, LRCX, KLAC; extended-17 adds AVGO, QCOM, TXN, MRVL, ON, NXPI, ADI, MCHP, INTC, TER
**Data:** FMP `/stable` daily bars (split-adjusted), 2006-08-23 → 2026-07-10 (~5,000 bars/name), dividends (`adjDividend`), per-symbol earnings dates, ^VIX EOD, SPY/SMH benchmarks. Event window studied: 2007-09-01 → 2026-07-02 (warm-up enforced).
**Method integrity:** all signals computed strictly from bars ≤ t; forward returns measured close-entry (cc) *and* next-open-entry (oc); t-stats date-clustered with Newey–West overlap correction; headline numbers independently re-implemented from scratch by a separate agent (5/6 exact match, 6th within 3 boundary-classified events).

---

## Addendum (2026-07-11 pm) — compounding, leverage, and the second agent's "59% CAGR"

A second research agent (Codex) produced a large sweep whose headline was a **59% CAGR**. I read its files and reproduced the key numbers independently (daily-return, fully-compounded, after-tax sim: `scratchpad/reversal-study/compound-leverage.mjs`). Findings:

- **The "59%" is the buy-and-hold benchmark, not a strategy edge.** An equal-weight hold of the 7 names over Codex's 2019–2026 window compounds at **59.2% pre-tax / 54.8% after-tax** — I reproduce this exactly. Codex's 59% "winner" (`Top1_3M_SMA200`) is a *leveraged 1.5× momentum* bet (buy-strength, single hottest name) that merely *ties* free buy-and-hold while running a **−68% drawdown** vs the basket's −54%, and a **worse Sharpe (0.96 vs 1.14)**. Codex's own summary flags every candidate `deployable: false`, `robust_count: 0`. Its reversal (dip-buying) candidates top out at 10% CAGR — same conclusion as mine.
- **Both agents independently found momentum > reversal on these names.** Codex's best families are momentum/trend; its contrarian family is worst. That is the Medhat–Schmeling result again: these names *trend*, they don't revert.
- **Compounding is already in CAGR — and it favors buy-and-hold.** $100k, 2019–2026, after-tax, fully reinvested: **Basket B&H → $2.68M; panic-dip swing → $178k; momentum → $1.29M.** Both strategies compound; B&H compounds to ~15× more money because it grows a faster quantity *and* defers tax so nothing leaks out each step.
- **Higher return via more risk = leverage the hold, not trade more.** After-tax CAGR (2019–2026): Basket 1.0× **54.8%**, 1.5× **76.8%** (DD −71%), 2.0× **92.8%** (DD −83%). Leverage on B&H dominates leverage on any swing/momentum variant. *Caveat: these CAGRs ignore margin calls — a −70%+ path would force liquidation near the bottom; leveraged ETFs (SOXL) decayed to −17% CAGR at 2× in Codex's own test.*
- **The one genuinely additive trade:** *Basket B&H core + a small panic-day overlay* (add a levered tilt into RSI2<5 & VIX≥30 names) posts the **best risk-adjusted result of anything tested — Sharpe 1.37 vs 1.31, after-tax CAGR 62.9% vs 54.8%, drawdown no worse.** Modest, but it is the only combination that beats plain buy-and-hold on a risk-adjusted basis. Needs live out-of-sample confirmation (only ~8 independent crisis episodes behind it).

| 2019–2026, after-tax, compounded | pre-CAGR | after-tax CAGR | Sharpe | max DD |
|---|---|---|---|---|
| Basket buy-and-hold 1.0× | 59.2% | 54.8% | 1.31 | −54% |
| **Basket B&H + panic overlay** | 67.5% | **62.9%** | **1.37** | −51% |
| Basket B&H 1.5× (leveraged) | 81.8% | 76.8% | 1.26 | −71% |
| Basket B&H 2.0× (leveraged) | 98.4% | 92.8% | 1.24 | −83% |
| Top-1 momentum 1.0× (ST tax) | 65.7% | 40.5% | 1.28 | −52% |
| Panic-dip swing only (ST tax) | 12.1% | 8.0% | 0.91 | −11% |
| SPY buy-and-hold | 15.8% | 13.7% | 0.85 | −34% |

**Net:** chasing a higher *number* is easy (leverage the basket); chasing higher *risk-adjusted, after-tax* return is what's hard, and swing-trading the dips doesn't do it. The single defensible enhancement to buy-and-hold is a small, VIX-gated panic overlay.

---

## Verdict first (Deliverable 7)

**Probability that a standalone, rules-based 1–5-day reversal system on these names produces a tradeable edge for this trader — net of costs, net of Michigan+federal short-term tax, out of sample, versus after-tax buy-and-hold of the same names: ~10%.**

Not because reversal is absent — a mild reversal tilt exists and two conditional effects are strongly significant — but because the **after-tax hurdle versus buy-and-hold on this universe is arithmetically out of reach** of the measured effect sizes (§D3: the strategy must gross 134–151% of B&H's gross to tie after-tax; measured signals support roughly a third of that).

Two narrower findings **do** survive every test we threw at them (multiple-testing haircut, excess-over-drift demeaning, per-symbol robustness, sub-era splits, independent re-implementation):

1. **Panic-regime dip-buying** (RSI(2) < 5 while VIX ≥ 30): +4.0% *excess* 5-day return per event (t = 3.3 full-sample; t = 3.9 in 2020–26 alone; positive in 17/17 symbols; median ≈ mean; **stronger excluding 2008–09**; survives next-open entry at +3.3–3.7%). Fires ~0 times in calm years, in clusters during crises (2008: 101 events, 2011: 128, 2022: 95 across 17 names).
2. **Earnings-day crashes continue down** (1-day drop ≤ −8% on an earnings reaction day): −1.7% excess at 3 days (t = −3.0); in 2013–19 the 3-day follow-through was −7.2% with a 12% hit rate. *Buying the earnings dip at this horizon is the wrong trade;* if anything the tradeable implication is "don't catch it for 2–3 sessions."

**Single strongest argument against the whole program:** the effect the trader can actually harvest year-round (plain oversold dip-buying) has an excess-over-drift of only +0.2%/1d–+0.5%/5d, *statistically indistinguishable from zero* (t ≈ 1.6–1.7) even pooled across 17 names and 19 years — while the sacrifice (short-term tax rate on 100% of gains plus forfeited drift while out of market) is enormous on a universe compounding 20–70%/yr. The hindsight-annotated ±20% swings on the reference charts are the *range* of realized paths, not a harvestable quantity; the real-time capturable slice measured here is ~1% per 5-day event. Three independent literatures (Nagel 2012, Medhat–Schmeling 2022, Lou–Polk–Skouras 2019) reach the identical conclusion from different angles, so this is not a quirk of my sample.

**Crucial distinction the number hides:** the ~10% is for a *standalone, year-round rules system that must beat after-tax B&H*. A **narrow, VIX-gated tactical overlay** — deploy dip-buys via MOC entry *only* when VIX ≥ 30, sit in cash/holdings otherwise — is a genuinely different and much better bet: +4.0% excess/5d (t=3.3), 17/17 symbols, stronger outside 2008–09, execution-feasible at ~2–4 bps, ~+2.6% net-of-tax per event. Its problem is not edge, it is *opportunity frequency* (0 trades in 7 of 20 years) and *correlation* (it fires exactly when the trader's semi holdings are being marked down hardest). As a discretionary "add on true panic days" rule layered on a buy-and-hold core, it is defensible; as *the* strategy, it can't be, because it's idle most of the time and idle time in these names costs 20–70%/yr of forgone compounding.

**One additional datum that would most reduce uncertainty:** live, out-of-sample confirmation that the VIX≥30 panic-dip effect still pays *post-2022* at retail MOC execution — i.e., paper-trade (or forward-track, no capital) every RSI2<5 & VIX≥30 signal for the next 12–18 months and compare realized 5-day MOC-to-close returns against the +4% prior. The execution question I originally flagged (can a 3:55pm MOC order capture the overnight-gap leg?) is now largely *answered* by Lou–Polk–Skouras + the closing-auction microstructure evidence — MOC is the right, cheap venue and it captures the overnight leg — so the remaining uncertainty is pure out-of-sample persistence of a signal that, by construction, has only ~8 independent crisis episodes behind it.

---

## Deliverable 0 — Revert or trend? (the empirical heart)

### Headline: at 1–5 days these names **mean-revert mildly — they do not short-term-trend** — but the tilt is conditional, not unconditional

Pooled event study, extended-17, full period (values are pooled mean forward returns; *t* = date-clustered Newey–West):

| Condition (close t) | n events | fwd 1d | fwd 3d | fwd 5d | 5d t-stat |
|---|---|---|---|---|---|
| **Unconditional baseline** | 78,797 | +0.13% | +0.37% | +0.62% | 5.1 |
| RSI(2) < 5 | 4,317 | +0.31% | +0.71% | +1.03% | 4.2 |
| RSI(2) < 10 & >200dma | 4,184 | +0.38% | +0.64% | +0.91% | 3.4 |
| RSI(2) > 95 (overbought) | 6,591 | +0.04% | +0.20% | +0.38% | 2.6 |
| z(3d ret) < −2 | 2,378 | +0.33% | +0.54% | +1.04% | 2.5 |
| 20%+ below 20dma proxy (−10%) | 3,185 | +0.68% | +1.30% | +1.89% | 3.1 |
| 1d drop ≤ −8% | 575 | +0.94% | +0.10% | +1.39% | 2.0 |
| 1d gain ≥ +8% | 722 | −0.83% | −0.31% | +0.18% | 0.8 |

Direction: oversold days are followed by *better*-than-baseline returns, overbought days by *worse*-than-baseline (though still ≥ 0 — shorting strength loses to drift). So the monthly-horizon "liquid stocks invert to momentum" result does **not** carry down to 1–5 days on this universe. The buy-the-dip premise is directionally right; the question is magnitude.

### The honest test: excess over each name's own drift (demeaned per symbol × era)

These names compounded so hard post-2013 that *any* long signal shows positive raw forward returns. Demeaning by each (symbol, era)'s own mean forward return isolates what the *timing* adds:

| Condition | n | excess 1d (t) | excess 3d (t) | excess 5d (t) | verdict |
|---|---|---|---|---|---|
| RSI(2) < 5 | 4,332 | +0.20% (1.6) | +0.37% (1.3) | +0.48% (1.7) | **not significant** |
| RSI(2) < 10 & trend | 4,199 | +0.25% (1.3) | +0.26% (0.4) | +0.28% (0.1) | **not significant** |
| RSI(2) > 95 | 6,597 | −0.12% (−2.0) | −0.24% (−1.6) | −0.34% (−1.7) | marginal fade |
| drop ≤ −8%, no earnings | 453 | +1.18% (1.2) | +0.12% (1.5) | +1.26% (1.7) | economically real, statistically weak |
| **drop ≤ −8%, earnings day** | 124 | −0.78% (−1.7) | **−1.74% (−3.0)** | −1.00% (−1.8) | **significant continuation** |
| **RSI(2)<5 & VIX ≥ 30** | 614 | +1.12% (1.8) | +2.32% (2.0) | **+4.00% (3.3)** | **significant reversal** |
| RSI(2)<5 & VIX < 20 | 2,171 | +0.04% (0.6) | +0.08% (0.2) | +0.04% (−0.1) | **zero** |

The pattern is textbook liquidity-provision: **reversal pays only when someone needs liquidity** (panic tape, forced selling), is absent in calm tape, and *inverts* when the drop carries genuine cash-flow news (earnings). In VIX 20–30 "worry" tape, dip-buying is actually the worst of the three regimes (≈ −0.2% excess 5d in era 3).

### Sub-era stability (core-7)

- **2007–2012 (flat/bear, B&H CAGRs −27% to +7%):** nothing works unconditionally; baseline ≈ 0; only VIX≥30 dips pay (+4.4% raw 5d).
- **2013–2019 (bull, B&H +20–52%/yr):** everything long-flavored "works" because the tape does; RSI2<5 adds ~+0.6% over baseline at 5d; **earnings crashes were brutal continuation (−7.2% 3d, hit-rate 12%)**.
- **2020–2026 (vol-bull, B&H +31–73%/yr):** dip signals show their best 1-day excess (+0.3–0.5%, t ≈ 1.9–2.2); VIX≥30 dips +3.0% excess 5d (t=3.9).

### Overnight-gap decomposition (execution reality)

For drop events, the gap from drop-day close to next open contains most of day-1's bounce (no-earnings drops, era 3: gap +0.95% of cc1 +1.44%; next-open 3-day entry is *negative*, −1.08%). **The bounce is captured at the close of the drop day or not at all.** This is consistent with the overnight-return literature and materially degrades any "decide at tonight's close, buy tomorrow" implementation. The 5-day horizon retains some next-open-entry value (+0.6–1.4% raw), the 1–3-day horizon largely does not.

### Signal frequency (core-7, per name-year)

RSI2<5: 13.4 · RSI2<10&trend: 13.3 · z3<−2: 7.8 · drop≤−8%: 2.3 (of which no-earnings: 1.9) · RSI2<5&VIX≥30: 2.0 (all in crisis years — 0 in most years, 15–19/name in 2008/2011/2022).

---

## Deliverable 1 — Real-time signal specification (pre-registered)

All computable at close t from bars ≤ t (RSI(2) approximable intraday at ~3:55pm for MOC execution; noted, not assumed):

- **RSI(2):** Wilder, period 2, seed = SMA of first two changes. Thresholds tested: {<5, <10, >90, >95}.
- **z-score:** 3-day return vs trailing 252-day distribution (exclusive of day t). Thresholds {−1.5, −2, +2}.
- **% below 20dma:** {−5%, −10%}. **ATR-normalized 1-day move:** (Δclose)/ATR14(t−1), threshold −2.5.
- **1-day return:** {−5%, −8%, −10%, [−12,−8]%, +5%, +8%}.
- **Filters:** >200dma trend flag; VIX close buckets {<20, 20–30, ≥30} (and {<25, ≥25} for drops); earnings-day flag = announce date or next trading day, realized reports only.
- **Exits examined descriptively:** fixed 1/3/5-day horizons only. No profit targets, MA-crosses, or stops were searched (Connors' published finding that stops hurt this trade family was treated as prior art, not re-fit).
- **Search space:** 32 conditions × 4 eras × 2 universes = **256 cells** examined (highly overlapping, ~30–60 effectively independent tests). Bonferroni-style threshold for 5% significance ≈ |t| ≥ 3.2. Survivors: VIX≥30 dip-buying (t 3.3–3.9), earnings-crash continuation (t −3.0, borderline), and nothing else.

## Deliverable 2 — Look-ahead & survivorship audit

What we verified about the FMP feed (live curl tests, this session):

- **Bars are split-adjusted** (verified through NVDA 10:1 2024-06-10; no |1d|>45% artifacts except AMD's genuine +52.3% 2016-04-22).
- **`dividend` field is NOT split-adjusted; `adjDividend` is.** Using raw `dividend` for total-return add-backs inflates pre-split-era dividends 10× on LRCX/AVGO/NVDA/KLAC — caught and corrected mid-study (shifted 2013–19 baseline cc1 from 0.21% → 0.15%). Any FMP-based pipeline doing total-return math must use `adjDividend`.
- **Special dividends / capital returns create phantom "drops"** in split-adjusted price series (KLAC 2014-11-26 −20.1% is a $16.50 special-dividend ex-date; ASML 2012-11-29 similar). 8 of 2,316 drop≤−5% events were ≥2% ex-div artifacts — negligible pooled impact, but a real trap for drop-triggered rules.
- **Earnings dates:** modern rows are announce dates (spot-checked against known reaction days: AMD 2017-05-02, NVDA 2018-11-16, MU 2024-12-19 all flag correctly); one known miss — ASML's accidental early Q3-2024 release (2024-10-15, −16.3%) is dated ~90d away in FMP, so it contaminates the "no-news" bucket. News-vs-no-news classification by earnings calendar alone is ~95% clean, not perfect.
- **History is truncation-bounded** at exactly 5,000 rows (2006-08-23), not IPO-bounded. AVGO (2009) and NXPI (2010) miss the GFC — a mild late-entry tilt in the 17-name pool.
- **Survivorship:** fixed present-day universe = survivorship-biased by construction. Every name here survived and won; names like Cypress, Xilinx, Maxim (acquired) and worse fates are absent. This inflates the *baseline drift* (making B&H harder to beat) but also inflates dip-buying's raw returns (dips in eventual winners revert more). The *excess* tests partially neutralize this; the VIX≥30 effect being positive in 17/17 including laggards (INTC +) is reassuring but the bias direction on conditional effects is genuinely ambiguous — flagged, not resolved.
- **Intraday caveat (from prior project verification):** FMP's EOD endpoint includes the *in-progress* bar during market hours — any live implementation reading "yesterday's close" intraday must guard against consuming today's partial bar (look-ahead in production, not in this study).
- **^VIX close** is same-day information available before the equity close in real time — legitimate at decision time.

## Deliverable 3 — Cost and tax model (rates independently verified against IRS Rev. Proc. 2025-32, MI Treasury, CRS)

**Costs (per round trip, retail size $10k–$100k):** these are among the most liquid equities on earth (multi-billion-$ ADV; penny-to-few-penny quoted spreads). Half-spread ≈ 0.5–2 bp/side; commissions $0; SEC/TAF fees < 0.2 bp; retail PFOF price improvement typically nets effective ≤ quoted. **Round trip ≈ 3–8 bp; we used 10 bp conservatively.** Costs are *not* the binding constraint. Slippage at this ADV: nil. Capacity: non-issue (the one thing genuinely in the retail trader's favor).

**Taxes (2026, verified):** federal ordinary 10–37% (TCJA structure made permanent by OBBBA, July 2025); MI flat **4.25%** (trigger cut did not fire for 2026); NIIT 3.8% above $200k single / $250k MFJ MAGI (thresholds not indexed); LTCG 15% (20% above $545,500 single). MI taxes all gains as ordinary income — no state LT preference.

**Break-even gross required for the swing strategy to tie after-tax B&H of the same names (5-yr horizon, B&H taxed once at LT on exit):**

| Bracket scenario | ST rate | LT rate | B&H 20%/yr gross → | swing must gross | B&H 30%/yr gross → | swing must gross |
|---|---|---|---|---|---|---|
| fed 24%, no NIIT | 28.25% | 19.25% | 17.1% a.t. | **23.8%/yr** | 26.1% a.t. | **36.4%/yr** |
| fed 32%, no NIIT | 36.25% | 19.25% | 17.1% a.t. | **26.8%/yr** | 26.1% a.t. | **41.0%/yr** |
| fed 32% + NIIT | 40.05% | 23.05% | 16.5% a.t. | **27.5%/yr** | 25.3% a.t. | **42.2%/yr** |
| fed 35% + NIIT | 43.05% | 23.05% | 16.5% a.t. | **29.0%/yr** | 25.3% a.t. | **44.4%/yr** |

**Measured gross achievable** (event means × frequency, 25%-of-capital sizing, 4 slots, 10 bp cost — descriptive accounting, not a fitted backtest): RSI2<5 everywhere ≈ **13.9%/yr**; RSI2<10&trend ≈ 10.1%/yr; no-news-drop ≈ 10.7%/yr. Versus a 27–44%/yr requirement. **The gap is ~3×, and no parameter within the pre-registered grid closes it.** (Idle-cash T-bill yield on ~70–75% uninvested time adds ~3%/yr — still nowhere close.)

**Wash-sale (verified §1091/Pub 550):** a same-ticker dip-buyer re-entering within 30 days rolls every disallowed loss into the next lot's basis. Intra-year this is bookkeeping; the traps are (1) **year-end straddle** — December losses + January re-entry defer the deduction a full tax year while gains stay currently taxable, so a losing-December, re-entering strategy pays tax on more than its economic income in year 1; (2) the $3,000/yr net-capital-loss cap against ordinary income if the strategy has a losing year. Trader-tax-status/§475(f) mark-to-market is **not** realistically available at 20–60 trades/yr (courts have required near-daily, substantial, continuous activity).

## Deliverable 4 — Regime dependence and expected failure modes

The measured effect is a short-vol/liquidity-provision payoff and behaves exactly as that theory predicts:

- **Pays:** VIX ≥ 30 panic tape (excess +4.0%/5d, 17/17 symbols, both 2008-era and 2020s-era). Percentage-wise *stronger outside* the GFC than inside it.
- **Zero:** calm tape (VIX < 20 excess ≈ 0.0%) — in-calm dip-buying is pure drift capture, i.e., beta you could have owned cheaper by holding.
- **Worst:** "worry" tape (VIX 20–30) and any drop that carries earnings news — continuation, not reversal.
- **Expected failure mode, stated in advance:** a genuine structural bear (2008-style, or an AI-capex unwind hitting the sector's cash flows) turns clustered panic-dip entries into serial −5 to −8% MAE knife-catches while correlation goes to 1 across all 7 names — the strategy's worst months coincide with the portfolio's worst months (it is *short* the same tail the holdings are long). The 2007–2012 era is the template: five years where the sector halved and dip-buying returned ≈ 0 gross before tax.

## Deliverable 5 — Benchmark and success bar

Per-year gross tally (25% sizing, 4 slots, 10 bp, 5-day holds — accounting of measured events):

- **RSI2<10 & trend:** monthly-Sharpe **0.58**, Sortino 0.58; years range −23.8% (2018) to +41.2% (2023). Loses to SMH B&H (Sharpe **0.83**) on risk-adjusted terms *before* costs and taxes. After tax it is not close.
- **No-news −8% drops:** Sharpe 0.44; lumpy; several negative years (2008: −19%, 2020: −12%).
- **RSI2<5 & VIX≥30:** Sharpe **2.9**, Sortino 4.9 *in the years it trades* (13 of 20): 2008 +26%, 2009 +30%, 2020 +33%, 2022 +9% gross on the tally basis — but zero participation in 7 calm years, and the Sharpe rests on ~8 crisis episodes, not 176 independent bets.
- **SPY B&H** same period: Sharpe 0.63. SMH: 0.83.

**Success bar restated:** after-tax, the swing strategy needed ≥ ~27–44%/yr gross depending on bracket; the best full-time configuration measured ≈ 14%/yr gross. Versus SPY (a fairer bar if the alternative is "don't hold semis"), the RSI2 strategy's ~14% gross ≈ SPY's ~13%/yr gross with similar-or-worse drawdowns — no after-tax case either.

## Deliverable 6 — Decision thresholds (kill criteria)

Per your instruction these were treated as guidance, not a tripwire — every conditional variant in the grid was examined *before* concluding. Thresholds written before results: OOS/era-consistent excess t ≥ 3.2 (Bonferroni over the grid); after-tax per-event expectancy > 0 net of the B&H-forgone hurdle; effect present in majority of symbols. **Status:** plain dip-buying fails all three; earnings-crash continuation passes significance (as a *negative* signal); VIX≥30 panic-dip passes all three but cannot constitute a standalone strategy (episodic). No amount of bending the criteria changes the 3× gross-return shortfall against the after-tax hurdle — the constraint is arithmetic, not statistical.

## Prior art (multi-agent web research, each thread adversarially fact-checked)

### Connors RSI(2) — verified 7/8 claims against primary sources
Canonical spec confirmed (buy RSI2<5 above 200dma; exit close > 5dma; **no stops** — Connors' testing found stops hurt returns without reliably cutting drawdowns). Independent replications: SPY 1993–present ≈ 0.9%/trade, ~9% CAGR at 28% exposure, **34% max DD**; QQQ variant 71% win, 10.7% CAGR vs 82%-of-period B&H. Two findings directly on point: (a) index-level mean reversion is **regime-dependent, not a law** — pre-~1983 the S&P showed short-term *momentum*; (b) at the individual-stock level the edge **halved** (0.89%/trade 2003–07 → 0.52% 2010–18, Alvarez, 88,750 Russell-3000 trades) and the surviving excess **concentrates in illiquid, ex-index names** — removing Russell-3000 membership *added* +121% cumulative return in one controlled comparison. That is precisely why the effect is thin on mega-liquid semis, and it matches our demeaned result.

**Verification status:** Connors and Tax threads were both researched *and* independently fact-checked (7/8 claims CONFIRMED each). The Academic, Extreme-drop, and Microstructure threads completed their research pass but their adversarial-verify agents hit the session token limit and did not run — treat those three as **single-source research, not double-checked** (individual paper citations below carry their own peer-review status). Every one of the three, however, converges on the same conclusion as my independent FMP study, which is the stronger corroboration.

### Academic short-term reversal vs momentum — *research-only (verify pass not run)*
The cross-sectional literature is actively hostile to 1–5-day dip-buying in this exact stock profile, and it matches my data point-for-point:
- **Medhat & Schmeling (RFS 2022):** double-sort on prior-month return × turnover. Reversal survives *only* in low-turnover stocks; the **highest-turnover decile (the AMD/NVDA/MU profile) shows short-term *momentum* +1.37%/mo (t=4.74)**, strongest in the largest/most-liquid names, net +1.00%/mo after costs. In a largest-500-only build, reversal earns −2 bps/mo (dead). At the 1-month horizon the dip premise *inverts* for this universe.
- **Nagel (RFS 2012):** 1–5-day reversal in large/liquid/low-vol stocks is "very close to zero when VIX is low," rising to ~0.1%/day only at 95th-percentile VIX — **and ~40% of the daily-horizon profit is bid-ask bounce** (0.30%/day at trade prices → 0.18%/day at quote midpoints). *This is precisely my VIX≥30-only result, arrived at independently.*
- **Khandani & Lo (JFM 2011):** 1-day contrarian gross edge in the largest-cap decile ≈ +0.04%/day (1995) → ≈ 0.00%/−0.04%/day (2005–07) — i.e., zero in mega-caps before costs for the whole sample.
- **Only industry-hedged / residual reversal survives** in large caps (Hameed–Mian 0.32–0.47%/mo; Da–Liu–Schaumburg: only the non-fundamental residual reverts, the across-industry component *momentum*s). A 7-name single-sector long-only book **cannot** industry-hedge — a sector-wide semi dip loads on the momentum (continuation) component. This is a structural reason the watchlist is close to a worst-case universe for the trade.
- Anomaly-decay context: Chen & Velikov (JFQA 2023) ~4 bps/mo average net across 204 anomalies; McLean–Pontiff 58% post-publication decay; Robeco (Blitz 2023) — individual short-term reversal signals have break-even costs < 25 bps at 1,300–2,000%/yr turnover (dead retail), surviving only as hedged, netted, institutional composites; Robeco's own 2023 statement: classic short-term reversal "has… vanished entirely in most regions."

### Extreme single-day-drop reversal (Bremer–Sweeney tradition) — *research-only (verify pass not run)*
The "buy the −10% day" effect was real in 1962–86 and has been dismantled in exactly the optionable large-cap segment here:
- **Bremer & Sweeney (1991):** −10%+ days in big stocks rebounded +1.77% day+1 (1962–86). **Cox & Peterson (1994):** reversal ≈ 0 after Oct 1987, mostly bid-ask bounce at quote midpoints, and days +4 to +20 were significantly *negative* (drops predicted further underperformance). **Park (1995):** day+1 reversal is a closing-price-within-spread artifact; residual < spread.
- **Choi & Jayaraman (2009):** the 2-day rebound after ≥10% drops exists **only in non-optionable firms (+0.72–0.78%); optionable firms — every liquid semi — show −0.24% to +0.06%, statistically zero.**
- **News vs no-news is decisive and runs against the trade:** Chan (2003), Pritamani–Singal (2001), Savor (2012) — large moves *with* news drift/continue, only *no-news* moves revert, and Tetlock (2010) puts even the no-news reversal at ~0.5% per 1-SD move over 10 days (trivial vs an 8–12% drop). Since ~all 8–12% single-day drops in these seven names are earnings/guidance/export-control events, they sit in the *continuation* bucket. **Martineau (2022):** post-earnings drift is dead for all-but-microcaps since ~2006 (announcement price ≈ martingale). A vendor backtest (QuantRocket, 2014–20, top-decile dollar-volume) found buying ≥1σ gap-downs "highly unprofitable," with the *short* side earning ~10%/yr — large caps continued lower harder. *This is my earnings-day continuation result (−1.74% 3d, t=−3.0) from the other side.*

### Microstructure & execution — *research-only (verify pass not run); this thread resolved my open execution question*
- **Costs are a rounding error.** Live FMP pull confirms median $-ADV: MU ~$44B, NVDA ~$32B, AMD ~$15B, AMAT/KLAC ~$3.8B, LRCX ~$3.0B, ASML ~$2.8B. A $10k–$100k order is 0.0002–0.003% of ADV. Penny-tick quoted spreads ≈ 0.5–2 bps (sub-$650 names), ~1–3 bps MU, ~3–10 bps ASML (SEC half-penny tick postponed to Nov 2026). Best controlled retail study (Schwarz–Barber–Huang–Jorion–Odean, JF 2025, 85k real market orders): 33% price improvement, round-trip 7–46 bps on a *25-bp-spread* sample → scaled to these names, **~1–4 bps round trip ex-ASML** ($5–$20 on $50k). My 10-bp assumption was conservative.
- **Price-level corrections to the brief:** ASML ≈ **$1,797** (not ~$700); KLAC did a **10:1 split effective 2026-06-12** (now ≈ $232); LRCX 10:1 in Oct 2024 (≈ $350). Confirmed in the split-adjusted cache.
- **The decomposition that resolves execution feasibility — Lou, Polk & Skouras (JFE 2019):** in value-weighted ex-microcap equities there is **no net close-to-close reversal**, but it splits into **+0.93%/mo overnight (t=4.28) and −1.05%/mo intraday (t=−3.25)**. The reversal payoff lives in the **close-to-open gap**. **This independently reproduces my own gap decomposition** (drop-day bounce is +0.7–1.0% of a +1.4% day-1 move, and next-open 3-day entry is *negative*). Consequence for design: **enter at the signal-day close (MOC), not next open** — the closing auction is the cheap, deep venue (Bogousslavsky–Muravyev: ~half-spread cost, reverts overnight), while next-open entry forfeits the positive overnight leg *and* holds the negative intraday leg, plausibly flipping expectancy negative. My close-entry (cc) numbers already embed the overnight leg — so they are the *achievable* ones via MOC, and even they don't clear the after-tax bar except in the VIX≥30 subset.
- Overnight *market* drift is not a free tailwind: Boyarchenko et al. — S&P overnight drift Sharpe 1.1 pre-cost → −0.5 post-cost, and ≈ zero since 2021. Gap risk cuts the other way for multi-day holds: NVDA gaps ~5% on ~85% of earnings — the big moves happen when you can't exit.

### Tax mechanics — verified 7/8 claims (IRS Rev. Proc. 2025-32, Topic 409, CRS IF11820, MI Treasury)
2026 brackets, MI 4.25%, NIIT thresholds, wash-sale §1091 mechanics, $3,000 loss cap, LTCG breakpoints all confirmed to the dollar. Deferral + step-up make the B&H comparison even harsher at long horizons than the 5-year table above.

## Inputs assumed (session was autonomous; confirm to sharpen numbers)

1. **Federal bracket:** modeled 24/32/35/37, NIIT on/off — headline uses 32% + MI 4.25% (36.25% ST). Tell me the actual bracket and the break-even table row applies directly.
2. **Capital/position size:** assumed $10k–$100k orders → costs fixed at ~10 bp; conclusions insensitive from $5k to ~$5M.
3. **"Couple day":** tested 1, 3, and 5 trading days; 5d is the most favorable horizon for the dip trades, 1–3d for nothing.
4. **Data source:** FMP retail is survivorship-biased for broad screens; for this fixed 7–17 name universe the residual biases are the IPO gaps and winner-selection documented in D2. Polygon/Norgate would tighten D2 but will not change D3's arithmetic, which is where the thesis fails.

---

*Scripts (research artifacts, not strategy code): scratchpad/reversal-study/{pull-data,study,v2-checks,yearly-tally,tax-breakeven,independent-verify}.mjs — session scratchpad, reproducible against cache.json (FMP pull of 2026-07-11).*
