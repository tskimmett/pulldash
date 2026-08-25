import { test, expect } from "bun:test";
import {
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
