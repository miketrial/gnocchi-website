import { listShortRows } from "../lib/store.mjs";

export default async () => {
  const rows = await listShortRows();
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};
