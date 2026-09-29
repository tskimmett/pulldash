import { expect, test } from "bun:test";
import { layerFilesInOrder } from "./layer-files";
import type { SemanticLayer } from "./schema";

const layer: SemanticLayer = {
  id: "l",
  title: "t",
  summary: "s",
  ranges: [
    { file: "src/utils.ts", side: "new", startLine: 1, endLine: 2 },
    { file: "src/index.ts", side: "new", startLine: 5, endLine: 6 },
    { file: "src/utils.ts", side: "new", startLine: 9, endLine: 9 },
    { file: "src/missing.ts", side: "new", startLine: 1, endLine: 1 },
  ],
};

test("layerFilesInOrder groups ranges by first-visit order and drops absent files", () => {
  const entries = layerFilesInOrder(
    layer,
    new Set(["src/utils.ts", "src/index.ts"])
  );

  expect(entries.map((e) => e.file)).toEqual(["src/utils.ts", "src/index.ts"]);
  expect(entries[0].ranges.map((r) => r.startLine)).toEqual([1, 9]);
  expect(entries[1].ranges).toHaveLength(1);
});
