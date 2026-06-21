import { deleteWatchlistRow } from "../lib/store.mjs";

export default async (req) => {
  if (req.method !== "DELETE") return new Response("Method not allowed", { status: 405 });
  const ticker = decodeURIComponent(new URL(req.url).pathname.split("/").pop() || "");
  if (!ticker) return new Response("Missing ticker", { status: 400 });
  await deleteWatchlistRow(ticker);
  return Response.json({ ok: true, ticker: ticker.toUpperCase() });
};
