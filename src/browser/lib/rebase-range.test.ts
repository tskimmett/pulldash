import { test, expect } from "bun:test";
import type { PullRequestFile } from "@/api/types";
import {
  COMPARE_FILE_LIMIT,
  merge3,
  rangeFromTrees,
  rebaseRangeFiles,
  rebasedPatch,
  treeChanges,
  type RebaseRangeInput,
} from "./rebase-range";

const lines = (...l: string[]) => l.map((x) => `${x}\n`).join("");

test("merge3 combines separate changes and keeps ours on conflicts", () => {
  const base = lines("a", "b", "c", "d", "e");
  // Separate and touching changes merge cleanly
  expect(
    merge3(base, lines("A", "b", "c", "d", "e"), lines("a", "B", "c", "d", "E"))
  ).toBe(lines("A", "B", "c", "d", "E"));
  // Same lines changed differently: ours wins
  expect(
    merge3(
      base,
      lines("a", "ours", "c", "d", "e"),
      lines("a", "theirs", "c", "d", "e")
    )
  ).toBe(lines("a", "ours", "c", "d", "e"));
  // Insertions at the same point collide; identical changes don't
  expect(
    merge3(
      base,
      lines("a", "x", "b", "c", "d", "e"),
      lines("a", "y", "b", "c", "d", "e")
    )
  ).toBe(lines("a", "x", "b", "c", "d", "e"));
  expect(
    merge3(base, lines("a", "c", "d", "e"), lines("a", "c", "d", "e"))
  ).toBe(lines("a", "c", "d", "e"));
  // Missing trailing newline survives
  expect(merge3("a\nb", "A\nb", "a\nB")).toBe("A\nB");
});

test("merge3 keeps both sides of a conflict when head did", () => {
  const base = lines("a", "z");
  const ours = lines("a", "x", "z");
  const theirs = lines("a", "y", "z");
  // Head kept both (main's first) and then added a line
  expect(merge3(base, ours, theirs, lines("a", "y", "x", "w", "z"))).toBe(
    lines("a", "y", "x", "z")
  );
  // Head dropped the reviewed line: the drop shows, main's line doesn't
  const dropped = rebasedPatch(base, ours, theirs, lines("a", "y", "z"));
  expect(dropped).toMatchObject({ identical: false });
  if (dropped.identical) return;
  expect(dropped.patch).toContain("-x");
  expect(dropped.patch).not.toContain("+y");
});

test("rebasedPatch reports identical results and skips binary files", () => {
  expect(rebasedPatch("a\n", "a\n", "b\n", "b\n")).toEqual({ identical: true });
  expect(rebasedPatch("\0", "x", "y", "z")).toMatchObject({ patch: undefined });
});

const file = (
  filename: string,
  extra: Partial<PullRequestFile> = {}
): PullRequestFile =>
  ({
    filename,
    status: "modified",
    sha: `sha-${filename}`,
    additions: 1,
    deletions: 1,
    changes: 2,
    patch: `@@ original ${filename}`,
    ...extra,
  }) as PullRequestFile;

function scenario() {
  const contents: Record<string, string> = {
    // PR edited line 1 before review, main edited line 5, then the PR
    // edited line 3 after merging main.
    "old:both.ts": lines("1", "2", "3", "4", "5"),
    "start:both.ts": lines("one", "2", "3", "4", "5"),
    "new:both.ts": lines("1", "2", "3", "4", "five"),
    "end:both.ts": lines("one", "2", "three", "4", "five"),
    // No PR work since review; only main's change arrived.
    "old:absorbed.ts": lines("a", "b"),
    "start:absorbed.ts": lines("A", "b"),
    "new:absorbed.ts": lines("a", "B"),
    "end:absorbed.ts": lines("A", "B"),
    // Identical at start and end: the merge threw away main's change.
    "old:reverted.ts": lines("x", "y"),
    "start:reverted.ts": lines("X", "y"),
    "new:reverted.ts": lines("x", "Y"),
    "end:reverted.ts": lines("X", "y"),
  };
  const fetched: string[] = [];
  const input: RebaseRangeInput = {
    rangeFiles: [
      file("main-only.ts"),
      file("pr-only.ts"),
      file("both.ts"),
      file("absorbed.ts"),
    ],
    prStartFiles: [file("both.ts"), file("absorbed.ts"), file("reverted.ts")],
    prEndFiles: [
      file("pr-only.ts"),
      file("both.ts"),
      file("absorbed.ts"),
      file("reverted.ts", { sha: "head-reverted" }),
    ],
    baseFiles: [
      file("main-only.ts"),
      file("both.ts"),
      file("absorbed.ts"),
      file("reverted.ts"),
    ],
    startSha: "start",
    endSha: "end",
    oldMergeBase: "old",
    newMergeBase: "new",
    getContent: async (path, ref) => {
      fetched.push(`${ref}:${path}`);
      return contents[`${ref}:${path}`] ?? "";
    },
    rebase: async (...args) => rebasedPatch(...args),
  };
  return { input, fetched };
}

test("rebaseRangeFiles leaves out changes merged from the base branch", async () => {
  const { input, fetched } = scenario();
  const result = await rebaseRangeFiles(input);

  expect(result.map((f) => f.filename)).toEqual([
    "pr-only.ts",
    "both.ts",
    "reverted.ts",
  ]);
  const [prOnly, both, reverted] = result;
  // Untouched by main: GitHub's patch is used as is, without fetching
  expect(prOnly.patch).toBe("@@ original pr-only.ts");
  expect(prOnly.rebased_base).toBeUndefined();
  expect(fetched.some((f) => /main-only|pr-only/.test(f))).toBe(false);

  expect(both.patch).toContain("-3\n+three");
  expect(both.patch).not.toContain("+five");
  expect(both).toMatchObject({ additions: 1, deletions: 1 });
  expect(both.rebased_base).toEqual({
    key: "start+new",
    content: lines("one", "2", "3", "4", "five"),
  });

  expect(reverted.patch).toContain("-Y\n+y");
  expect(reverted.sha).toBe("head-reverted");
});

test("rebaseRangeFiles compares content when file lists are truncated", async () => {
  const filler = Array.from({ length: COMPARE_FILE_LIMIT }, (_, i) =>
    file(`filler-${i}`)
  );

  // PR lists truncated: range files can't be ruled out without content
  // (main-only.ts is empty everywhere here, so it rebases away).
  const truncatedPR = scenario();
  const result = await rebaseRangeFiles({
    ...truncatedPR.input,
    rangeFiles: [file("main-only.ts"), file("both.ts")],
    prStartFiles: [...truncatedPR.input.prStartFiles, ...filler],
  });
  expect(result.map((f) => f.filename)).toEqual(["both.ts"]);
  expect(truncatedPR.fetched).toContain("start:main-only.ts");

  // Range and base lists truncated: PR files cut from the range still show,
  // and unrelated range files are dropped without fetching.
  const truncatedRange = scenario();
  const fromPR = await rebaseRangeFiles({
    ...truncatedRange.input,
    rangeFiles: filler,
    baseFiles: [...truncatedRange.input.baseFiles, ...filler],
  });
  expect(fromPR.map((f) => f.filename)).toEqual(["both.ts", "reverted.ts"]);
  expect(fromPR[0].patch).toContain("-3\n+three");
  expect(truncatedRange.fetched.some((f) => f.includes("filler"))).toBe(false);
});

test("rangeFromTrees diffs tree listings without the compare file limit", async () => {
  const tree = (entries: Record<string, string>) =>
    new Map(Object.entries(entries));
  // Blob oids; contents below. "keep.ts" is reused from the range compare.
  const oldBase = tree({ "main.ts": "m1", "both.ts": "b1", "moved.ts": "v" });
  const start = tree({
    "main.ts": "m1",
    "both.ts": "b2",
    "keep.ts": "k1",
    "img.png": "p1",
    "moved.ts": "v",
  });
  const newBase = tree({ "main.ts": "m2", "both.ts": "b3", "moved.ts": "v" });
  const end = tree({
    "main.ts": "m2",
    "both.ts": "b4",
    "keep.ts": "k2",
    "img.png": "p2",
    "new/moved.ts": "v",
  });
  const changes = treeChanges(oldBase, start, newBase, end);
  expect(changes.map((c) => c.path).sort()).toEqual([
    "both.ts",
    "img.png",
    "keep.ts",
    "moved.ts",
    "new/moved.ts",
  ]);

  const contents: Record<string, string | null> = {
    b1: lines("1", "2", "3"),
    b2: lines("one", "2", "3"),
    b3: lines("1", "2", "three"),
    b4: lines("one", "two", "three"),
    p1: null,
    p2: null,
  };
  const requested: string[] = [];
  const result = await rangeFromTrees({
    changes,
    rangeFiles: [file("keep.ts", { sha: "k2", patch: "@@ keep" })],
    startSha: "start",
    endSha: "end",
    oldMergeBase: "old",
    newMergeBase: "new",
    getBlobs: async (requests) => {
      requested.push(...requests.map((r) => r.oid));
      return new Map(
        requests.map((r) => [r.oid, r.oid in contents ? contents[r.oid] : ""])
      );
    },
    rebase: async (...args) => rebasedPatch(...args),
  });
  const byName = new Map(result.map((f) => [f.filename, f]));

  expect([...byName.keys()].sort()).toEqual([
    "both.ts",
    "img.png",
    "keep.ts",
    "new/moved.ts",
  ]);
  expect(byName.get("keep.ts")?.patch).toBe("@@ keep");
  expect(requested).not.toContain("k1");
  expect(byName.get("both.ts")?.patch).toContain("-2\n+two");
  expect(byName.get("both.ts")?.patch).not.toContain("+three");
  expect(byName.get("img.png")).toMatchObject({ status: "modified" });
  expect(byName.get("img.png")?.patch).toBeUndefined();
  expect(byName.get("new/moved.ts")).toMatchObject({
    status: "renamed",
    previous_filename: "moved.ts",
  });
});
