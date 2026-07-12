# Swing Tab — Market-Regime Overlay Study (REFUTED — no engine change)

_Repo: gnocchi.website screener · generated 2026-07-12 · deep FMP cache 2006-08 → 2026-07-10._
_Method: the shipped **v6** rule (v5 best-of-best entry gate; exit = 40% catastrophe stop → 50/200 death-cross → 189-session backstop) reconstructed over the 488-name deep cache, full-runway cohort n=1,475 (same cohort as [swing-exit-edge-report.md](swing-exit-edge-report.md)). Overlay variants applied to the SAME trades; SPY regime = SPY vs its own 200DMA (plus a "falling" sub-state: SPY also below its 50DMA). Harness: `scripts/swing-validate/regime-overlay.mjs` → `scratchpad/swing-validate/regime-overlay.json`._

_Trigger: post-v6 follow-up — "size down when SPY < its 200-DMA — that's where the remaining ugly losses cluster." This study tests that claim and every practical form of the overlay._

---

## TL;DR — the overlay is refuted, in both forms

**1. Entry-time sizing (skip or half-size entries while SPY < 200DMA) does nothing.** Edge vs SPY actually *drops* (+4.74% → +4.50% skipping, +4.63% half-sizing) and cumulative $ falls ~12%. The v5 gate already does the regime filtering implicitly — a name must be in its own uptrend with its sector leading SPY, so only 194/1,475 cohort entries fire in bear regime at all, and **under the v6 death-cross exit those bear entries earn a *better* edge (+6.3%) than bull entries (+4.5%)** — they're dominated by post-bottom recovery rides (COVID +24.9% edge, 2022 +8.9%), exactly the trades a bear filter deletes.

**2. State-based de-risking (exit/trim open trades when SPY crosses below its 200DMA mid-hold) is destructive.** Full exit-at-cross collapses edge from **+4.74% → +0.05%** (cum$ $1.94M → $0.66M) and makes the worst trade *worse* (−41.5% → −50.4%, since the cross can print below the eventual exit). Trim-half is just proportionally less bad (+0.42%). Why: 847/1,475 trades see a SPY sub-200 close mid-hold — the index dips below its 200DMA *routinely* (2025-03, 2024 wobbles, 2021-11) — and **282 of those trades are ≥+25% winners that averaged +62% held vs +10.5% cut at the cross**. An index-level trailing stop is the same whipsaw the single-name trailing stops showed in the exit study, one level up.

**3. The intuition wasn't crazy — the autopsy shows why it feels right but isn't actionable.** Of the 97 ugly losses (≤−25%, 6.6% of trades): only **7% were bear-regime entries** (the claim as stated is wrong); **64% were bull entries where SPY crossed sub-200 mid-hold** — and exiting *those* at the cross would have saved 13pp (−19.5% vs −32.4%). But that's hindsight-selection: ex-ante, the same cross signal fires on 3× as many big winners as ugly losers, so acting on it has sharply negative expected value. The remaining 29% (SMCI, TSLA, RDDT…) were single-name blowups inside a healthy market that no market overlay touches — that tail is what the 40% catastrophe stop is for.

**Decision: no engine change, no sizing rule.** The v6 system already self-regulates: the entry gate starves position count in bears (fewer names qualify), and the per-name death-cross exits handle real trend deaths name-by-name. Optional (not shipped): a purely informational SPY-regime line on the Swing tab (the Bounce pipeline's `getMarketRegime()` already computes it) — context for the human, no claimed edge.

---

## 1. Overlay variants on the identical v6 cohort (n=1,475, 2006–2026)

| variant | trades (eff. weight) | avg P/L | edge vs SPY | win% | worst | cum$ ($10k×w) |
|---|---:|---:|---:|---:|---:|---:|
| **base (shipped v6)** | 1,475 | **+13.12%** | **+4.74%** | 53.6% | −41.5% | **$1,935,580** |
| skipBear (no entries SPY<200DMA) | 1,281 | +13.35% | +4.50% | 55.0% | −41.5% | $1,710,055 |
| halfBear (half-size those) | 1,475 (1,378) | +13.23% | +4.63% | 54.2% | −41.5% | $1,822,817 |
| skipFalling (drop only SPY<200 & <50DMA) | 1,356 | +13.47% | +4.68% | 54.1% | −41.5% | $1,826,994 |
| spyCrossExit (exit at in-trade SPY cross) | 1,475 | +4.47% | **+0.05%** | 47.3% | **−50.4%** | $658,957 |
| spyCrossHalf (trim half at the cross) | 1,475 | +8.80% | +0.42% | 53.2% | −45.7% | $1,297,269 |

Same ordering out-of-sample (≥2017: base edge +6.06% vs skipBear +5.68% vs crossExit +0.25%). In-sample (<2017) every variant is negative — the regime overlay does not fix the honest IS story either (base −0.76%, skipBear −0.99%, crossExit −0.78%).

## 2. Per-crisis: what a bear filter would actually delete

| crisis window | n | avg P/L | edge | worst | skipBear keeps |
|---|---:|---:|---:|---:|---:|
| GFC 2007-09 | 65 | −16.8% | −3.8% | −40% | 14 |
| COVID 2020 | 24 | **+43.8%** | **+24.9%** | −40% | 9 |
| 2022 bear | 75 | +6.0% | **+8.9%** | −28% | 15 |

The GFC entries were bad — but the gate fired only 65 in two years, and the same filter that removes them removes the COVID/2022 recovery entries that carry the whole bear-regime aggregate. Net: a wash on edge, minus $225k of cum$. (euro-2011/2015/2018 fired ≤3 entries each — the v5 gate already sat those out almost entirely.)

## 3. Loss autopsy — where the ≤−25% tail actually lives (97 trades, 6.6%)

| bucket | share | note |
|---|---:|---|
| entered while SPY<200DMA | 7% | the original claim — **wrong**: bear entries are rare and fine |
| bull entry, SPY crossed sub-200 mid-hold | 64% | exiting at the cross saves 13pp on THESE — but the same signal hits 282 big winners (+62% held vs +10% cut): negative EV ex-ante |
| bull entry, SPY never crossed | 29% | idiosyncratic blowups (SMCI −40.9%, TSLA ×4, RDDT −41%) — market overlays can't see them; this is the 40% stop's job |

Worst-12 detail (all STOP exits, mostly the hyper-beta cluster: TSLA ×4, MU ×2, U, RDDT, SMCI, CEG, FSLR-GFC): 10 of 12 entered in a bull regime. The tail is **name risk, not market risk** — consistent with the conviction-tier finding that sizing should key off the name (liquidity/momentum), not the index.

## 4. Boundary

Survivor-only cohort (upper-bound numbers); full-runway cohort excludes 2026 entries (their runway is open); regime = binary SPY vs 200DMA — a VIX-percentile or drawdown-depth overlay is a different (untested) hypothesis, but the deep-entry study's per-crisis grid already showed no entry rule makes grinding bears profitable; edge windows for spyCrossExit use an arithmetic SPY-window approximation (entry→cross), which slightly flatters the variant if anything.

## 5. What this changes in practice

Nothing mechanical. The two real risk levers remain the shipped ones: (1) the entry gate keeps you *mostly out* of bears by starvation (few qualifying names), and (2) the ★ conviction tier is the evidence-backed sizing signal — it keys off the name's own liquidity + momentum, which is where the tail actually lives. If market context is wanted on the Swing tab it should be a label, not a multiplier.
