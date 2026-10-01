import { expect, test } from "bun:test";
import { MemoryPersistentStore } from "./persistent-cache";
import { RequestCache, cacheKeyMatches } from "./request-cache";

test("cacheKeyMatches covers nested keys but not sibling PR numbers", () => {
  expect(cacheKeyMatches("pr:o/r/1", "pr:o/r/1")).toBe(true);
  expect(cacheKeyMatches("pr:o/r/1:files", "pr:o/r/1")).toBe(true);
  expect(cacheKeyMatches("workflow-runs:o/r/abc", "workflow-runs:o/r")).toBe(
    true
  );
  expect(cacheKeyMatches("pr:o/r/12", "pr:o/r/1")).toBe(false);
  expect(cacheKeyMatches("pr:o/r/10:files", "pr:o/r/1")).toBe(false);
});

test("peek returns durable entries with their original age", async () => {
  const persistent = new MemoryPersistentStore();
  persistent.set("pr:o/r/1", { data: { title: "old" }, timestamp: 1 });
  const cache = new RequestCache(persistent);

  expect(cache.get("pr:o/r/1")).toBeNull();
  expect(await cache.peek("pr:o/r/1")).toEqual({
    data: { title: "old" },
    timestamp: 1,
  });
  // Promoted to memory, but still too old to skip revalidation
  expect(cache.getStale("pr:o/r/1")).toEqual({
    data: { title: "old" },
    isStale: true,
  });
});

test("invalidate removes durable copies for the pattern only", async () => {
  const persistent = new MemoryPersistentStore();
  const cache = new RequestCache(persistent);
  cache.set("pr:o/r/1:comments", ["a"], true);
  cache.set("pr:o/r/12:comments", ["b"], true);

  cache.invalidate("pr:o/r/1");

  expect(await persistent.get("pr:o/r/1:comments")).toBeUndefined();
  expect(await cache.peek("pr:o/r/12:comments")).not.toBeNull();
});
