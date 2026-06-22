import { getPins, setPins } from "../lib/store.mjs";

// GET  /api/pins → { pins: [SYM, ...] }
// PUT  /api/pins → body { pins: [...] } → persists and returns cleaned list
export default async (req) => {
  switch (req.method) {
    case "GET":
      return Response.json({ pins: await getPins() });
    case "PUT": {
      const body = await req.json().catch(() => ({}));
      return Response.json({ pins: await setPins(body.pins) });
    }
    default:
      return new Response("Method not allowed", { status: 405 });
  }
};
