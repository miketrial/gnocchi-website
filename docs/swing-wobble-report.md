# Swing — "Hold vs Wobble" exit study

**Question.** When a name is a live BUY (the 5-gate entry signal is on) and the setup later
*weakens without a death cross*, should we **sell and re-enter when it re-fires** ("wobble"
trading) instead of **holding through** ("Hold in Ready")? The hope: sell high on the wobble,
rebuy lower.

**Method.** On the 2006–2026 deep cache (488 names, `scratchpad/swing-validate/deep-cache.json`),
every real **v6.2 entry** (fresh flat→`entryStrong`, *including* the rs126 SPY relative-strength
floor — supplied via `ret126SeriesFor`, without which no entry fires) opens an episode. Over the
identical window (entry → the shipped terminal: 40% catastrophe stop → 50/200 death cross → 189-day
TIME backstop) we compare:
- **HOLD (A, shipped):** buy at entry, hold to the shipped exit.
- **WOBBLE (B):** buy at entry; **sell** at the close the moment `entryStrong` goes false; sit in
  **cash (0%)**; **rebuy** at the close when it fires again; same per-position 40% stop; same terminal.
  B's return = compounded sub-trades.

Frictionless EOD fills (engine parity); turnover reported so real cost/tax drag is visible. n = 835
episodes. Script: `scripts/swing-validate/wobble-vs-hold.mjs` → `scratchpad/swing-validate/wobble-vs-hold.json`.

## Verdict — wobble trading loses badly; keep Hold in Ready.

| Metric (ALL, n=835) | HOLD | WOBBLE |
|---|---|---|
| Avg return / trade | **+21.4%** | +3.7% |
| Median trade | **+8.3%** | **−1.2%** |
| Win rate | **57.7%** | 40.4% |
| Edge vs SPY | **+11.2%** | **−6.5%** |
| Worst | −50.4% | −33.3% |
| Avg round-trips / episode | 1 | 5.6 |
| Time in market | 100% | **15.8%** |

Wobble beat hold in only **41%** of episodes; it costs **~18 pts of return per trade** and flips a
**+11pp SPY edge into −6.5pp**. The typical wobble trade is a net loss (median −1.2%).

### The "rebuy lower" thesis is empirically backwards
Of **3,858 re-entries, only 22.9% were below the prior exit** — 77% were higher. Average rebuy is
**+4.2% ABOVE the sell.** Structural: `entryStrong` lapses when the setup *weakens* (sell into the
dip) and re-fires when it *re-strengthens* (rebuy after the bounce). You sell dips and buy recoveries,
~5.6× per episode, sitting in cash 84% of the time — so you miss most of the trend the entry captured.

### Robust across splits
| Split | HOLD avg | WOBBLE avg | HOLD edge | WOBBLE edge |
|---|---|---|---|---|
| OOS ≥2017 (701) | +24.5% | +4.5% | +12.7% | −7.3% |
| Bear entry (109) | +23.4% | +5.9% | +17.0% | −0.6% |
| IS <2017 (134) | +4.9% | −0.7% | +3.1% | −2.5% |

Holding wins on the mean in every regime, including bear-market entries. The **only** place wobble is
competitive is the older IS split, and only *defensively* — it truncates losses (worst −19% vs −37%)
and beat hold in 51% of those episodes, but still loses on the mean. That's risk-reduction, not
profit, and it's dominated by the existing 40% stop / smaller position size.

## Conclusion
The one thing wobble buys is a smaller worst case and 84% cash — a **lower-risk, lower-return,
negative-edge** profile. The trend-following edge *is* sitting through the wobbles. **No engine
change: hold a BUY in HOLD until a real exit (death cross / 40% stop / 189-day backstop).** A genuine
shorter-term strategy would need a *different* signal (a real mean-reversion dip trigger, not the
entry-gate toggling) — and the project's Bounce + semis-reversal studies already found ~no edge there
after costs.
