import { listWatchlist } from "../lib/store.mjs";

export default async () => {
  const rows = await listWatchlist();
  // newest-scored first, then by score
  rows.sort((a, b) => Math.abs(parseInt(b.score)) - Math.abs(parseInt(a.score)));
  return Response.json(rows);
};
