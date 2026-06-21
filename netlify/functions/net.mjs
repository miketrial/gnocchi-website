import { listNet, putNetRow, deleteNetRow } from "../lib/store.mjs";

// Plain CRUD for the manually-maintained Net table. No scoring, no jobs.
export default async (req) => {
  const id = decodeURIComponent(new URL(req.url).pathname.split("/").pop() || "");
  const hasId = id && id !== "net";

  switch (req.method) {
    case "GET": {
      return Response.json(await listNet());
    }
    case "POST": {                       // create
      const body = await req.json().catch(() => ({}));
      return Response.json(await putNetRow(body));
    }
    case "PUT": {                        // update existing
      if (!hasId) return new Response("Missing id", { status: 400 });
      const body = await req.json().catch(() => ({}));
      return Response.json(await putNetRow({ ...body, id }));
    }
    case "DELETE": {
      if (!hasId) return new Response("Missing id", { status: 400 });
      await deleteNetRow(id);
      return Response.json({ ok: true, id });
    }
    default:
      return new Response("Method not allowed", { status: 405 });
  }
};
