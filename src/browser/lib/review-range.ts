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
  parents?: { sha: string }[];
}

/** A start commit for a narrowed diff, plus how it was chosen. */
export interface DiffRange {
  startSha: string;
  /** Last commit included in the diff. Omitted for ranges through the PR head. */
  endSha?: string;
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
 * Index of the commit a range starts after. The first commit's parent maps to
 * -1 so ranges can include the first commit. Null when the start is unknown.
 */
function startIndex(commits: CommitLike[], startSha: string): number | null {
  const idx = commits.findIndex((c) => c.sha === startSha);
  if (idx !== -1) return idx;
  return commits[0]?.parents?.[0]?.sha === startSha ? -1 : null;
}

/** Commits after the start, through the end (inclusive), in PR order. */
export function commitsInRange<T extends CommitLike>(
  commits: T[],
  startSha: string,
  endSha: string
): T[] | null {
  const start = startIndex(commits, startSha);
  const end = commits.findIndex((c) => c.sha === endSha);
  if (start === null || end <= start) return null;
  return commits.slice(start + 1, end + 1);
}

/**
 * Inclusive commit indexes covered by a range, for highlighting the picker.
 * Null when the range no longer matches the commit list.
 */
export function rangeToSelection(
  commits: CommitLike[],
  range: Pick<DiffRange, "startSha" | "endSha">
): [number, number] | null {
  const start = startIndex(commits, range.startSha);
  const end = range.endSha
    ? commits.findIndex((c) => c.sha === range.endSha)
    : commits.length - 1;
  if (start === null || end <= start) return null;
  return [start + 1, end];
}

/**
 * The diff range showing commits `from` through `to` (inclusive indexes).
 * Returns null for the whole PR, and undefined when the first commit's parent
 * is unknown so the selection can't be expressed as a compare.
 */
export function selectionToRange(
  commits: CommitLike[],
  from: number,
  to: number
): Pick<DiffRange, "startSha" | "endSha"> | null | undefined {
  const last = commits.length - 1;
  if (from <= 0 && to >= last) return null;
  const startSha =
    from > 0 ? commits[from - 1]?.sha : commits[0]?.parents?.[0]?.sha;
  const endSha = commits[to]?.sha;
  if (!startSha || !endSha || to < from) return undefined;
  return to === last ? { startSha } : { startSha, endSha };
}

/**
 * Whether both commits still belong to the PR in chronological order.
 */
export function isRangeAvailable(
  commits: CommitLike[],
  startSha: string,
  endSha: string
): boolean {
  return commitsInRange(commits, startSha, endSha) !== null;
}

/** Cache key prefix for diffs parsed against a narrowed range. */
export function rangeCacheKey(range: DiffRange | null, sha: string): string {
  return range ? `${range.startSha}:${range.endSha ?? "head"}:${sha}` : sha;
}
