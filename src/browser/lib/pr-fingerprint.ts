import type { PullRequest } from "@/api/types";
import type { CheckRun, CombinedStatus } from "@/browser/contexts/github";

export type CIState = "SUCCESS" | "FAILURE" | "PENDING" | null;

/** Cheap summary of a PR's current state, used to vet cached data. */
export interface PRFingerprint {
  updatedAt: string;
  headSha: string;
  baseSha: string;
  commits: number;
  comments: number;
  ciState: CIState;
}

export const PR_FINGERPRINT_QUERY = `
  query ($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        updatedAt
        headRefOid
        baseRefOid
        commits { totalCount }
        comments { totalCount }
        statusCheckRollup { state }
      }
    }
  }
`;

export interface PRFingerprintResponse {
  repository: {
    pullRequest: {
      updatedAt: string;
      headRefOid: string;
      baseRefOid: string;
      commits: { totalCount: number };
      comments: { totalCount: number };
      statusCheckRollup: {
        state: "EXPECTED" | "ERROR" | "FAILURE" | "PENDING" | "SUCCESS";
      } | null;
    } | null;
  };
}

export function parsePRFingerprint(
  data: PRFingerprintResponse
): PRFingerprint | null {
  const pr = data.repository.pullRequest;
  if (!pr) return null;
  const state = pr.statusCheckRollup?.state ?? null;
  return {
    updatedAt: pr.updatedAt,
    headSha: pr.headRefOid,
    baseSha: pr.baseRefOid,
    commits: pr.commits.totalCount,
    comments: pr.comments.totalCount,
    ciState:
      state === "EXPECTED" ? "PENDING" : state === "ERROR" ? "FAILURE" : state,
  };
}

/**
 * Whether a cached PR still describes the live one. Same head and base
 * commits mean the files and patches are identical; GitHub bumps updatedAt
 * on most other activity (comments, reviews, edits, labels).
 */
export function fingerprintMatchesPR(
  live: PRFingerprint,
  pr: PullRequest
): boolean {
  return (
    Date.parse(live.updatedAt) === Date.parse(pr.updated_at) &&
    live.headSha === pr.head.sha &&
    live.baseSha === pr.base.sha &&
    live.commits === pr.commits &&
    live.comments === pr.comments
  );
}

const FAILING_CONCLUSIONS = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
]);

/** Collapse REST check runs and statuses the way GitHub's rollup does. */
export function checksRollupState(checks: {
  checkRuns: CheckRun[];
  status: CombinedStatus;
}): CIState {
  const { checkRuns } = checks;
  const statuses = checks.status.statuses ?? [];
  if (checkRuns.length === 0 && statuses.length === 0) return null;
  if (
    checkRuns.some((run) => FAILING_CONCLUSIONS.has(run.conclusion ?? "")) ||
    statuses.some((s) => s.state === "failure" || s.state === "error")
  ) {
    return "FAILURE";
  }
  if (
    checkRuns.some((run) => run.status !== "completed") ||
    statuses.some((s) => s.state === "pending")
  ) {
    return "PENDING";
  }
  return "SUCCESS";
}
