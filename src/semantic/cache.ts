/**
 * Disk cache for semantic reviews, keyed by (owner, repo, number, headSha).
 * Entries are immutable per SHA; historical revisions accumulate naturally.
 * Node-only; import lazily from API routes.
 */

import { mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import type { SemanticReview } from "./schema";

function cacheDir(owner: string, repo: string, number: number): string {
  const base =
    process.env.PULLDASH_SEMANTIC_CACHE_DIR ??
    join(homedir(), ".pulldash", "semantic");
  // owner/repo are path-unsafe as-is; keep them readable but flat.
  const key = `${owner}--${repo}--${number}`.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(base, key);
}

function entryPath(
  owner: string,
  repo: string,
  number: number,
  headSha: string
): string {
  const sha = headSha.replace(/[^a-zA-Z0-9]/g, "");
  return join(cacheDir(owner, repo, number), `${sha}.json`);
}

export async function readCachedReview(
  owner: string,
  repo: string,
  number: number,
  headSha: string
): Promise<SemanticReview | null> {
  try {
    const raw = await readFile(
      entryPath(owner, repo, number, headSha),
      "utf-8"
    );
    return JSON.parse(raw) as SemanticReview;
  } catch {
    return null;
  }
}

export async function writeCachedReview(
  owner: string,
  repo: string,
  number: number,
  review: SemanticReview
): Promise<void> {
  const dir = cacheDir(owner, repo, number);
  await mkdir(dir, { recursive: true });
  await writeFile(
    entryPath(owner, repo, number, review.headSha),
    JSON.stringify(review, null, 2)
  );
}

/** Keep the raw provider output next to the cache entry for debugging. */
export async function writeRawOutput(
  owner: string,
  repo: string,
  number: number,
  headSha: string,
  raw: string
): Promise<void> {
  try {
    const dir = cacheDir(owner, repo, number);
    await mkdir(dir, { recursive: true });
    const sha = headSha.replace(/[^a-zA-Z0-9]/g, "");
    await writeFile(join(dir, `${sha}.raw.txt`), raw);
  } catch {
    // Debug artifact only - never fail the job over it.
  }
}
