import { test, expect } from "bun:test";
import {
  commitsAfter,
  findLastReviewedSha,
  isRangeAvailable,
  rangeCacheKey,
} from "./review-range";

const commits = [{ sha: "a" }, { sha: "b" }, { sha: "c" }, { sha: "d" }];

test("findLastReviewedSha picks the viewer's latest submitted review", () => {
  const reviews = [
    {
      user: { login: "me" },
      state: "COMMENTED",
      commit_id: "a",
      submitted_at: "2026-01-01T00:00:00Z",
    },
    {
      user: { login: "other" },
      state: "APPROVED",
      commit_id: "c",
      submitted_at: "2026-01-03T00:00:00Z",
    },
    {
      user: { login: "me" },
      state: "CHANGES_REQUESTED",
      commit_id: "b",
      submitted_at: "2026-01-02T00:00:00Z",
    },
    {
      user: { login: "me" },
      state: "PENDING",
      commit_id: "d",
      submitted_at: null,
    },
  ];
  expect(findLastReviewedSha(reviews, "me")).toBe("b");
  expect(findLastReviewedSha(reviews, "nobody")).toBeNull();
  expect(findLastReviewedSha(reviews, null)).toBeNull();
});

test("commitsAfter returns following commits or null when start is gone", () => {
  expect(commitsAfter(commits, "b")?.map((c) => c.sha)).toEqual(["c", "d"]);
  expect(commitsAfter(commits, "d")).toEqual([]);
  expect(commitsAfter(commits, "zzz")).toBeNull();
});

test("isRangeAvailable requires a known start with newer commits", () => {
  expect(isRangeAvailable(commits, "b", "d")).toBe(true);
  expect(isRangeAvailable(commits, "d", "d")).toBe(false);
  expect(isRangeAvailable(commits, "zzz", "d")).toBe(false);
});

test("rangeCacheKey separates full and ranged diffs of the same blob", () => {
  expect(rangeCacheKey(null, "blob")).toBe("blob");
  expect(rangeCacheKey({ startSha: "b", source: "manual" }, "blob")).toBe(
    "b:blob"
  );
});
