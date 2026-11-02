import type { CheckRun } from "../contexts/github";

export type RerunTarget =
  | { kind: "actions-job"; jobId: number }
  | { kind: "rerequest"; checkRunId: number };

/**
 * GitHub Actions job ids equal their check run ids, and only the Actions API
 * can re-run one; every other provider (Azure Pipelines, CircleCI, ...) is
 * asked to re-run through the check-run rerequest webhook.
 */
export function rerunTarget(check: Pick<CheckRun, "id" | "app">): RerunTarget {
  return check.app?.slug === "github-actions"
    ? { kind: "actions-job", jobId: check.id }
    : { kind: "rerequest", checkRunId: check.id };
}

/**
 * Whether a re-run has taken effect. Rerequested checks reset in place, while
 * a re-run Actions job replaces the old check run under the same name.
 */
export function hasCheckRestarted(
  before: Pick<CheckRun, "id" | "name" | "completed_at">,
  current: Pick<CheckRun, "id" | "name" | "status" | "completed_at">[]
): boolean {
  const latest = current.filter((c) => c.name === before.name);
  if (latest.length === 0) return false;
  return latest.some(
    (c) =>
      c.id !== before.id ||
      c.status !== "completed" ||
      c.completed_at !== before.completed_at
  );
}

/** Stable key for expanding a check run or commit status row. */
export const checkRunKey = (id: number) => `run:${id}`;
export const commitStatusKey = (context: string) => `status:${context}`;
