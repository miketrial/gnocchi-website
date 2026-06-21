# Gnocchi.website — Stock Watchlist Dashboard

A condensed, scannable stock watchlist. Each row scores a ticker against the 8-point
checklist, shows the score, and condenses the valuation/forward columns. Front end is a
single static page; the scoring runs server-side on Netlify Functions so API keys never
reach the browser.

- **Front end:** [`index.html`](index.html) — the watchlist table, the Net page, search/add,
  rescan, right-click delete. Works offline with seed data; uses the live API when served by Netlify.
- **Backend:** Netlify Functions in [`netlify/functions/`](netlify/functions) + shared code in
  [`netlify/lib/`](netlify/lib).
- **Scoring rules:** [`scoring-rules.md`](scoring-rules.md) is loaded verbatim as the Layer-3
  Anthropic system prompt. Change scoring there, not in code.

---

## How it works

```
Browser (index.html)  ──fetch /api/*──▶  Netlify Functions (hold FMP + Anthropic keys)
                                          ├─ Layer 1a: FMP REST pull (financials)
                                          ├─ FMP gap-fill: anything FMP can't supply is
                                          │   fetched by a Claude web-search call
                                          ├─ Layer 1b/2: Claude web search (insider,
                                          │   contracts, departures, disruption, P/E)
                                          ├─ Layer 3: Anthropic scores it (scoring-rules.md)
                                          └─ writes the row to Netlify Blobs
```

Scoring is slow, so add/rescan run as **Background Functions**: the client generates a
`jobId`, POSTs it, then polls `GET /api/jobs/:jobId` until `status: "done"`, re-rendering
rows as they land.

### Endpoints
| Method | Path | What |
|--------|------|------|
| GET | `/api/watchlist` | all stored rows |
| POST | `/api/watchlist/add` | background: score one ticker (`{ticker, jobId}`) |
| POST | `/api/watchlist/rescan` | background: re-score every ticker (`{jobId}`) |
| DELETE | `/api/watchlist/:ticker` | remove a row |
| GET | `/api/jobs/:jobId` | poll job status/progress |
| GET / POST / PUT / DELETE | `/api/net` (`/:id`) | Net table CRUD (no scoring) |

---

## Setup

### 1. Prerequisites
- **Node.js** (LTS) — install from <https://nodejs.org> if `node -v` fails.
- Netlify account with this site connected.

### 2. Install
```bash
npm install
```

### 3. API keys
Keys live in two places — **never** in the repo:

- **Local:** copy `.env.example` to `.env` and paste your keys:
  ```
  FMP_API_KEY=...
  ANTHROPIC_API_KEY=...
  ```
- **Production:** Netlify → Site configuration → Environment variables, scoped to
  **Functions**. Use the exact names above — no `NEXT_PUBLIC_` / `VITE_` prefix (that would
  leak them into the browser bundle).

> The keys shared in chat earlier should be treated as burned — rotate them first.

### 4. Run locally
```bash
npx netlify link      # once: connect to your Netlify site
npx netlify dev       # serves index.html + functions + env at http://localhost:8888
```
Open the **served URL** (not the raw file) so `/api/*` works. Opening `index.html` directly
still renders, but falls back to seed data with no live scoring.

### 5. Deploy
```bash
npx netlify deploy --prod
```
(or just push to the connected Git branch).

---

## Verify it's working
1. Open the deployed site; check the Network tab — `/api/watchlist` returns JSON and **no
   key appears anywhere** in client requests or page source.
2. Type a ticker in the search box → it shows "Scoring…", then fills in once the background
   job finishes.
3. A row that needed non-FMP data carries a flag noting it was filled via Claude web search.

## Persistence
All data lives in **Netlify Blobs** (auto-scoped, no extra secret): `watchlist`, `net`, and
`jobs` namespaces. Nothing is stored on the function's local disk (it's ephemeral).

## Cost controls
- **Two Anthropic calls per ticker:** one `claude-haiku-4-5` web-search call that gathers
  verification + events + any missing FMP fields together, then one `claude-sonnet-4-6`
  scoring call. (A single combined call would be costlier — it'd process bulky web-search
  tokens at Sonnet prices.) Models set at the top of `pipeline.mjs`.
- **Prompt caching:** the scoring-rules system prompt is cached, so a rescan pays ~10% input
  price on it after the first ticker.
- **Web searches** are capped (3 for verification/events, 2 for gap-fill; 0 when FMP is complete).
- **Smart rescan:** the Rescan button only re-scores rows older than **2 days** (`STALE_DAYS`
  in `rescan-background.mjs`). **Shift+click** forces a full rescan of every row.
- **Hard cap:** set a monthly spend limit and disable auto-reload in the Anthropic Console
  (Settings → Limits, and Billing). FMP free plan caps `limit` at 5 (handled in code).

## Notes / known sharp edges
- FMP free tier: the `/api/v3` legacy endpoints are retired — code uses the `/stable` API.
  Quarterly `limit` is capped at 5 on free; prior-year revenue comes from the annual statement.
  Forward P/E and insider data come from the Claude web-search step (FMP free doesn't supply them).
- There is no password gate; add Netlify password protection or auth if you need it.
