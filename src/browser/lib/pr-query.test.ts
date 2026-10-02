import { test, expect } from "bun:test";
import {
  buildTextSearchQueries,
  extractRepoFromUrl,
  mergeSearchResults,
  parsePRQuery,
} from "./pr-query";
import type { PRSearchResult } from "../contexts/github";

test("pr-query: parses URLs and shorthand, otherwise treats input as text", () => {
  const expected = {
    kind: "pr" as const,
    owner: "acme",
    repo: "web",
    number: 12,
  };
  expect(parsePRQuery("https://github.com/acme/web/pull/12/files")).toEqual(
    expected
  );
  expect(parsePRQuery(" acme/web#12 ")).toEqual(expected);
  expect(parsePRQuery("acme/web/pull/12")).toEqual(expected);
  expect(parsePRQuery("login bug")).toEqual({
    kind: "text",
    text: "login bug",
  });
  expect(parsePRQuery("#12")).toEqual({ kind: "text", text: "#12" });
});

test("pr-query: text is appended to every feed query, never searched alone", () => {
  const feed = ["is:pr repo:a/b", "is:pr review-requested:@me"];
  expect(buildTextSearchQueries(feed, " fix ")).toEqual([
    "is:pr repo:a/b in:title,body fix",
    "is:pr review-requested:@me in:title,body fix",
  ]);
  expect(buildTextSearchQueries(feed, "  ")).toEqual([]);
  expect(buildTextSearchQueries([], "fix")).toEqual([]);
});

test("pr-query: merge dedupes, sorts newest first and limits", () => {
  const pr = (id: number, updated_at: string) =>
    ({ id, updated_at }) as PRSearchResult;
  const merged = mergeSearchResults(
    [
      [pr(1, "2024-01-01"), pr(2, "2024-03-01")],
      [pr(2, "2024-03-01"), pr(3, "2024-02-01")],
    ],
    2
  );
  expect(merged.map((p) => p.id)).toEqual([2, 3]);
});

test("pr-query: extracts repo from API url", () => {
  expect(extractRepoFromUrl("https://api.github.com/repos/a/b")).toEqual({
    owner: "a",
    repo: "b",
  });
  expect(extractRepoFromUrl("nope")).toBeNull();
});
