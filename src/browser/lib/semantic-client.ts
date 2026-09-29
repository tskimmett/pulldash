/**
 * Browser client for the semantic review API (local server only).
 *
 * All calls degrade gracefully: on the hosted deployment (or any fetch
 * failure) the provider list comes back empty and the UI hides the feature.
 */

import type { SemanticReview } from "@/semantic/schema";
import type { AnalysisInput, ProviderInfo } from "@/semantic/providers/types";

export type { AnalysisInput, ProviderInfo };

export async function fetchSemanticProviders(): Promise<ProviderInfo[]> {
  try {
    const res = await fetch("/api/semantic/providers");
    if (!res.ok) return [];
    const data = (await res.json()) as { providers?: ProviderInfo[] };
    return Array.isArray(data.providers) ? data.providers : [];
  } catch {
    return [];
  }
}

/** Returns the cached review for this PR + head SHA, or null if none. */
export async function fetchCachedSemanticReview(
  owner: string,
  repo: string,
  number: number,
  headSha: string
): Promise<SemanticReview | null> {
  try {
    const res = await fetch(
      `/api/semantic/result/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${number}/${encodeURIComponent(headSha)}`
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { review?: SemanticReview };
    return data.review ?? null;
  } catch {
    return null;
  }
}

export async function startSemanticAnalysis(
  provider: string,
  input: AnalysisInput
): Promise<string> {
  const res = await fetch("/api/semantic/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, input }),
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(data?.error ?? `analyze failed (${res.status})`);
  }
  const data = (await res.json()) as { jobId: string };
  return data.jobId;
}

export interface SemanticJobHandlers {
  onProgress: (message: string) => void;
  onDone: (result: { review: SemanticReview; warnings?: string[] }) => void;
  onError: (error: string) => void;
}

/**
 * Subscribe to a job's SSE progress stream. Returns an unsubscribe function.
 * The server replays the full progress log on connect, so late subscribers
 * (and reconnects) see everything.
 */
export function streamSemanticJob(
  jobId: string,
  handlers: SemanticJobHandlers
): () => void {
  const es = new EventSource(`/api/semantic/jobs/${jobId}`);

  es.addEventListener("progress", (e) => {
    handlers.onProgress((e as MessageEvent).data);
  });

  es.addEventListener("done", (e) => {
    es.close();
    try {
      handlers.onDone(JSON.parse((e as MessageEvent).data));
    } catch {
      handlers.onError("invalid result payload");
    }
  });

  // Note: the server's terminal "error" event carries data; native
  // EventSource connection errors fire the same event name without data.
  es.addEventListener("error", (e) => {
    const data = (e as MessageEvent).data as string | undefined;
    if (data !== undefined) {
      es.close();
      try {
        const parsed = JSON.parse(data) as { error?: string };
        handlers.onError(parsed.error ?? "analysis failed");
      } catch {
        handlers.onError("analysis failed");
      }
    } else if (es.readyState === EventSource.CLOSED) {
      handlers.onError("lost connection to analysis job");
    }
    // Otherwise EventSource is reconnecting; the replay will catch us up.
  });

  return () => es.close();
}

export async function cancelSemanticJob(jobId: string): Promise<void> {
  try {
    await fetch(`/api/semantic/jobs/${jobId}`, { method: "DELETE" });
  } catch {}
}
