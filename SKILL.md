---
name: stock-watchlist-analyzer
description: Use this skill whenever Mike asks to analyze a stock, add a ticker to the watchlist, research a company for investment, score a stock, or refresh an existing watchlist row. Triggers on phrases like "add X to the watchlist", "analyze TICKER", "check TICKER", "research TICKER", "please add X", "score X", or any request to evaluate a stock using the 8-point checklist. Also triggers for bulk refreshes ("refresh all stocks", "update the watchlist"). This skill enforces consistent data sources, locked timeframes, and repeatable scoring so the same ticker always scores the same way across sessions.
---

# Stock Watchlist Analyzer

Produces a consistent, repeatable 8-point analysis for any stock ticker, plus a forward-looking
layer (Trend / Expectations / Catalysts) and valuation columns. The core problem it solves is
score drift between sessions: same source, same timeframe, same logic, every run.

File: `watchlist.xlsx` · Sheet: `Analysis Log` · Freeze panes: B4 · Data starts row 4 (row 3 = header).
Row backgrounds: even rows `FFFFFF`, odd rows `F2F3F4`. Always keep `fullCalcOnLoad` OFF on save
(it causes an Excel scroll-jump-to-top on this file).

---

## Timeframe philosophy

Each metric uses the timeframe most predictive and verifiable for it. Never mix timeframes within
a metric. The 8 scoring columns are all trailing/current (observable facts). Valuation uses
**forward P/E** (trailing P/E is distorted by one-time items); P/S uses TTM revenue.

---

## The 8-point checklist (each GOOD or BAD)

| # | Metric | Timeframe |
|---|--------|-----------|
| 1 | Revenue | Trailing 12 mo vs prior 12 mo |
| 2 | Margin | Latest reported quarter YoY |
| 3 | Contract | Current / most recent quarter |
| 4 | Debt | Most recent balance sheet |
| 5 | Departures | C-suite, last 90 days |
| 6 | Forecast | Management's most recent guidance |
| 7 | Disruption | NEW external threat ≤6 months only |
| 8 | Insider | Open-market buys ≤30d / sells ≤60d |

### Scoring rules (apply literally; when borderline, default to BAD)

1. **Revenue** — GOOD if TTM revenue > prior-year TTM (any growth). Pre-revenue: GOOD only if
   quarterly revenue growing ≥20% YoY; zero revenue = BAD. Acquisition-driven spikes: GOOD but note.
2. **Margin** — GOOD if gross OR operating margin improved YoY. BAD only if BOTH declined.
   Net margin doesn't count (one-time distortion). Pre-revenue: almost always BAD.
3. **Contract** — GOOD if active signed contracts / ≥10% backlog growth / new gov't awards this
   quarter. BAD if no new contracts and flat/shrinking backlog, or MOU-only with no revenue.
   (Pre-revenue exception: active contracts or MOUs count GOOD.)
4. **Debt** — GOOD if D/E < 1.0 and debt not outgrowing revenue, OR net cash positive, OR debt
   fell QoQ. BAD if D/E > 1.0 AND net cash negative, or interest coverage < 2x. Capital-intensive
   industries: allow D/E up to ~1.5x if FCF positive. (Note: this rule structurally flags
   regulated utilities, buyback compounders, and merchant power generators — read in context.)
5. **Departures** — GOOD if no CEO/CFO/COO/CTO/President exit in 90 days (a named successor counts
   GOOD). BAD if such an exit without permanent successor, multiple exits, or "effective
   immediately." Board members don't count.
6. **Forecast** — GOOD if guidance was raised or set above consensus. BAD if lowered, withdrawn,
   none issued, in-line, or merely reaffirmed/maintained.
7. **Disruption** — GOOD if no NEW material external threat in 6 months (structural competition =
   GOOD). BAD if a new regulation/ban, new competing product, or tech shift emerged ≤6 months ago.
8. **Insider** — GOOD if an open-market purchase ≤30 days, or no open-market sales ≤60 days, or
   only tax-withholding disposals. BAD if any open-market sale ≤60 days (incl. large 10b5-1), or
   net insider selling > $50M over 12 months. Foreign issuers that file no Form 4 (ADRs such as
   TSM, ASML, SONY, RYCEY, NOK, CCJ) = no activity = GOOD. Search OpenInsider.com.

### Score (Col J)
Count GOOD verdicts (max 8). Special insider rule: open-market BUY ≤30d → add +1 and display the
score with a NEGATIVE sign (visual bullish flag, e.g. -7/8). Open-market SELL ≤60d → counts as a
regular BAD. No activity → counts as GOOD. Color by absolute value: 7–8 Green, 5–6 Yellow, 0–4 Red.

---

## Locked data sources (try PRIMARY first; same source every time prevents drift)

- Revenue / Margin / Debt: SEC EDGAR 10-Q/10-K → fallback stockanalysis.com.
- Forecast / Contract / Departures: company press release / 8-K → fallback Google News (cross-checked).
- Disruption: 10-Q risk factors / dated news ≤6 months.
- Insider: **OpenInsider.com only**, checked twice. P = buy, S = sale; ignore A (award), F (tax), M
  (option exercise w/o sale).
- Valuation: forward P/E from GuruFocus → stockanalysis.com; 5yr avg from Macrotrends; P/S from
  stockanalysis.com; analyst rating from stockanalysis.com forecast page.

---

## Column layout (Analysis Log — 20 columns)

| Col | Header | Contents |
|-----|--------|----------|
| A | Company / Ticker | "TICKER\n(Company Name)" |
| B–I | Revenue, Margin, Contract, Debt, Departures, Forecast, Disruption, Insider | GOOD / BAD |
| J | Score | "7/8" (signed; colored by absolute value) |
| K | vs Sector P/E | "+14%" / "N/M" |
| L | P/E (FWD) | "XX.Xx (fwd)" |
| M | P/E (TTM) | "XX.Xx" / "N/M (loss)" |
| N | P/E 5yr Avg | "~XXx" / "N/M" |
| O | FWD vs TTM | Bullish / Red Flag / Unprofitable |
| P | Trend | how the business is trending (direction, not level) |
| Q | Expectations / Priced-In | what's expected + cheap-or-pricey |
| R | Catalysts | dated forward events to watch |
| S | P/S Ratio | "~Xx" / "N/M" |
| T | Analyst Rating | "X.X\nBuy" |

Colors: GOOD `D5F5E3`/`1E8449`, BAD `FADBD8`/`C0392B`, Yellow `FEF9E7`/`B7950B`,
Neutral `EAF2FF`/`1A5276`, Gray (Unprofitable) `EAECEE`/`566573`. Columns P/Q/R: left-aligned,
wrap text, width ~19–20, row height ~76.

---

## Forward layer (Cols P–R) — read NEXT TO the score, never merged into it

The 8-point score measures trailing quality; it ignores direction, valuation, and upcoming events,
and it under-rates defensives and turnarounds. These three columns add the missing axis.

- **Trend (P)** — is each key metric getting better or worse, regardless of level? A stock can be
  BAD-on-level but improving (turnaround) or GOOD-but-deteriorating. Use ↑/↓. Source: latest
  quarter's revenue/margin/segment direction vs prior year and prior quarter.
- **Expectations / Priced-In (Q)** — analyst rating & price-target revisions, plus cheap-or-pricey
  vs what's priced in (lean on col K). Source: stockanalysis.com / GuruFocus + col K.
- **Catalysts (R)** — specific upcoming events (earnings dates, launches, regulatory decisions,
  deal closings). Source: company IR calendar.

Tone: keep entries short and plain-English (no jargon) so a non-specialist can read them at a glance.

---

## Valuation columns & vs-Sector

- **vs Sector P/E (K):** (stock fwd P/E − sector median) ÷ sector median × 100. Bands: ≤0% Green,
  1–49% Yellow, ≥50% Red, N/M Neutral.
- **P/E (FWD) (L):** forward P/E only, suffix "(fwd)". Loss-making → "N/M (loss)".
- **FWD vs TTM (O):** fwd < ttm → "Bullish" (earnings expected to grow); fwd > ttm → "Red Flag"
  (earnings expected to fall); loss-making → "Unprofitable".

### Fixed sector baselines (forward P/E medians — LOCKED; re-baseline deliberately)

| Sector | Example holdings | Median Fwd P/E |
|--------|------------------|----------------|
| Semiconductors | NVDA, AMD, MU, MRVL, TSM, INTC, AVGO, ASML, LRCX, KLAC, AMAT, BESI, ASMPT, SNDK | 36x |
| Software / SaaS | NOW, MSFT, CRM | 35x |
| Interactive Media / Comm Services | GOOGL, META | 22x |
| Consumer Discretionary / E-commerce | AMZN | 25x |
| Technology Hardware | DELL | 22x |
| Communications Equipment | NOK, CSCO, ERIC, CIEN | 18x |
| Optical / Electronic Manufacturing (EMS) | FN | 22x |
| Electrical Equipment | ETN, NVT, VRT | 29x |
| Industrial Gases | LIN, APD | 27x |
| Heavy / Farm Machinery & Power Systems | CAT, MOD, GEV | 20x |
| Construction & Engineering / Infra Services | FIX, PWR | 24x |
| Environmental / Commercial Services | WM, RSG | 28x |
| Aerospace & Defense | RYCEY | 22x |
| Consumer Electronics / Entertainment | SONY | 20x |
| Consumer Staples (beverages / tobacco) | KO, PM, PG | 21x |
| Pharmaceuticals | ABBV, MRK, PFE, LLY | 16x |
| Healthcare Distribution | MCK, COR, CAH | 17x |
| Payment Networks | V, MA | 26x |
| Insurance (P&C) | ACGL, CINF | 14x |
| Regulated Utilities | NEE, SO, DUK, AWK | 18x |
| Independent Power / Merchant Generation | TLN, VST, NRG, CEG | 18x |
| Nuclear Fuel / Uranium | LEU, CCJ, BWXT | 65x (see caveat) |
| Space / Pre-revenue | RKLB, ASTS, OKLO | N/M |

If a stock fits no row, search `[industry] forward PE ratio median site:gurufocus.com` and add a
locked row rather than leaving K as N/M.

**Soft-baseline caveats (re-check on re-baseline):** Nuclear/Uranium 65x is anchored to only two
profitable peers (Cameco ~87x, BWXT ~42.5x) and is mania-inflated — "in line" ≠ cheap. Independent
Power 18x, Heavy Machinery 20x, and Construction & Eng 24x are anchored to large-cap forward
multiples, not the cyclical-dragged full industry. Optical/EMS 22x and Comms Equipment 18x are
contract-manufacturing/commodity medians; premium names (FN, ANET) screen far above them.

---

## Workflow

1. **Insider first** — OpenInsider.com (twice), before anything else; lock the verdict.
2. **Batch the rest** — Fundamentals (Revenue/Margin/Debt/Forecast), Signals (Contract/
   Departures/Disruption), Valuation (fwd P/E, 5yr, P/S, analyst). Fire searches in parallel.
3. **Score** — apply the rules above; borderline → BAD.
4. **Populate the forward layer** (P–R) in plain English.
5. **Verification block** — every figure traceable to a source + date; show arithmetic for vs-Sector
   and P/S; flag anything stale (>90d financials, >7d P/E, >60d insider) or unconfirmed.
6. Wait for confirmation before writing to the sheet unless the user said "just add it."
7. Write rows; keep `fullCalcOnLoad` OFF; verify.

## Pre-revenue / early-stage
Revenue GOOD only if growing ≥20% YoY from a small base (zero = BAD); Margin almost always BAD;
Contract GOOD if active contracts/MOUs; Debt evaluate net cash; Forecast BAD if no formal revenue
guidance; P/E and P/S write N/M with a one-line note.
