import { test, expect } from "bun:test";
import { reconcileCoverage, UNCOVERED_COHORT_ID } from "./coverage";
import type { SemanticReview } from "./schema";

const FILES = [
  {
    filename: "src/a.ts",
    patch: `@@ -1,4 +1,6 @@
 context
+added one
+added two
 context
 context
 context
@@ -30,3 +32,4 @@
 context
+added three
 context
 context
`,
  },
  {
    filename: "src/b.ts",
    patch: `@@ -5,3 +5,3 @@
 context
-old line
+new line
 context
`,
  },
  { filename: "image.png" }, // binary: no patch
];

function review(
  ranges: {
    file: string;
    side: "new" | "old";
    startLine: number;
    endLine: number;
  }[]
): SemanticReview {
  return {
    version: 1,
    provider: "test",
    headSha: "sha",
    generatedAt: "2026-08-25T00:00:00Z",
    overview: "o",
    cohorts: [
      {
        id: "c1",
        title: "t",
        summary: "s",
        layers: [{ id: "l1", title: "t", summary: "s", ranges }],
      },
    ],
  };
}

test("coverage: full coverage produces no synthetic cohort", () => {
  const result = reconcileCoverage(
    review([
      { file: "src/a.ts", side: "new", startLine: 2, endLine: 3 },
      { file: "src/a.ts", side: "new", startLine: 33, endLine: 33 },
      { file: "src/b.ts", side: "new", startLine: 6, endLine: 6 },
    ]),
    FILES
  );
  expect(result.uncoveredHunkCount).toBe(0);
  expect(
    result.review.cohorts.find((c) => c.id === UNCOVERED_COHORT_ID)
  ).toBeUndefined();
  expect(result.warnings.length).toBe(0);
});

test("coverage: uncovered hunks are swept into a synthetic cohort", () => {
  const result = reconcileCoverage(
    review([{ file: "src/a.ts", side: "new", startLine: 2, endLine: 3 }]),
    FILES
  );
  // Second hunk of a.ts and the hunk of b.ts are uncovered.
  expect(result.uncoveredHunkCount).toBe(2);
  const synthetic = result.review.cohorts.find(
    (c) => c.id === UNCOVERED_COHORT_ID
  );
  expect(synthetic).toBeDefined();
  const ranges = synthetic!.layers[0]!.ranges;
  expect(ranges).toEqual([
    { file: "src/a.ts", side: "new", startLine: 33, endLine: 33 },
    { file: "src/b.ts", side: "new", startLine: 6, endLine: 6 },
  ]);
});

test("coverage: bogus ranges are pruned with warnings", () => {
  const result = reconcileCoverage(
    review([
      { file: "src/a.ts", side: "new", startLine: 500, endLine: 510 },
      { file: "nonexistent.ts", side: "new", startLine: 1, endLine: 5 },
      { file: "src/a.ts", side: "new", startLine: 1, endLine: 40 },
    ]),
    FILES
  );
  expect(result.warnings.some((w) => w.includes("no hunk"))).toBe(true);
  expect(result.warnings.some((w) => w.includes("unknown or binary"))).toBe(
    true
  );
  // The wide range covers both a.ts hunks; only b.ts is uncovered.
  expect(result.uncoveredHunkCount).toBe(1);
  const c1 = result.review.cohorts.find((c) => c.id === "c1")!;
  expect(c1.layers[0]!.ranges.length).toBe(1);
});

test("coverage: deletion-only hunks anchor on the old side", () => {
  const files = [
    {
      filename: "gone.ts",
      patch: `@@ -3,3 +2,0 @@ ctx
-a
-b
-c
`,
    },
  ];
  const result = reconcileCoverage(review([]), files);
  const synthetic = result.review.cohorts.find(
    (c) => c.id === UNCOVERED_COHORT_ID
  )!;
  expect(synthetic.layers[0]!.ranges).toEqual([
    { file: "gone.ts", side: "old", startLine: 3, endLine: 5 },
  ]);
});

test("coverage: empty layers and cohorts are dropped after pruning", () => {
  const result = reconcileCoverage(
    review([{ file: "nonexistent.ts", side: "new", startLine: 1, endLine: 2 }]),
    FILES
  );
  expect(result.review.cohorts.find((c) => c.id === "c1")).toBeUndefined();
});
