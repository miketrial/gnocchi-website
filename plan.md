# plan.md — Gnocchi.website Stock Watchlist Dashboard

## 0. Purpose

Build a web dashboard at **Gnocchi.website** that displays a stock watchlist as a
condensed, scannable table. Each row scores a ticker against the existing 8-point
checklist, shows the score, and condenses the rest of the analysis columns. The site
must let the user add a ticker, rescan all tickers, delete a row, and reach an
externally-saved "buys" file.

The scoring logic is **already specified** — do not invent it. Mirror it exactly from
the two source documents below. The web app is a new front end + thin backend over the
*same* scoring rules and the *same* column layout the user already uses in Excel.

## 1. Source-of-truth references (read these first)

| Reference | File | Use it for |
|-----------|------|-----------|
| Skill definition | `SKILL.md` (stock-watchlist-analyzer) | High-level workflow, locked data sources, column layout, color palette, sector P/E baselines |
| Scoring engine | `scoring-rules.md` (Layer 3 system prompt) | The exact GOOD/BAD logic per metric, the JSON input/output contract, the FMP endpoints, the verification/flag rules |
| Output design | `Gnocchi_website_design.pdf` | The UI/UX spec (hand-annotated mockup) — translated in §5 below |
| Data + columns to mirror | `watchlist.xlsx`, sheet `Analysis Log` | The 20-column layout and the look/feel of populated rows |
| Domain | Gnocchi.website | Deployment target |

**Do not duplicate or paraphrase the scoring rules into new code comments.** The backend
should load `scoring-rules.md` as the Layer-3 system prompt verbatim, so the website and
the skill never drift apart. If the rules change, only that file changes.

## 2. Hard constraints (non-negotiable)

1. **No API keys in client code, ever.** Both `FMP_API_KEY` and `ANTHROPIC_API_KEY`
   live only on the server, loaded from environment. The browser calls *our* backend;
   the backend calls FMP and Anthropic. A static/client-only build is not acceptable
   because it would expose the keys in page source / network tab.
2. **Keys come from `.env`, which is gitignored.** Never commit keys. Provide
   `.env.example` with empty placeholders. (The keys shared in chat must be rotated
   before launch — assume they are burned.)
3. **Scoring rules are not reimplemented in JS.** Scoring is done by the Layer-3
   engine (Anthropic Messages API) using `scoring-rules.md` as the system prompt, fed a
   merged JSON payload. JS only orchestrates data-gathering and renders results.
4. **Column layout and headers must match `watchlist.xlsx` exactly** (see §4).
5. **Hosting is Netlify.** The site is already on Netlify. Use **Netlify Functions** as
   the server-side layer (no separate Express/FastAPI server). This shapes three things:
   - **Keys are Netlify environment variables**, set in Site configuration → Environment
     variables, scoped to Functions (not exposed to the client). Never name a secret with
     a client-inlined prefix (`NEXT_PUBLIC_`, `VITE_`, etc.) — those get baked into the
     browser bundle. Read keys only inside function code.
   - **Long work goes in Background Functions.** Standard synchronous functions time out
     at ~30s; the scoring pipeline (and especially a full rescan of ~50 tickers) exceeds
     that. Background Functions return a 202 immediately and run up to 15 minutes — use
     them for the pipeline, with the client polling for results (see §3).
   - **No local-disk persistence.** Functions are stateless with an ephemeral filesystem;
     a server-side JSON/SQLite file will not survive between invocations. Use an external
     store (see §6.1).

## 3. Architecture

```
Browser (Gnocchi.website, static front end on Netlify)
   │  fetch /api/* (Netlify redirects /api/* → /.netlify/functions/*)
   ▼
Netlify Functions (server-side; hold FMP_API_KEY, ANTHROPIC_API_KEY via env)
   ├─ quick sync functions:  GET watchlist, DELETE ticker, poll job status
   └─ Background Function (up to 15 min) — the scoring pipeline:
        ├─ Layer 1a: FMP REST pull (structured financials)
        ├─ Layer 1b: verification fetches (EDGAR, OpenInsider, stockanalysis.com)
        ├─ Layer 2: web search for contracts / departures / disruption
        ├─ Layer 3: Anthropic Messages API — scoring-rules.md as system prompt,
        │           merged payload as user message, returns 20-column JSON scorecard
        └─ writes result to the external store (§6.1)
   ▼
External store (Netlify Blobs or hosted DB) — survives between invocations
```

Suggested stack: a **Next.js** app deployed to Netlify (the Netlify adapter maps API
routes/functions automatically), **or** a plain static front end (Vite/React) plus
hand-written functions in `netlify/functions/`. Either is fine; both keep keys server-side
per constraint #1. Pick whichever Claude Code can stand up with one-command local dev via
`netlify dev` (which emulates functions + env locally).

### Async pattern (because of the ~30s sync timeout)
The scoring pipeline must not run in a synchronous function. Pattern:
1. `POST /api/watchlist/add` (or `/rescan`) → a **Background Function** (`*-background`
   suffix or `config.background = true`). It returns **202 + a `jobId`** immediately and
   processes in the background.
2. The background function writes progress/results to the external store keyed by `jobId`
   (and by ticker).
3. The browser **polls** `GET /api/jobs/:jobId` (a fast sync function) until status is
   `done`, then re-renders the affected row(s). For a rescan, update rows as each ticker
   completes rather than waiting for all ~50.

### Endpoints
- `POST /api/watchlist/add` — body `{ ticker }` → **background**: kicks off the pipeline for one ticker, returns `202 { jobId }`. Writes the scored row to the store on completion.
- `POST /api/watchlist/rescan` — **background**: re-runs the pipeline for all stored tickers (the "Rescan" button), returns `202 { jobId }`. Updates each row in the store as it finishes.
- `GET /api/jobs/:jobId` — fast sync: returns `{ status, completed, total, rows? }` for polling.
- `DELETE /api/watchlist/:ticker` — fast sync: removes a row (the right-click delete).
- `GET /api/watchlist` — fast sync: returns all stored rows for initial render.
- `GET /api/net` — fast sync: returns all rows of the Net table (manually-entered holdings/buys).
- `POST /api/net` / `PUT /api/net/:id` / `DELETE /api/net/:id` — fast sync: create/edit/remove a Net row. These are plain CRUD (no scoring pipeline) — the Net table is manually maintained.

## 4. Data model — mirror watchlist.xlsx (20 columns)

Headers and order are fixed by `Analysis Log`. Two-line headers in Excel become
`label` / `sublabel`:

| Col | Field key | Header | Sub-header |
|-----|-----------|--------|-----------|
| A | `company_ticker` | Company/(Ticker) | — |
| B | `revenue` | Revenue | TTM vs prior yr |
| C | `margin` | Margin | Latest Qtr YoY |
| D | `contract` | Contract | Current Qtr |
| E | `debt` | Debt | Latest Qtr |
| F | `departures` | Departures | 90 days, C-suite |
| G | `forecast` | Forecast | Current guidance |
| H | `disruption` | Disruption | NEW threat ≤6 mo |
| I | `insider` | Insider | Buy ≤30d / Sell ≤60d |
| J | `score` | Score | of 8 |
| K | `vs_sector_pe` | vs Sector | P/E |
| L | `pe_fwd` | P/E (FWD) | — |
| M | `pe_ttm` | P/E (TTM) | — |
| N | `pe_5yr` | P/E | 5yr Avg |
| O | `fwd_vs_ttm` | FWD vs TTM | — |
| P | `trend` | Trend | direction / 2nd derivative |
| Q | `expectations` | Expectations / Priced-In | analyst revisions |
| R | `catalysts` | Catalysts | dated forward events |
| S | `ps_ratio` | P/S | Ratio |
| T | `analyst_rating` | Analyst | Rating |

Columns B–I are `"GOOD"` / `"BAD"`. J is a signed string (e.g. `"6/8"`, or `"-7/8"` when
the insider bullish-buy flag fires — see scoring-rules.md score calc). K is a signed
percent or `"N/M"`. P/Q/R are short plain-English strings. The backend output JSON should
use these exact keys so the renderer is a straight map.

Reference data shape (real rows from the sheet, for styling/realism):
- `DELL/(Dell Tech.)` · GOOD,BAD,GOOD,GOOD,GOOD,GOOD,GOOD,BAD · `6/8` · `-3%` · `21.4x (fwd)` · `~22x` · `~12x` · Bullish · …
- `AMZN/(Amazon)` · all GOOD · `8/8` · `+13%` · `28.3x (fwd)` · `28.9x` · `~48x` · Bullish · …
- `NOW/(ServiceNow)` · GOOD×7, Insider BAD · `7/8` · `-21%` · `27.7x (fwd)` · `63.1x` · `~85x` · Bullish · …

## 5. UI / UX spec — translated from Gnocchi_website_design.pdf

### Layout
- **One condensed table**, numbered rows (`1.`, `2.`, `3.` …). Row format, left → right:
  `index` · `SYMBOL` (with a small bullet/dot marker) · `Company Name` · **8 small check
  squares** · `X/8` score · **condensed remainder** of the analysis columns (K–T) from
  watchlist.xlsx.
- The 8 check squares are small with **small corner radii** (~8pt feel). Each square is
  color-coded GOOD/BAD and carries a **small label** identifying which check it is.
- **Very minimal row spacing**; small professional font (~10pt). "Do not add spacers"
  between symbol and company. Dense but readable.

### Controls (top)
- **"Rescan"** button (the mockup's "Stock list refresh") → calls `/api/watchlist/rescan`.
- **"Add to watchlist"** — a search field with a **magnifier icon**; entering a ticker
  calls `/api/watchlist/add`.
- **"Net"** element, top-right: a **floating** element (no box — just floats with a
  **slight shadow**) that links **internally** to a separate Net page/route (e.g. `/net`),
  NOT to an external file. See §5b.

### 5b. Net page (internal route, e.g. `/net`)
Clicking "Net" navigates to an in-app page that shows its own **manually-maintained table
of stock buys / holdings**. Build it to **follow the same table outline as the watchlist
table** — the layout, condensed row styling, ~10pt subtle-gray type, minimal spacing,
floating-shadow aesthetic, and the same scroll-fade / subtle-click behaviors. (Reference
the design picture for the table *outline only*; ignore the handwritten annotation text
boxes — those describe watchlist-specific behavior, not this page.)

Differences from the watchlist table: the Net table has **no 8-check squares, no score, no
Rescan, no scoring pipeline.** It is plain CRUD — the user types rows in directly (per the
original "manually updated by myself" intent). Rows persist in the same store (§6.1) via the
`/api/net` endpoints.

Columns are **not specified yet** — the instruction was to follow the table *outline*, not
fixed content. Placeholder schema for Claude Code to scaffold (Mike to confirm/adjust):
`Symbol · Company · Shares · Avg Buy Price · Buy Date · Cost Basis · Notes`. Keep cells
editable in place. Confirm the real columns before finalizing.

### Interactions
- **Right-click any row → context menu with "Delete"** → `DELETE /api/watchlist/:ticker`.
- **Click feedback is subtle/visual, not skeuomorphic** — a light state change (opacity,
  faint highlight, slight scale), "relative feel… visually, not physically."

### Legend / key
- A **key/legend** sits below the table, separated from the last row by a deliberate,
  configurable gap. It decodes the 8 condensed check-square labels (square → metric name).

### Aesthetic / global
- **Floating boxes with a slight shadow; avoid hard borders/boxes** wherever possible.
- **Font color grayish and subtle** — low-contrast, easy on the eye (not pure black).
- **On scroll down, the top fades out** (header/controls fade as content scrolls under).
- **Magnifier / search affordance** as drawn.
- Use the skill's color palette for verdicts:
  GOOD `#D5F5E3`/`#1E8449`, BAD `#FADBD8`/`#C0392B`, Yellow `#FEF9E7`/`#B7950B`,
  Neutral `#EAF2FF`/`#1A5276`, Unprofitable/gray `#EAECEE`/`#566573`.
  Score color by absolute value: 7–8 green, 5–6 yellow, 0–4 red.

## 6. Persistence

### 6.1 Watchlist store
The list of tickers + their last scorecard must persist between sessions **and** between
function invocations. On Netlify a server-side local file (JSON/SQLite) will NOT persist —
functions are stateless. Use an external store; mirror `watchlist.xlsx` as the schema.
Pick one (decision for Mike):
- **Netlify Blobs** — built-in key/value store, zero extra setup, scoped to the site.
  Recommended for a personal tool: store one blob per ticker (and per `jobId` for progress).
- **Hosted DB** — Turso (SQLite), Supabase, or Postgres. More structure/queryability; a
  little more setup. Use if you expect to grow beyond a simple list.
- **Commit-back to `watchlist.xlsx`** in the repo so Excel stays the system of record.
  Heaviest and slowest (git writes from a function); only if the `.xlsx` must remain
  canonical. Keep `fullCalcOnLoad` OFF per the skill note.

Both the watchlist rows and the Net table rows live in this same store (separate
namespaces/prefixes, e.g. `watchlist:*` and `net:*`).

### 6.2 Net table store
The Net page's manually-entered rows (§5b) persist in the same store under a `net:*`
namespace. Plain CRUD via `/api/net` — no scoring, no `jobId`, no background function.
(The earlier external-local-file approach is dropped: the Net tab is now an internal page,
which removes the browser file-sandbox problem and the desktop-wrapper question entirely.)

## 7. Scoring pipeline (per ticker) — follow scoring-rules.md

1. **Layer 1a — FMP pull** (`FMP_API_KEY`): income statement, balance sheet, cash flow,
   earnings surprises, analyst estimates, recommendations. Endpoints listed in
   scoring-rules.md. (Add an `operating_cash_flow` field from `/cash-flow-statement` — the
   utility Debt-rule OCF/debt branch needs it; otherwise it falls back to interest
   coverage and flags.)
2. **Layer 1b — verification**: EDGAR, **OpenInsider (required, checked twice)**,
   stockanalysis.com / GuruFocus. Flag discrepancies >5% on financials, any difference on
   insider.
3. **Layer 2 — web search**: contracts (current qtr), departures (90d), disruption (6mo)
   only.
4. **Layer 3 — scoring**: POST merged JSON payload to Anthropic Messages API with
   `scoring-rules.md` as the **system prompt**; model e.g. `claude-sonnet-4-6`. Parse the
   returned 20-column JSON scorecard. Honor the sector P/E baselines and the
   verification/flag rules. Borderline defaults to BAD.
5. Write the row to the external store (§6.1), keyed by ticker and `jobId`; the front end
   picks it up on the next poll.

Respect the freshness flags from the engine: financials >90d, P/E >7d, insider >60d → mark
stale. Surface `verification.flags` somewhere non-intrusive (e.g. row hover / detail).

## 8. Environment

Two places hold env vars — **never the repo**:
- **Local dev:** a gitignored `.env` that `netlify dev` loads. Write the rotated keys here
  yourself; do not paste keys into the Claude Code chat. Claude Code reads `.env` from disk.
- **Production:** Netlify dashboard → Site configuration → Environment variables, scoped to
  Functions so they're never sent to the browser.

```
# .env  (gitignored — never commit; also set these in the Netlify dashboard)
FMP_API_KEY=          # rotate the leaked one first
ANTHROPIC_API_KEY=    # rotate the leaked one first; functions-only, never client
```
Do **not** prefix these with `NEXT_PUBLIC_`, `VITE_`, or any client-inlined prefix — that
would bake them into the browser bundle. Provide `.env.example` with the same keys blank.
Add `.env` to `.gitignore` in the first commit. The watchlist store needs no secret env var
if using Netlify Blobs (auto-scoped); a hosted DB would add its own connection string here.

## 9. Build order (milestones)

1. Scaffold project + Netlify config (`netlify.toml`, `netlify/functions/`), `.gitignore`,
   `.env.example`. Confirm `netlify dev` runs functions + env locally.
2. External store (Netlify Blobs) + `GET /api/watchlist` + `DELETE`. Seed from
   `watchlist.xlsx` rows so there's data to style against.
3. Front-end table: exact 20-column mapping, 8 check squares, score, condensed columns,
   legend, palette, 10pt subtle-gray type, minimal spacing.
4. Interactions: Rescan, Add (magnifier search), right-click Delete, subtle click states,
   scroll-fade header, floating "Net" element (links to `/net`).
5. Background-function pipeline (Layer 1a → 1b → 2 → 3) behind `/add` and `/rescan`,
   returning `202 { jobId }`; add `GET /api/jobs/:jobId` polling + incremental row updates.
6. Net page (`/net`): table following the watchlist outline, plain CRUD via `/api/net`,
   `net:*` store namespace. Confirm columns with Mike.
7. Deploy: set env vars in the Netlify dashboard (not the repo); verify functions run in
   production and keys never appear in the client bundle.

## 10. Decisions needed from Mike
- Persistence store: **Netlify Blobs** (recommended) vs. hosted DB vs. commit-back to `watchlist.xlsx`?
- Net table columns: confirm/adjust the placeholder schema in §5b
  (`Symbol · Company · Shares · Avg Buy Price · Buy Date · Cost Basis · Notes`).
- Which Anthropic model for Layer 3 (cost vs. quality)?

(Resolved: the "Net" tab is now an internal `/net` page, not an external file — so the
file-sandbox options and the hosted-vs-desktop question are no longer open. A hosted
Netlify site covers everything.)
