import { test, expect } from "bun:test";
import {
  ALL_REPOS_KEY,
  buildSearchScopeQueries,
  type FilterConfig,
} from "./feed-filters";

test("feed-filters: search scope drops mode for specific repos but keeps All Repos filters", () => {
  const config: FilterConfig = {
    state: "open",
    repos: [
      { name: "a/b", mode: "review-requested" },
      { name: "c/d", mode: "authored" },
      { name: "a/b", mode: "reviewed" },
      { name: "off/repo", mode: "authored", enabled: false },
      { name: ALL_REPOS_KEY, mode: "involves" },
    ],
  };
  expect(buildSearchScopeQueries(config)).toEqual([
    "is:pr archived:false is:open involves:@me",
    "is:pr archived:false is:open repo:a/b repo:c/d",
  ]);
  expect(buildSearchScopeQueries({ state: "all", repos: [] })).toEqual([]);
});
