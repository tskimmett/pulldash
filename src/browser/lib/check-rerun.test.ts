import { expect, test } from "bun:test";
import type { CheckRun } from "../contexts/github";
import { hasCheckRestarted, rerunTarget } from "./check-rerun";

test("rerunTarget re-runs Actions jobs directly and rerequests other apps", () => {
  const check = (slug: string | null) =>
    ({ id: 7, app: slug ? { slug } : null }) as unknown as CheckRun;
  expect(rerunTarget(check("github-actions"))).toEqual({
    kind: "actions-job",
    jobId: 7,
  });
  expect(rerunTarget(check("azure-pipelines"))).toEqual({
    kind: "rerequest",
    checkRunId: 7,
  });
  expect(rerunTarget(check(null))).toEqual({
    kind: "rerequest",
    checkRunId: 7,
  });
});

test("hasCheckRestarted detects reset, replaced and unchanged runs", () => {
  const before = { id: 1, name: "build", completed_at: "t1" };
  const run = (o: object) =>
    ({
      id: 1,
      name: "build",
      status: "completed",
      completed_at: "t1",
      ...o,
    }) as Parameters<typeof hasCheckRestarted>[1][number];
  expect(hasCheckRestarted(before, [run({})])).toBe(false);
  expect(hasCheckRestarted(before, [run({ status: "queued" })])).toBe(true);
  expect(hasCheckRestarted(before, [run({ id: 2 })])).toBe(true);
  expect(hasCheckRestarted(before, [run({ name: "other", id: 2 })])).toBe(
    false
  );
});
