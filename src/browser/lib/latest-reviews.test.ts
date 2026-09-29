import { test, expect } from "bun:test";
import type { Review } from "@/browser/contexts/github";
import { getLatestReviewsByUser } from "./latest-reviews";

function review(id: number, login: string, state: string, minute: number) {
  return {
    id,
    state,
    user: { login },
    submitted_at: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString(),
  } as Review;
}

test("keeps one review per user, preferring the latest decision", () => {
  const reviews = [
    review(1, "alice", "CHANGES_REQUESTED", 1),
    review(2, "bob", "APPROVED", 2),
    review(3, "alice", "APPROVED", 3),
    review(4, "alice", "COMMENTED", 4),
    review(5, "carol", "COMMENTED", 5),
    review(6, "dave", "APPROVED", 6),
    review(7, "dave", "DISMISSED", 7),
  ];

  expect(getLatestReviewsByUser(reviews).map((r) => r.id)).toEqual([3, 2, 5]);
});

test("omits users with a pending re-request", () => {
  const reviews = [
    review(1, "alice", "APPROVED", 1),
    review(2, "bob", "APPROVED", 2),
  ];

  expect(getLatestReviewsByUser(reviews, ["alice"]).map((r) => r.id)).toEqual([
    2,
  ]);
});
