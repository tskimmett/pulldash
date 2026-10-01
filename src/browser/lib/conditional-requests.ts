import type { Octokit } from "@octokit/core";
import type { PersistentStore } from "./persistent-cache";

interface StoredResponse {
  etag: string;
  status: number;
  url: string;
  data: unknown;
}

const ETAG_PREFIX = "etag:";

export function hasStatus(error: unknown, status: number): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "status" in error &&
    error.status === status
  );
}

/**
 * Revalidate GETs with the ETag from the last response. GitHub answers an
 * unchanged resource with an empty 304 that doesn't count against the rate
 * limit, and we replay the stored body.
 */
export function addConditionalRequests(
  octokitInstance: Octokit,
  persistent: PersistentStore
) {
  octokitInstance.hook.wrap("request", async (request, options) => {
    if (options.method !== "GET") return request(options);
    const { url } = octokitInstance.request.endpoint.parse(options);
    // File contents are fetched by commit SHA and cached separately.
    if (url.includes("/contents/")) return request(options);

    const key = `${ETAG_PREFIX}${url} ${options.headers.accept ?? ""}`;
    const stored = (await persistent.get<StoredResponse>(key))?.data;
    if (stored) {
      options.headers = { ...options.headers, "if-none-match": stored.etag };
    }
    // GitHub marks responses `private, max-age=60`, so the browser would
    // otherwise answer from its own cache for a minute, even right after we
    // changed something. Revalidation above replaces that cache.
    const baseFetch: typeof fetch = options.request?.fetch ?? fetch;
    options.request = {
      ...options.request,
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        baseFetch(input, { ...init, cache: "no-store" }),
    };

    try {
      const response = await request(options);
      const etag = response.headers.etag;
      if (etag) {
        persistent.set(key, {
          data: {
            etag,
            status: response.status,
            url: response.url,
            data: response.data,
          } satisfies StoredResponse,
          timestamp: Date.now(),
        });
      }
      return response;
    } catch (error) {
      if (stored && hasStatus(error, 304)) {
        return {
          status: stored.status,
          url: stored.url,
          headers: { etag: stored.etag },
          data: stored.data,
        };
      }
      throw error;
    }
  });
}
