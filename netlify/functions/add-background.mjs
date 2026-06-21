import { scoreTicker } from "../lib/pipeline.mjs";
import { putWatchlistRowWithHistory, putJob } from "../lib/store.mjs";

// Background function: filename ends in "-background", returns 202 immediately,
// then runs up to 15 minutes. Client polls GET /api/jobs/:jobId.
export default async (req) => {
  // Client generates jobId (Netlify background functions discard the response body,
  // so the id must be known to the client up front for polling).
  const { ticker, jobId } = await req.json().catch(() => ({}));
  if (!ticker || !jobId) return new Response("Missing ticker/jobId", { status: 400 });
  const sym = ticker.toUpperCase();

  await putJob(jobId, { status: "running", total: 1, completed: 0, tickers: [sym] });

  try {
    const row = await scoreTicker(sym);
    await putWatchlistRowWithHistory(sym, row);
    await putJob(jobId, { status: "done", total: 1, completed: 1, rows: [row] });
  } catch (e) {
    await putJob(jobId, { status: "error", error: String(e.message || e), ticker: sym });
  }

  return new Response("", { status: 202 });
};
