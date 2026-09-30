import { expect, test } from "bun:test";
import type { PullRequestFile } from "@/api/types";
import { generatePatch, recoverPatches } from "./recover-patches";
import { parsePatchLines } from "./patch-lines";

function file(overrides: Partial<PullRequestFile> = {}): PullRequestFile {
  return {
    sha: "blob",
    filename: "file.cs",
    status: "modified",
    additions: 1,
    deletions: 1,
    changes: 2,
    blob_url: "",
    raw_url: "",
    contents_url: "",
    ...overrides,
  };
}

test("generates a complete large text patch and leaves binary and unchanged files unavailable", () => {
  const before = Array.from({ length: 2000 }, (_, i) => `old ${i}`).join("\n");
  const after = Array.from({ length: 2000 }, (_, i) => `new ${i}`).join("\n");
  const lines = parsePatchLines(generatePatch(before, after)!);
  expect(lines.filter((line) => line.type === "delete")).toHaveLength(2000);
  expect(lines.filter((line) => line.type === "insert")).toHaveLength(2000);
  expect(generatePatch("binary\0old", "binary\0new")).toBeUndefined();
  expect(generatePatch("same", "same")).toBeUndefined();
});

test("recovers missing patches at exact refs, including renames, additions and deletions", async () => {
  const files = [
    file({ patch: "existing" }),
    file({
      filename: "renamed.cs",
      previous_filename: "old.cs",
      status: "renamed",
    }),
    file({ filename: "added.cs", status: "added" }),
    file({ filename: "deleted.cs", status: "removed" }),
    file({ filename: "failed.cs" }),
    file({ filename: "mode.cs", changes: 0 }),
  ];
  const requests: string[] = [];
  const result = await recoverPatches(
    files,
    "range-start",
    "range-end",
    async (path, ref) => {
      requests.push(`${ref}:${path}`);
      if (path === "failed.cs") throw new Error("unavailable");
      return ref === "range-start" ? "old\n" : "new\n";
    },
    async (oldContent, newContent) => generatePatch(oldContent, newContent)
  );
  expect(requests.sort()).toEqual(
    [
      "range-start:old.cs",
      "range-end:renamed.cs",
      "range-end:added.cs",
      "range-start:deleted.cs",
      "range-start:failed.cs",
      "range-end:failed.cs",
    ].sort()
  );
  expect(result[0]).toBe(files[0]);
  expect(
    result.slice(1, 4).every((entry) => entry.patch?.startsWith("@@ "))
  ).toBe(true);
  expect(result[4]).toBe(files[4]);
  expect(result[5]).toBe(files[5]);
  expect(files[1].patch).toBeUndefined();
});
