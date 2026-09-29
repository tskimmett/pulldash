import { test, expect } from "bun:test";
import {
  analysisPromptFits,
  buildMapPrompt,
  buildReducePrompt,
  parseFragments,
  partitionFilesForMap,
  buildAnalysisPrompt,
  buildCorrectionPrompt,
  extractJson,
  isElidedPatch,
} from "./prompt";
import type { AnalysisInput } from "./providers/types";

const INPUT: AnalysisInput = {
  owner: "coder",
  repo: "pulldash",
  number: 42,
  headSha: "abc123",
  title: "Add feature",
  body: "Does the thing.",
  files: [
    {
      filename: "src/a.ts",
      status: "modified",
      additions: 2,
      deletions: 0,
      patch: "@@ -1,2 +1,4 @@\n ctx\n+one\n+two\n ctx",
    },
    {
      filename: "bun.lock",
      status: "modified",
      additions: 100,
      deletions: 100,
      patch: "@@ -1 +1 @@\n-x\n+y",
    },
    { filename: "logo.png", status: "added", additions: 0, deletions: 0 },
  ],
};

test("prompt: includes PR metadata and real patches, elides lockfiles/binaries", () => {
  const prompt = buildAnalysisPrompt(INPUT);
  expect(prompt).toContain("coder/pulldash#42");
  expect(prompt).toContain("Add feature");
  expect(prompt).toContain("+one");
  // Lockfile patch elided but the file is still listed.
  expect(prompt).not.toContain("-x");
  expect(prompt).toContain("bun.lock");
  expect(prompt).toContain("logo.png");
  expect(prompt).toContain("Files listed without patches");
});

test("prompt: isElidedPatch matches lockfiles and generated files", () => {
  for (const f of [
    "bun.lock",
    "sub/dir/package-lock.json",
    "yarn.lock",
    "go.sum",
    "app.min.js",
    "styles.min.css",
    "bundle.js.map",
    "component.test.tsx.snap",
  ]) {
    expect(isElidedPatch(f), f).toBe(true);
  }
  for (const f of ["src/lock.ts", "gosum.go", "min.js.ts", "locker/file.ts"]) {
    expect(isElidedPatch(f), f).toBe(false);
  }
});

test("prompt: oversized diffs elide the largest patches first", () => {
  const big = {
    ...INPUT,
    files: [
      {
        filename: "small.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -1 +1,2 @@\n ctx\n+tiny",
      },
      {
        filename: "huge.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -1 +1,2 @@\n ctx\n+" + "x".repeat(700_000),
      },
    ],
  };
  const prompt = buildAnalysisPrompt(big);
  expect(prompt).toContain("+tiny");
  expect(prompt).not.toContain("x".repeat(1000));
  expect(prompt).toContain(
    "huge.ts (modified, +1/-0) [patch too large: elided]"
  );
});

test("prompt: custom maxChars budget elides patches sooner", () => {
  const input = {
    ...INPUT,
    files: [
      {
        filename: "a.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -1 +1,2 @@\n ctx\n+small-change",
      },
      {
        filename: "b.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -1 +1,2 @@\n ctx\n+" + "y".repeat(20_000),
      },
    ],
  };
  // Default budget keeps both patches; a tight budget drops the big one.
  expect(buildAnalysisPrompt(input)).toContain("y".repeat(1000));
  const tight = buildAnalysisPrompt(input, 10_000);
  expect(tight).toContain("+small-change");
  expect(tight).not.toContain("y".repeat(1000));
  expect(tight).toContain("b.ts (modified, +1/-0) [patch too large: elided]");
});

test("prompt: correction prompt embeds errors and previous output", () => {
  const prompt = buildCorrectionPrompt("ORIGINAL", "BAD OUTPUT", ["e1", "e2"]);
  expect(prompt).toContain("ORIGINAL");
  expect(prompt).toContain("BAD OUTPUT");
  expect(prompt).toContain("- e1");
});

test("extractJson: direct, fenced, and embedded JSON", () => {
  expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  expect(extractJson('Here you go:\n```json\n{"a":1}\n```\nDone.')).toEqual({
    a: 1,
  });
  expect(extractJson('Sure! {"a":{"b":2}} hope that helps')).toEqual({
    a: { b: 2 },
  });
  expect(() => extractJson("no json here")).toThrow();
});

test("map-reduce: partitionFilesForMap batches by patch size", () => {
  const mk = (name: string, len: number) => ({
    filename: name,
    status: "modified",
    additions: 1,
    deletions: 0,
    patch: "@@ -1 +1,2 @@\n ctx\n+" + "z".repeat(len),
  });
  const files = [
    mk("a.ts", 100),
    mk("b.ts", 100),
    mk("c.ts", 5000),
    mk("d.ts", 100),
  ];
  const batches = partitionFilesForMap(files, 1000);
  expect(batches.length).toBe(3);
  expect(batches[0]!.map((f) => f.filename)).toEqual(["a.ts", "b.ts"]);
  expect(batches[1]!.map((f) => f.filename)).toEqual(["c.ts"]);
  expect(batches[2]!.map((f) => f.filename)).toEqual(["d.ts"]);
  // Lockfiles and patchless files are excluded entirely.
  const withNoise = [
    ...files,
    {
      filename: "bun.lock",
      status: "modified",
      additions: 9,
      deletions: 9,
      patch: "x",
    },
    { filename: "img.png", status: "added", additions: 0, deletions: 0 },
  ];
  expect(partitionFilesForMap(withNoise, 1000).flat().length).toBe(4);
});

test("map-reduce: parseFragments sanitizes model output", () => {
  const valid = new Set(["a.ts", "b.ts"]);
  const raw = JSON.stringify({
    fragments: [
      {
        file: "a.ts",
        side: "new",
        startLine: 3,
        endLine: 10,
        label: "adds foo",
        summary: "why",
      },
      { file: "a.ts", side: "old", startLine: 5, endLine: 5 },
      {
        file: "unknown.ts",
        side: "new",
        startLine: 1,
        endLine: 2,
        label: "x",
        summary: "y",
      },
      {
        file: "b.ts",
        side: "new",
        startLine: 9,
        endLine: 2,
        label: "bad range",
        summary: "",
      },
      {
        file: "b.ts",
        side: "sideways",
        startLine: 1,
        endLine: 4,
        label: "l",
        summary: "s",
      },
    ],
  });
  const fragments = parseFragments(raw, valid);
  expect(fragments.length).toBe(3);
  expect(fragments[0]).toEqual({
    file: "a.ts",
    side: "new",
    startLine: 3,
    endLine: 10,
    label: "adds foo",
    summary: "why",
  });
  expect(fragments[1]!.label).toBe("change");
  expect(fragments[2]!.side).toBe("new");
  expect(parseFragments("no json", valid)).toEqual([]);
});

test("map-reduce: buildMapPrompt and buildReducePrompt carry the essentials", () => {
  const files = [
    {
      filename: "a.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: "@@ -1 +1,2 @@\n ctx\n+added",
    },
    { filename: "img.png", status: "added", additions: 0, deletions: 0 },
  ];
  const input = { ...INPUT, files };
  const mapPrompt = buildMapPrompt(input, [files[0]!], 2, 5);
  expect(mapPrompt).toContain("section 2 of 5");
  expect(mapPrompt).toContain("+added");
  expect(mapPrompt).toContain('"fragments"');

  const reducePrompt = buildReducePrompt(input, [
    {
      file: "a.ts",
      side: "new",
      startLine: 1,
      endLine: 2,
      label: "adds foo",
      summary: "because",
    },
  ]);
  expect(reducePrompt).toContain("a.ts L1-2 (side new) — adds foo: because");
  expect(reducePrompt).toContain("img.png (added, +0/-0) [patch not analyzed]");
  expect(reducePrompt).toContain('"cohorts"');
  expect(reducePrompt).not.toContain("+added");
});

test("map-reduce: analysisPromptFits detects oversized diffs", () => {
  expect(analysisPromptFits(INPUT, 600_000)).toBe(true);
  const big = {
    ...INPUT,
    files: [
      {
        filename: "huge.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "@@ -1 +1,2 @@\n ctx\n+" + "x".repeat(50_000),
      },
    ],
  };
  expect(analysisPromptFits(big, 10_000)).toBe(false);
});
