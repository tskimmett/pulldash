import { test, expect } from "bun:test";
import type { ReviewComment } from "@/api/types";
import type { ReviewThread } from "@/browser/contexts/github";
import { enrichCommentsWithThreads } from "./review-threads";

function comment(
  id: number,
  extra: Partial<ReviewComment> = {}
): ReviewComment {
  return { id, body: `c${id}`, ...extra } as ReviewComment;
}

function thread(
  id: string,
  commentIds: number[],
  isResolved: boolean,
  resolvedBy: ReviewThread["resolvedBy"] = null
): ReviewThread {
  return {
    id,
    isResolved,
    resolvedBy,
    pullRequestReview: null,
    comments: {
      nodes: commentIds.map((databaseId) => ({ databaseId })),
    } as ReviewThread["comments"],
  };
}

test("review-threads: stamps thread id and resolved state onto every comment in the thread", () => {
  const out = enrichCommentsWithThreads(
    [comment(1), comment(2), comment(3)],
    [
      thread("T1", [1, 2], true, { login: "kyle", avatarUrl: "https://a/k" }),
      thread("T2", [3], false),
    ]
  );
  expect(out[0]).toMatchObject({
    pull_request_review_thread_id: "T1",
    is_resolved: true,
    resolved_by: { login: "kyle", avatar_url: "https://a/k" },
  });
  expect(out[1]).toMatchObject({
    pull_request_review_thread_id: "T1",
    is_resolved: true,
  });
  expect(out[2]).toMatchObject({
    pull_request_review_thread_id: "T2",
    is_resolved: false,
    resolved_by: null,
  });
});

test("review-threads: leaves comments alone when no thread matches", () => {
  const already = comment(9, {
    pull_request_review_thread_id: "T9",
    is_resolved: true,
  });
  const out = enrichCommentsWithThreads(
    [already, comment(10)],
    [thread("T1", [1], true)]
  );
  expect(out[0]).toBe(already);
  expect(out[1].pull_request_review_thread_id).toBeUndefined();
  expect(out[1].is_resolved).toBeUndefined();
});

test("review-threads: empty thread list returns input unchanged", () => {
  const input = [comment(1, { is_resolved: true })];
  expect(enrichCommentsWithThreads(input, [])).toBe(input);
});
