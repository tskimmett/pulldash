import { test, expect } from "bun:test";
import type {
  IssueComment,
  Review,
  ReviewThread,
  TimelineEvent,
} from "@/browser/contexts/github";
import {
  buildConversationEntries,
  navigableEntryIds,
  type ConversationFilter,
} from "./conversation-entries";

const comment = (id: number, login: string) =>
  ({ id, user: { login } }) as IssueComment;
const review = (id: number, login: string, body = "") =>
  ({ id, user: { login }, body, state: "COMMENTED" }) as Review;
const thread = (
  id: string,
  reviewId: number | null,
  authors: string[],
  isResolved = false
) =>
  ({
    id,
    isResolved,
    resolvedBy: null,
    pullRequestReview: reviewId ? { databaseId: reviewId, author: null } : null,
    comments: { nodes: authors.map((login) => ({ author: { login } })) },
  }) as ReviewThread;

const timeline = [
  { sha: "abc", author: { date: "2026-01-01" } },
  { event: "commented", id: 1 },
  { event: "reviewed", id: 10 },
  { event: "labeled" },
  { event: "commented", id: 2 },
  { event: "reviewed", id: 20 },
] as unknown as TimelineEvent[];

const data = {
  timeline,
  conversation: [comment(1, "me"), comment(2, "bob")],
  reviews: [review(10, "bob"), review(20, "me", "lgtm")],
  reviewThreads: [
    thread("T1", 10, ["bob"], true),
    thread("T2", 10, ["bob", "me"]),
    thread("T3", 10, ["bob"]),
    thread("T4", null, ["alice"]),
  ],
  merged: false,
  currentUser: "me",
};

const ids = (filter: ConversationFilter) =>
  navigableEntryIds(buildConversationEntries({ ...data, filter }));

test("conversation-entries: all keeps everything newest first, orphans on top", () => {
  const entries = buildConversationEntries(data);
  expect(entries.map((e) => e.type)).toEqual([
    "thread",
    "review",
    "comment",
    "event",
    "review",
    "comment",
    "commits",
  ]);
  expect(ids("all")).toEqual([
    "reviewthread-T4",
    "pullrequestreview-20",
    "issuecomment-2",
    "pullrequestreview-10",
    "reviewthread-T1",
    "reviewthread-T2",
    "reviewthread-T3",
    "issuecomment-1",
  ]);
});

test("conversation-entries: unresolved keeps only open threads under their review", () => {
  const entries = buildConversationEntries({ ...data, filter: "unresolved" });
  expect(entries.every((e) => e.type === "review" || e.type === "thread")).toBe(
    true
  );
  expect(ids("unresolved")).toEqual([
    "reviewthread-T4",
    "pullrequestreview-10",
    "reviewthread-T2",
    "reviewthread-T3",
  ]);
});

test("conversation-entries: mine keeps my comments, reviews, and threads I joined", () => {
  expect(ids("mine")).toEqual([
    "pullrequestreview-20",
    "pullrequestreview-10",
    "reviewthread-T2",
    "issuecomment-1",
  ]);
  expect(
    buildConversationEntries({ ...data, filter: "mine", currentUser: null })
  ).toEqual([]);
});
