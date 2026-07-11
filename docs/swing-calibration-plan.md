# Swing Tab — Calibration Plan (for the next agent)

_Repo: gnocchi.website screener · Swing tab = `short-*` namespace · today 2026-07-10._
_You are inheriting a finished **validation** (see `docs/swing-validation-report.md`) and a working **notifier/backtest** UI. Your job is to make the swing strategy's **entry, exit, stop, hold, and datapoint calibration the best it honestly can be** — risk-controlled first, then edge — and open a **new PR**._

---

## 0. Read this first — hard constraints
- **Do NOT merge PR #53** (`feat/swing-validation-and-lookahead-fix`). The user merges it themselves. Branch your work **off `main` AFTER #53 is merged**, or off #53's head if it isn't merged yet — ask the user which. **Open your own new PR** for a Netlify deploy preview; **never deploy to production** (the user deploys).
- **FMP-only.** Zero Anthropic/LLM calls in the swing path. Curl-test (via `node`/fetch — `curl` is sandbox-blocked) every FMP field before you depend on it.
- **Everything is on today's SURVIVORS** (the caches are today's actively-trading names; delisted are largely absent). So every positive expectancy/edge number is an **upper bound**. Design for robustness, not to maximize an in-sample number.
- Verify in the live Netlify preview before pushing; **look at the rendered output**, not just the data (a prior bug: the swing backtest CSS was scoped to Bounce's `#qsBtPop` and the popover rendered unstyled — data was right, the screen was wrong).

## 1. What already exists (build on it, don't rebuild)
- **Engine:** `netlify/lib/short-backtest.mjs` — `computeShortSignal` (6-factor 0-18 core + `entryStrong` gate, now with `SBT_LIQ_FLOOR=$300M/day`), `recordShortTransition` (long-only fold; STOP=4×ATR / TREND=death-cross / TIME=63d), `replayShortTrades`, `dailySignalLog` (the 15-session notifier), `sessionComplete` (partial-bar guard). Constants: `SBT_ENTRY_MIN=12`, `SBT_STOP_ATR_MULT=4.0`, `SBT_TIME_STOP_DAYS=63`, `SBT_LIQ_FLOOR=300e6`, `SBT_SEED_VERSION=3`.
- **Live scorer:** `netlify/lib/short-pipeline.mjs` — 11 `check*` factors (all exported), 33-pt score.
- **Deterministic harness:** `scripts/swing-validate/lib.mjs` — `loadSurvivorCache`, `labelUniverse`/`labelUniverseWeighted`, `splitByDate`, `walkForwardFolds`, `aggregateShortRule`/`aggregateNet`, `shortExitGridReport`, `swingExitGrid`, `simulateShortExit`, `portfolioSim`, `buildRegimeContext`/`regimeOf`, `bootstrapMeanCI`, `multipleTestingCheck`, `spearman`, `round`. **Reuse these — they are the LIVE engine functions, so reconstructions are byte-identical to the site.**
- **Caches** (in `scratchpad/swing-validate/`, gitignored — rebuild with the pull scripts if stale):
  - `short-study-cache.json` — 90 hand-picked liquid survivors, ~1254 bars.
  - `universe500-cache.json` — 488 broad names (company-screener top-500-by-cap), **has per-name `.meta[sym].sector`** — use this for sector work. Rebuild: `node scripts/swing-validate/universe-500.mjs`.
  - `fundamentals-cache.json` — dated fundamentals for the 90 (grades/financials/earnings by acceptedDate). Rebuild: `fundamentals-pull.mjs`.
  - `pit-cache.json` — 90 survivors + 39 reachable delisted + VIX.
- **Tests:** `tests/swing-{helpers,factors,signal,engine}.test.mjs` — 95 tests + 16 proofs, in `npm test`. **Add to these; keep them green.** Convention: `T()`/`PROOF()` negative-controls, `node:assert/strict`, `process.exit(fail?1:0)`.

## 2. What the validation already proved (don't re-litigate; build from here)
- The swing signal is a **mega-cap momentum/BETA screen with no demonstrated, transferable timing alpha**. On a broad 488-name universe the factor edges collapse to ~0, and signal-timed entries **underperform** unconditionally holding the same names by ~1.3pp. So: **do not chase expectancy** — you will be fitting regime beta. Optimize for **risk-adjusted robustness** (drawdown, tail, Sharpe/Sortino, exposure-adjusted) and OOS stability.
- **No factor-weight change beats equal-weight** at matched selectivity. Don't reweight the composite.
- **Fundamentals add no edge** (as an alpha block). BUT see §4.2 — Catalyst/earnings may still be worth a **risk GATE** (not an alpha factor).
- Long-only is correct. Costs are negligible. `hold63`/`maCross` beat the 4×ATR-stopped incumbent on expectancy — but that's **before** the risk work below, which changes the exit picture.

## 3. Learn from these specific mistakes (the user flagged them)
1. **The −47% Honeywell "buy" is unacceptable — and it exposed three real failures.** Diagnosis (reproduce with a replay of HON): the signal bought HON at $458 on 2026-06-18 (near its $496 high); the 4×ATR stop sat at $394 (−13.9%); HON then **gapped to $241 on 2026-06-29** (a ~−40% overnight news gap) and filled far below the stop → −47.38%. Lessons:
   - **(a) The backtest ENTRY ignores the Catalyst/earnings factor** (it's technical-core-only). So it buys straight into known catalysts. A hard **no-entry-within-N-days-of-earnings gate** (risk gate, not alpha) is a prime candidate — test it.
   - **(b) A 4×ATR stop is USELESS on hyper-volatile names.** Biotech `SMMT` rode to **−67% via a TIME exit** because 4×ATR ≈ 68% of price — the stop never fired. Cap the stop (see §4.3).
   - **(c) Pure overnight gaps (HON) can't be stopped.** Only **position sizing + earnings avoidance + diversification** limit the damage. Model it at the portfolio level.
2. **Do not over-interpret in-sample/small-sample signals.** The first validation pass produced several confident claims (raise the entry bar to 14; "Quality is anti-predictive"; Near-High/Sector-RS "carry the signal") that an adversarial-verification pass **overturned** — they were selectivity artifacts / within the name-clustered noise floor (~89 distinct names ⇒ SE on any IC ≈ 0.11) / non-transferable. **Every finding you ship must pass a skeptic agent trying to refute it** against the §5 gates. Prefer plateaus, OOS-stable, transferable-across-universes results.

## 4. The calibration work (workstreams)

### 4.1 The prior — is sector-by-sector calibration justified? (ALREADY MEASURED — confirm, then act)
Run `scripts/swing-validate/sector-prior.mjs` (exists). Findings on the 488-universe:
- **Expectancy varies wildly by sector** (Tech +6.7%, Basic Materials +4.4%, Industrials +3.0% … Consumer Defensive −1.0%, Energy −0.7%, Utilities −0.1%, Real Estate ~0). **But this is mostly regime BETA** (Tech/Materials ran 2022-26; defensives didn't) — sector-specific *expectancy* tuning would fit one regime. Treat with suspicion.
- **The best EXIT rule is mostly universal** (`hold63`/`maCross` for 7/11 sectors; only 4 differ, marginally). → A **universal exit** is defensible; per-sector exit params are a weak, overfit-prone win.
- **Volatility (ATR%) differs by sector** (Tech/Energy/Materials ~3% vs Utilities/Defensive/RealEstate ~2%). ATR-based stops already adapt to this — the gap is the **cap** (§4.3), which should be **per-name volatility**, not per-sector.
- **PRIOR VERDICT (your starting hypothesis — then verify/refute):** *Do NOT build sector-specific parameter sets* (they fit regime beta and overfit). Calibrate **universal** params + **per-name volatility risk control**. The one defensible sector move to TEST: **down-weight or exclude the structurally-flat sectors** (Consumer Defensive / Utilities / Energy / Real Estate) where the signal is flat-to-negative across the window — but prove it holds OOS and isn't just "tech beat everything," or it's regime-fitting. Also consider **per-sector position caps** (already in `portfolioSim`) for diversification, which is robust regardless.

### 4.2 Entry calibration (datapoints, thresholds, gates)
- **Entry bar (`SBT_ENTRY_MIN`):** keep at 12 unless you can show a higher bar is a *plateau* (not monotone-to-the-max selectivity — the prior "raise to 14" was rejected as an artifact). Sweep 10-16 with matched-n + OOS + total-PnL (not just per-trade expectancy).
- **Liquidity guardrail:** currently ≥$300M/day. Re-confirm the tier boundary (name-clustered edge was significantly negative below ~$300M; ~+1.1pp only ≥$300M — but that's beta). Test ≥$500M.
- **Earnings/catalyst risk gate (HIGH PRIORITY — the HON fix):** add a hard gate that **blocks entries within N sessions of the next earnings date** (test N=5/7/10). Data: `earnings` calendar (dated). Measure the reduction in gap-loss tail vs the entries/edge given up. This is a **risk gate**, justify it on tail reduction, not alpha.
- **Volatility/extension entry filter:** the blow-ups (SMMT, IONQ, AAOI, WULF) are hyper-volatile and/or over-extended. Test an entry filter on **ATR% ceiling** (skip names with ATR14/price > ~6-8%) and/or **distance-above-200DMA ceiling** (don't buy the most-extended names — Near-High already leans this way). Measure tail + expectancy.
- **Uptrend gate:** keep ON (px>50>200); the offline study omitted it (~20% of study entries weren't live-tradeable). Report the gated numbers as primary.

### 4.3 Exit + stop calibration (the risk core — biggest win is here)
- **HARD STOP-LOSS CAP (do this first — it's the answer to the −47% complaint).** A hard cap on single-trade loss both **caps the tail AND improves expectancy** (measured, approximate): incumbent worst −67.8% / exp 2.25% → **cap −20%: worst −20% / exp 2.43%; cap −15%: worst −15% / exp 2.65%**. Trend losers rarely recover, so cutting them early is free-to-positive. Implement a **real intrabar hard stop** (`entry × (1 − cap)`, filled at `min(bar.open, stopLine)` on a gap) as `min(4×ATR line, hard-% line)` — the tighter of the two — so hyper-volatile names can't ride to −67%. Sweep the cap (12/15/18/20%), select on the plateau + OOS + the **portfolio maxDD** (not just per-trade worst). NOTE: a hard stop still can't prevent a pure overnight gap (HON) — pair it with §4.2's earnings gate + §4.4 sizing.
- **ATR stop multiple:** the ATR stop is now a backstop behind the hard cap; re-sweep 2.5-5× under the presence of the cap.
- **Exit rule:** re-run the exit grid (`shortExitGridReport`) *with the hard cap in place* — the ranking changes when the tail is capped. Compare `hold63` / `maCross` (death-cross) / chandelier-trail / time-caps on expectancy, OOS, walk-forward, and **portfolio maxDD + Sortino** (the numbers that matter for a beta screen).
- **Hold period (`SBT_TIME_STOP_DAYS`):** re-test 40/63/84 with the hard cap. A shorter cap reduces the SMMT-style ride-downs; balance against cutting winners.
- **Trailing stop:** test a chandelier trail (lock in gains) vs the fixed stop — trend-following's edge is letting winners run, so a trail must not choke the fat tail (Best was +194% MRVL).

### 4.4 Portfolio-level sizing & risk (the honest "would this have worked" layer)
Extend `portfolioSim` (already models max-positions, per-sector caps, equal-$). Add and calibrate:
- **Volatility-scaled position sizing** (size ∝ 1/ATR so a hyper-vol name gets a smaller position — this is the real defense against the SMMT/HON single-name damage). Compare equal-$ vs vol-scaled on portfolio Sharpe/Sortino/maxDD.
- **Per-sector exposure caps** (diversification; robust regardless of the sector-alpha question).
- **Report the portfolio path with a bootstrap CI** (the prior sim was n=1). CAGR/Sharpe/Sortino/maxDD with confidence intervals.

### 4.5 Datapoints / factor hygiene (low priority — validation says no alpha here)
- Do **not** reweight the 6-factor composite (proven not to beat equal-weight).
- The 5 fundamentals add no alpha — but re-examine **Catalyst as a risk gate** (§4.2) and **Leverage/Quality as tail-risk filters** (do high-leverage / low-quality names contribute disproportionately to the blow-up tail? if so, a defensive filter, justified on tail not alpha).

## 5. Guardrails — how you decide a change is REAL (adversarially enforced)
Every shipped change must pass ALL of these, checked by a skeptic agent prompted to REFUTE it:
1. **No look-ahead / no partial-today-bar** (the guard exists; keep it). Fills use next-available price; gaps fill pessimistically at the open.
2. **Survivorship-aware:** headline numbers are upper bounds (survivors only). Report the survivors-only vs +delisted gap where you can (`pit-cache.json`).
3. **OOS / walk-forward:** params chosen in-sample only; report the OOS number beside every choice. A change that only wins in-sample is rejected.
4. **Effective-N honesty:** ~89-488 clustered names over one 2022-26 bull regime. Use **name-clustered** SEs; |IC| < ~0.03 and single-split OOS wins are noise. Don't ship signed per-factor effects that sit within ~1 clustered SE of zero.
5. **Multiple-testing:** count every rule/threshold/sector you try; apply a Bonferroni/deflated-Sharpe haircut; a winner within noise of the incumbent does not ship.
6. **Plateau not peak:** prefer regions where neighbors are within ~10%; reject monotone-to-the-edge "optima" (they're selectivity).
7. **Cost-net & risk-first:** report net-of-cost, and prioritize **drawdown/tail/Sortino** over raw expectancy (this is a beta screen — risk control is the product).
8. **Determinism & reproducibility:** every phase writes a JSON+MD artifact to `scratchpad/swing-validate/`; engine funcs stay pure; seed any bootstrap.

## 6. Deliverables & acceptance
- Calibrated constants in `short-backtest.mjs` (hard-stop cap, any exit/entry/hold changes, earnings gate, vol-sizing) — each with IS/OOS + plateau + portfolio-maxDD evidence. **Bump `SBT_SEED_VERSION`** on any entry/exit change (forces a clean re-seed).
- New/updated tests in `tests/swing-*.test.mjs` (green) covering every new gate/stop (with `PROOF` negative-controls — e.g. "a −67% ride-down is impossible once the hard cap is on"; "an entry within N days of earnings is blocked").
- A calibration report `docs/swing-calibration-report.md`: per-workstream evidence, the sector-prior verdict, the risk-control before/after (worst trade, tail %, portfolio maxDD), and everything **tested-but-rejected** with the reason.
- **Open a NEW PR** (not #53), push for a Netlify preview, verify the Swing tab + `#stBtPop` popover + the 15-session notifier render and the seed/rescan path work. **No production deploy.**
- **Acceptance:** the worst single as-if trade is bounded (no more −47%/−67% except the unavoidable pure-gap case, which is mitigated by the earnings gate + sizing); every shipped change cites survivorship-aware + OOS + plateau + portfolio-risk evidence and survives adversarial verification; anything else is documented as "tested, rejected, why."

## 7. Ultracode orchestration notes
- **Fan out** the embarrassingly-parallel work: one agent per sector (§4.1), one per exit-rule/stop-cap family (§4.3), one per entry-gate (§4.2). Pipeline: compute → adversarially-verify each finding as it lands.
- **Adversarial verify (mandatory)** every shipped finding with a skeptic prompted to REFUTE via the §5 gates (look-ahead? survivorship? OOS? effective-N? multiple-testing? plateau? portfolio-risk?). Majority-refute ⇒ drop. Backtests are where plausible-but-wrong thrives — spend the budget here.
- **Completeness critic** at the end: which sector/gate/stop/claim is unverified or unmeasured, and is the worst-trade bound actually achieved?
- Scale to the ask: this is a "make it the best, risk-first" request — use a larger finder pool + 3-5-vote adversarial verification + a synthesis stage.
