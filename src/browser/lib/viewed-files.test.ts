import { test, expect } from "bun:test";
import type { PullRequestFile } from "@/api/types";
import { deriveViewed, parseViewedRecords, recordView } from "./viewed-files";

const file = (sha: string, patch?: string) =>
  ({ filename: "a.ts", sha, patch }) as PullRequestFile;

test("deriveViewed keeps a file viewed only while its blob or patch matches", () => {
  const records = {
    "a.ts": recordView(file("s1", "+x"), "h1"),
    "gone.ts": recordView(undefined, "h1"),
  };

  const same = deriveViewed(records, [file("s1", "+x")]);
  expect([...same.viewedFiles].sort()).toEqual(["a.ts", "gone.ts"]);

  // Rebuilt or rebased: one fingerprint still matches
  expect(deriveViewed(records, [file("s1")]).viewedFiles.has("a.ts")).toBe(
    true
  );
  expect(
    deriveViewed(records, [file("s2", "+x")]).viewedFiles.has("a.ts")
  ).toBe(true);

  const changed = deriveViewed(records, [file("s2", "+y")]);
  expect(changed.viewedFiles.has("a.ts")).toBe(false);
  expect(changed.changedSinceViewed.get("a.ts")).toBe("h1");
});

test("parseViewedRecords reads legacy arrays and ignores garbage", () => {
  const legacy = parseViewedRecords(JSON.stringify(["a.ts"]));
  expect(legacy).toEqual({ "a.ts": {} });
  expect(deriveViewed(legacy, [file("s9", "+z")]).viewedFiles.has("a.ts")).toBe(
    true
  );
  expect(parseViewedRecords("not json")).toEqual({});
  expect(parseViewedRecords(null)).toEqual({});
});
