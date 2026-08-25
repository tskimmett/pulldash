/**
 * Semantic review API routes.
 *
 * These run only where a local agent can run (the pulldash CLI/dev server
 * and the Electron internal server). On the hosted deployment the providers
 * list is empty and the browser hides the feature. All semantic modules are
 * imported lazily so hosted bundles never load provider/agent code.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

const HOSTED = !!process.env.VERCEL;

const semantic = new Hono()

  // Which local agents are usable? Empty list => feature hidden in the UI.
  .get("/providers", async (c) => {
    if (HOSTED) return c.json({ providers: [] });
    try {
      const { listAvailableProviders } =
        await import("@/semantic/providers/index");
      return c.json({ providers: await listAvailableProviders() });
    } catch {
      return c.json({ providers: [] });
    }
  })

  // Cached result lookup (repo + PR + head SHA).
  .get("/result/:owner/:repo/:number/:sha", async (c) => {
    if (HOSTED) return c.json({ error: "not available" }, 501);
    const { readCachedReview } = await import("@/semantic/cache");
    const number = parseInt(c.req.param("number"), 10);
    if (!Number.isInteger(number)) {
      return c.json({ error: "invalid PR number" }, 400);
    }
    const review = await readCachedReview(
      c.req.param("owner"),
      c.req.param("repo"),
      number,
      c.req.param("sha")
    );
    if (!review) return c.json({ error: "not found" }, 404);
    return c.json({ review });
  })

  // Start (or join) an analysis job. Body: { provider, input: AnalysisInput }.
  .post("/analyze", async (c) => {
    if (HOSTED) return c.json({ error: "not available" }, 501);
    const { startAnalysisJob } = await import("@/semantic/jobs");
    const body = await c.req.json<{
      provider?: string;
      input?: import("@/semantic/providers/types").AnalysisInput;
    }>();
    const { provider, input } = body;
    if (
      !provider ||
      !input?.owner ||
      !input.repo ||
      !Number.isInteger(input.number) ||
      !input.headSha ||
      !Array.isArray(input.files)
    ) {
      return c.json({ error: "invalid request body" }, 400);
    }
    const job = startAnalysisJob(provider, input);
    return c.json({ jobId: job.id, status: job.status });
  })

  // Stream job progress via SSE; replays the full progress log on connect.
  .get("/jobs/:id", async (c) => {
    if (HOSTED) return c.json({ error: "not available" }, 501);
    const { getJob } = await import("@/semantic/jobs");
    const job = getJob(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);

    return streamSSE(c, async (stream) => {
      let cursor = 0;
      let alive = true;
      stream.onAbort(() => {
        alive = false;
      });

      while (alive) {
        while (cursor < job.progress.length) {
          await stream.writeSSE({
            event: "progress",
            data: job.progress[cursor++]!,
          });
        }
        if (job.status !== "running") {
          await stream.writeSSE({
            event: job.status,
            data: JSON.stringify(
              job.status === "done"
                ? { review: job.result, warnings: job.warnings }
                : { error: job.error }
            ),
          });
          return;
        }
        await new Promise((r) => setTimeout(r, 300));
      }
    });
  })

  // Cancel a running job.
  .delete("/jobs/:id", async (c) => {
    if (HOSTED) return c.json({ error: "not available" }, 501);
    const { getJob } = await import("@/semantic/jobs");
    const job = getJob(c.req.param("id"));
    if (!job) return c.json({ error: "not found" }, 404);
    job.abort.abort();
    return c.json({ ok: true });
  });

export default semantic;
