# Swing Tab — Exit & Conviction Study: "why did we sell AMD before the run?"

_Repo: gnocchi.website screener · generated 2026-07-12 · deep FMP pull 2006-08 → 2026-07-10._
_Method: deterministic off-cache reconstruction using the LIVE swing engine (`netlify/lib/short-backtest.mjs` — `computeShortSignal.entryStrong` v5 gate + the shipped 40%-stop/63-day-TIME exit), byte-identical to the site. Two data sets: the 165 MB `deep-cache.json` (488 names, 2006–2026, through the 2008/2011/2015/2018/2020/2022 bears) for the honest universe test, and the 130-name swing watchlist over 2024-06 → 2026-07 for the forensic. Harness: `scripts/swing-validate/exit-forensics.mjs`, `exit-grid-deep.mjs`, `entry-conviction.mjs`. Artifact: `scratchpad/swing-validate/exit-grid-deep.json`._

_Trigger: the user saw the panel sell AMD at $278 (Jan 14 → Apr 16 2026, +24.45%, "TIME" exit) while AMD ran on to $557, asked "why did we miss the run — and would holding, or trading more/less often, have done better?", and asked to study this across the backlog to raise edge vs SPY and cut losses._

---

## TL;DR — five findings, one reverses a prior decision

**1. The 63-day TIME cap is a guillotine that clips the fat right tail.** It is the *primary* exit and fires on ~98% of trades regardless of trend. On the honest 2006–2026 cohort it holds average winners to **+18%** while a let-it-run exit books **+47–49%** on the same trades. AMD is the poster child: the v5 gate bought it, rode ~60 days, sold at the cap, and **re-bought — four times — as it ran $160 → $557**, capturing disconnected +36% / −4% / +21% / +83% slices instead of the whole move.

**2. "Trade more often" is exactly backwards; "hold through the trend" is the fix.** The engine already churns (a fresh entry every ~60 days on a persistent leader). That churn is what chopped AMD's run into pieces. Trading *less* — one position held through the trend — captured multiples more.

**3. But the textbook "let winners run with a trailing stop" does NOT work here — it's the worst thing you can do.** Chandelier ATR-trails and fast 50-DMA-break exits get **whipsawed** by the normal pullbacks that precede big moves. On the deep cohort they cut win rate to **31–35%** and turn edge **negative** in every regime. On AMD's Jan-2026 entry they stopped out on Feb 4 at **−14% to −20%**, days before the launch. Tight stops and this high-beta momentum universe are incompatible.

**4. The one exit that both captures runs AND controls risk is a 50/200 death-cross exit (`maCross`) over a long runway — and it reverses the v4 "drop the death-cross" decision.** v4 dropped it because, tested on a 63-bar window, it clipped winners. Given room (252 bars) it is the standout: **best edge vs SPY (+6.8% cohort / +8.8% OOS / +3.2% bear)**, captures ~buy-&-hold's return (+16.9% vs +18.5%), the **best worst-case of any high-return rule (−41.5% vs −53%)**, cuts average losers better (−14.9% vs −23.7%), at **no cost to win rate** (~equal to the 63-day cap). It would have held AMD the whole way (no death-cross on the run).

**5. There is a real "best-of-the-best" conviction tier — and it is liquidity + momentum, not entry-strength.** Among v5 entries, `$-vol ≥ $3B/day` and `3-month momentum ≥ 40%` roughly **double** the edge of the base gate (OOS edge +5.5% vs +2.4% under the current exit; +17% vs +9% under `maCross`), with higher win rate. techScore 15/16 helps a little; sector-RS 3-vs-2 barely moves. This is your "make the good buys known" lever.

**The unavoidable honesty anchor (unchanged from prior studies):** on a real in-sample (2006–2016, incl. the GFC) **every** exit rule has *negative* edge vs SPY. All the positive numbers are post-2017, survivor-only, bull-heavy. `maCross` and the conviction tier are **better beta harvesting with better risk control — not proven alpha, and no protection buying into a grinding bear.**

---

## 1. Forensic — AMD, every shipped v5 entry (2024-06 → 2026-07-10, last close $557.89)

The panel you saw (entry Jan 14 @ $223.60 → Apr 16 @ $278.26) is a real trade, but it fires under the **older seed version your live panel is still running** (the v4 gate: techScore≥12, $300M, no sector-lead requirement). The current v5 gate on this branch fires slightly different dates — same mechanism, same lesson. Here is v5's actual sequence:

| # | entry | entry $ | 63-day cap exit | exit $ | shipped P/L | what happened next |
|---|---|---|---|---|---|---|
| 1 | 2024-07-08 | 178.69 | 2024-10-04 | 170.90 | −4.36% | chopped in the 2024 range |
| 2 | 2025-07-16 | 160.08 | 2025-10-14 | 218.09 | **+36.24%** | **kept running** |
| 3 | 2025-10-15 | 238.60 | 2026-01-15 | 227.92 | −4.48% | dipped, then ran |
| 4 | 2026-01-21 | 249.80 | 2026-04-22 | 303.46 | **+21.48%** | **ran to $557** |
| 5 | 2026-04-23 | 305.33 | _still open_ | 557.89 | +82.72% | — |

From the #2 entry ($160.08, 2025-07-16), AMD is **+248%** to today. The engine booked it in four disconnected pieces. A single `maCross` hold from that entry never hit a death-cross → it rides to today: **+123% on the #4 entry alone vs the +21% the cap booked.** Chandelier/trend-break exits on #4 were stopped out Feb 4 at **−14% to −20%**.

## 2. Watchlist aggregate (104 shipped entries, 47 names, 2024-06 → today)

_This window is the 2024–26 AI bull on today's survivors — every number here is inflated by survivorship + regime. It shows the **mechanism**, not a forecast. The honest figures are §3._

| exit rule | avg P/L | med hold | win % | edge vs SPY | total $ (@$10k/trade) |
|---|---:|---:|---:|---:|---:|
| **shipped (63-day cap)** | +19.2% | 63 | 61.5% | +15.1% | $199,836 |
| **maCross (death-cross)** | **+58.9%** | 97 | 55.8% | **+51.9%** | **$612,094** |
| trendBreak (50-DMA loss) | +10.9% | 31 | 41.4% | +9.6% | $113,045 |
| chandelier −3×ATR | +4.4% | 15 | 40.4% | +3.6% | $45,774 |
| chandelier −4×ATR | +7.9% | 23 | 44.2% | +6.4% | $81,671 |
| hold 126 days | +34.3% | 126 | 62.5% | +28.2% | $356,707 |
| _hold-to-today (never sell — ceiling)_ | _+83.6%_ | _184_ | _73.1%_ | _+67.5%_ | _$869,975_ |

`maCross` captured **70% of the never-sell ceiling as an actual, executable rule.** The trailing stops captured the least.

## 3. The honest test — deep 2006–2026 cohort (n=1,475, full 252-day runway)

Same trades every row; only the exit differs. Benchmark = SPY buy-&-hold over each trade's own window.

| exit rule | avg P/L | **edge vs SPY** | win % | avg win | avg loss | med hold | worst |
|---|---:|---:|---:|---:|---:|---:|---:|
| shipped63 (now) | +3.9% | +1.42% | 51.7% | +18.0% | −11.1% | 63 | −41.5% |
| hold126 | +9.2% | +3.10% | 59.3% | +27.0% | −16.6% | 126 | −52.5% |
| hold252 | +18.5% | +5.73% | 59.9% | +46.6% | −23.7% | 252 | −53.4% |
| **maCross** | +16.9% | **+6.79%** | 50.0% | +48.7% | −14.9% | 182 | **−41.5%** |
| trendBreak | +0.8% | −0.22% | 31.7% | +15.0% | −5.8% | 22 | −28.9% |
| chandelier −3×ATR | +0.0% | −0.58% | 35.1% | +10.5% | −5.7% | 14 | −25.3% |
| chandelier −4×ATR | +0.1% | −0.94% | 34.6% | +14.6% | −7.6% | 25 | −25.3% |

Split by era and regime (edge vs SPY):

| rule | IS <2017 | OOS ≥2017 | BULL entry | BEAR entry |
|---|---:|---:|---:|---:|
| shipped63 | −2.70% | +2.40% | +1.35% | +1.86% |
| maCross | −1.47% | **+8.76%** | **+7.33%** | +3.22% |
| hold252 | −3.54% | +7.95% | +6.66% | −0.40% |
| chandelier −3×ATR | −1.17% | −0.44% | −0.62% | −0.31% |

`maCross` is best out-of-sample and in both live regimes, with the smallest max-loss of the high-return rules. **It is negative in-sample (−1.47%)** — so it is not proven alpha; but as a risk-managed way to stop clipping winners it dominates both the 63-day cap and a naive long hold. The chandelier family is negative essentially everywhere.

## 4. "Which buys are the good buys?" — conviction cut (OOS ≥2017, n=1,191)

Edge vs SPY within each sub-tier of the base gate:

| entry sub-tier | n | shipped63 edge | maCross edge | maCross win% |
|---|---:|---:|---:|---:|
| **$-vol ≥ $3B/day** | 401 | **+5.47%** | **+17.49%** | 68.8% |
| $-vol $1–3B/day | 790 | +0.84% | +4.32% | 48.0% |
| **3-mo momentum ≥ +40%** | 221 | **+5.42%** | **+17.43%** | 60.6% |
| 3-mo momentum +15–40% | 676 | +0.74% | +6.78% | 53.1% |
| techScore ≥16 | 157 | +3.73% | +10.68% | 58.0% |
| techScore =15 | 344 | +3.17% | +12.80% | 57.9% |
| techScore =14 | 690 | +1.72% | +6.31% | 52.9% |
| sector-RS =3 | 428 | +3.15% | +6.74% | 55.4% |
| sector-RS =2 | 763 | +1.98% | +9.89% | 54.8% |
| **ALL (base gate)** | 1,191 | +2.40% | +8.76% | 55.0% |

The separation is driven by **liquidity and momentum**, not technical-strength or sector-RS. A highlight/size-up tier of "**$3B+/day AND 3-mo momentum ≥ 40%**" roughly doubles the base edge. (In bears the same two tiers carry all the edge, but on n≈20 COVID-snapback entries — directional, not reliable.)

## 5a. SHIPPED (2026-07-12) — v6 implements levers 1 + 2

User approved: **exit = 50/200 death-cross (CROSS) + 40% catastrophe stop + 189-session backstop (TIME)**, plus the **conviction tier** and the Swing-tab hold note. `SBT_SEED_VERSION` 5→6 (re-seeds all logs); `SBT_SEED_SESSIONS` 130→240 and `SBT_WINDOW_DAYS` 195→420 so ~200-day holds can complete inside the visible log (seed fetch 420→560 bars). Conviction (`avgDollarVol ≥ $3B` AND `mom63 ≥ 40%`, on top of `entryStrong`) rides on `computeShortSignal` → stamped on positions/trades (★ in the popover + Swing table) and the daily notifier. Chosen backstop stats (deep cohort, `maCross189`): edge +4.7% vs shipped-63's +1.4%, win 53.6%, avg win +37.9%, worst −41.5%, median hold 182 sessions ≈ 230 calendar days (avg ~200 — the tab note). Tests: 181 + 27 proofs green; offline verification (`scripts/swing-validate/verify-v6.mjs`) on the real cache: AMD books ★ +86.1% (189-session ride) and re-enters — vs the old +36/−4/+21 slices; MU +350.7% / INTC +340.4% at the backstop; BA −8.4% / GE −12.3% cut by CROSS.

## 5. Recommendation menu (as studied — see §5a for what shipped)

Ranked by evidence and by fit to the stated goals (raise edge, cut losses, stop missing runs):

1. **Replace the 63-day guillotine with `maCross` (exit on a 50/200 death-cross) + the 40% catastrophe stop + a long backstop cap (~189–252 sessions).** Biggest single lever; directly fixes the AMD complaint; best honest edge and best drawdown of the run-capturing rules; no win-rate cost. Reverses the v4 death-cross removal — justified because v4 tested it on a strangling 63-bar window. Code: swap the exit in `short-backtest.mjs`, bump `SBT_SEED_VERSION`. Keep the honesty banner.
2. **Add a conviction tier — "$3B+/day AND 3-mo-momentum ≥40%" (secondary: techScore≥15)** — to (a) badge/rank the best setups in the UI ("make the good buys known") and (b) optionally size positions by it. Roughly doubles edge. Frame it honestly as a high-beta mega-cap tilt.
3. **Do NOT add a tight trailing/trend-break stop to "cut losses."** The data is unambiguous: it whipsaws this universe, halves win rate, and kills edge. Loss control comes from entry selection + the wide catastrophe backstop, not a tight trail.
4. **Retire win-rate as a target; track edge-vs-SPY and avg-win/avg-loss.** Win rate rises mechanically with hold length and ignores the fat tail that this whole strategy lives on.
5. **(Optional) Regime overlay:** size down / stand aside when SPY < its 200-DMA. No rule here has reliable edge in a real bear; most of the worst losses are bear/high-vol entries. This is the honest way to "get rid of the bad losses" at the portfolio level.

## Boundary (completeness critic)

- **Survivorship:** the 488 names are today's survivors; every positive number is an upper bound. The $1B+uptrend gate did structurally reject 17/17 tested go-to-zero names ([swing-bestofbest-report.md](swing-bestofbest-report.md)), which bounds — but does not remove — the bias.
- **In-sample is negative for every rule** (2006–2016). The OOS edges are a post-2017 bull phenomenon. `maCross`/conviction improve the *risk-adjusted beta harvest*; they are not demonstrated market-timing alpha.
- **Bear numbers are small-n and COVID-snapback-weighted** — do not read them as crash protection.
- **Costs/slippage excluded**; `maCross`'s longer holds mean *fewer* round-trips than the churning 63-day cap, so it is cost-favorable, not cost-adverse.
- **Panel vs branch:** the user's live panel runs an older seed version; the mechanism (cap clips winners) is identical across versions.
