/**
 * Pure helpers for "changes since your last review" - narrowing a PR diff to
 * the commits added after a chosen start commit.
 */

interface ReviewLike {
  user?: { login: string } | null;
  state?: string;
  commit_id?: string | null;
  submitted_at?: string | null;
}

interface CommitLike {
  sha: string;
}

/** A start commit for a narrowed diff, plus how it was chosen. */
export interface DiffRange {
  startSha: string;
  /** "review" = the viewer's last submitted review; "manual" = commit picker */
  source: "review" | "manual";
}

/**
 * The commit the viewer's most recent submitted review was made against.
 * Pending (unsubmitted) reviews are ignored; GitHub reports those as PENDING.
 */
export function findLastReviewedSha(
  reviews: ReviewLike[],
  login: string | null
): string | null {
  if (!login) return null;
  let best: ReviewLike | null = null;
  for (const review of reviews) {
    if (review.user?.login !== login) continue;
    if (review.state === "PENDING") continue;
    if (!review.commit_id) continue;
    if (
      !best ||
      (review.submitted_at ?? "").localeCompare(best.submitted_at ?? "") > 0
    ) {
      best = review;
    }
  }
  return best?.commit_id ?? null;
}

/**
 * Commits in `commits` (oldest first, as GitHub returns them) that come after
 * `startSha`. Returns null when `startSha` is not in the list, which means a
 * force-push rewrote history and the range is no longer meaningful.
 */
export function commitsAfter<T extends CommitLike>(
  commits: T[],
  startSha: string
): T[] | null {
  const idx = commits.findIndex((c) => c.sha === startSha);
  if (idx === -1) return null;
  return commits.slice(idx + 1);
}

/**
 * Whether a range starting at `startSha` can still be shown: the start
 * commit must exist in the PR and must not already be the head.
 */
export function isRangeAvailable(
  commits: CommitLike[],
  startSha: string,
  headSha: string
): boolean {
  if (startSha === headSha) return false;
  const after = commitsAfter(commits, startSha);
  return after !== null && after.length > 0;
}

/** Cache key prefix for diffs parsed against a narrowed range. */
export function rangeCacheKey(range: DiffRange | null, sha: string): string {
  return range ? `${range.startSha}:${sha}` : sha;
}
