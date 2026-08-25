import { test, expect } from "bun:test";
import { parsePatchHunks } from "./patch";

const PATCH = `@@ -1,5 +1,6 @@
 import { a } from "./a";
+import { b } from "./b";
 
 export function main() {
-  return a();
+  return b(a());
 }
@@ -20,3 +21,2 @@ export function other() {
   const x = 1;
-  const y = 2;
-  return x + y;
+  return x;
`;

test("patch: parses hunk headers and line spans", () => {
  const hunks = parsePatchHunks(PATCH);
  expect(hunks.length).toBe(2);

  const [h1, h2] = hunks;
  expect(h1!.newStart).toBe(1);
  expect(h1!.newEnd).toBe(6);
  expect(h1!.oldStart).toBe(1);
  expect(h1!.oldEnd).toBe(5);
  // "+import b" lands on new line 2; "+return b(a())" on new line 5.
  expect(h1!.changedNew).toEqual({ start: 2, end: 5 });
  // "-return a();" is old line 4.
  expect(h1!.changedOld).toEqual({ start: 4, end: 4 });

  expect(h2!.newStart).toBe(21);
  expect(h2!.changedNew).toEqual({ start: 22, end: 22 });
  expect(h2!.changedOld).toEqual({ start: 21, end: 22 });
});

test("patch: deletion-only hunk has no new-side changes", () => {
  const patch = `@@ -10,3 +9,0 @@ context
-line one
-line two
-line three
`;
  const hunks = parsePatchHunks(patch);
  expect(hunks.length).toBe(1);
  expect(hunks[0]!.changedNew).toBeNull();
  expect(hunks[0]!.changedOld).toEqual({ start: 10, end: 12 });
});

test("patch: single-line hunk header without counts", () => {
  const patch = `@@ -1 +1 @@
-old
+new
`;
  const hunks = parsePatchHunks(patch);
  expect(hunks[0]!.newStart).toBe(1);
  expect(hunks[0]!.newEnd).toBe(1);
  expect(hunks[0]!.changedNew).toEqual({ start: 1, end: 1 });
});
