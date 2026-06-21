import { getJob } from "../lib/store.mjs";

export default async (req) => {
  const jobId = decodeURIComponent(new URL(req.url).pathname.split("/").pop() || "");
  const job = await getJob(jobId);
  if (!job) return Response.json({ status: "unknown" }, { status: 404 });
  return Response.json(job);
};
