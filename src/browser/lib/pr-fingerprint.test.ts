import { expect, test } from "bun:test";
import type { PullRequest } from "@/api/types";
import type { CheckRun, CombinedStatus } from "@/browser/contexts/github";
import {
  checksRollupState,
  fingerprintMatchesPR,
  parsePRFingerprint,
  type PRFingerprint,
} from "./pr-fingerprint";

const pr = {
  updated_at: "2026-09-30T18:52:23Z",
  head: { sha: "head" },
  base: { sha: "base" },
  commits: 3,
  comments: 1,
} as PullRequest;

const live: PRFingerprint = {
  updatedAt: "2026-09-30T18:52:23Z",
  headSha: "head",
  baseSha: "base",
  commits: 3,
  comments: 1,
  ciState: null,
};

test("fingerprintMatchesPR rejects any moved field", () => {
  expect(fingerprintMatchesPR(live, pr)).toBe(true);
  expect(
    fingerprintMatchesPR({ ...live, updatedAt: "2026-09-30T18:52:24Z" }, pr)
  ).toBe(false);
  expect(fingerprintMatchesPR({ ...live, headSha: "pushed" }, pr)).toBe(false);
  expect(fingerprintMatchesPR({ ...live, comments: 2 }, pr)).toBe(false);
});

test("parsePRFingerprint folds EXPECTED and ERROR into the REST states", () => {
  const parse = (state: "EXPECTED" | "ERROR" | "SUCCESS") =>
    parsePRFingerprint({
      repository: {
        pullRequest: {
          updatedAt: live.updatedAt,
          headRefOid: "head",
          baseRefOid: "base",
          commits: { totalCount: 3 },
          comments: { totalCount: 1 },
          statusCheckRollup: { state },
        },
      },
    })?.ciState;
  expect([parse("EXPECTED"), parse("ERROR"), parse("SUCCESS")]).toEqual([
    "PENDING",
    "FAILURE",
    "SUCCESS",
  ]);
});

test("checksRollupState ranks failure over pending over success", () => {
  const checks = (runs: Partial<CheckRun>[], states: string[] = []) => ({
    checkRuns: runs as CheckRun[],
    status: { statuses: states.map((state) => ({ state })) } as CombinedStatus,
  });
  expect(checksRollupState(checks([]))).toBeNull();
  expect(
    checksRollupState(checks([{ status: "completed", conclusion: "skipped" }]))
  ).toBe("SUCCESS");
  expect(
    checksRollupState(
      checks([{ status: "in_progress", conclusion: null }], ["success"])
    )
  ).toBe("PENDING");
  expect(
    checksRollupState(
      checks([{ status: "in_progress", conclusion: null }], ["error"])
    )
  ).toBe("FAILURE");
});
