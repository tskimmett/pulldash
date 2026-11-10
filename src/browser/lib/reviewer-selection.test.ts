import { test, expect } from "bun:test";
import {
  buildReviewerOptions,
  diffReviewerSelection,
} from "./reviewer-selection";

const user = (login: string) => ({ login, avatar_url: `${login}.png` });

test("lists requested reviewers first, dedupes, and drops the author", () => {
  const options = buildReviewerOptions(
    [user("carol")],
    [user("alice"), user("author"), user("carol"), user("bob")],
    "author"
  );
  expect(options.map((o) => o.login)).toEqual(["carol", "alice", "bob"]);
});

test("diffs the selection into adds and removes", () => {
  expect(
    diffReviewerSelection(["alice", "bob"], ["bob", "carol", "dave"])
  ).toEqual({ add: ["carol", "dave"], remove: ["alice"] });
  expect(diffReviewerSelection(["alice"], ["alice"])).toEqual({
    add: [],
    remove: [],
  });
});
