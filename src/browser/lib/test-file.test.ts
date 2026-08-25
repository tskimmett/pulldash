import { test, expect } from "bun:test";
import { isTestFile, countTestFiles } from "./test-file";

test("test-file: matches common test naming conventions", () => {
  const testPaths = [
    "src/browser/lib/test-file.test.ts",
    "src/components/button.spec.tsx",
    "pkg/server/server_test.go",
    "src/__tests__/util.ts",
    "src/__mocks__/fs.ts",
    "src/__snapshots__/app.tsx.snap",
    "app/components/foo.test.js.snap",
    "testdata/golden.json",
    "test/integration/api.ts",
    "tests/unit/parse.py",
    "spec/models/user_spec.rb",
    "e2e/login.ts",
    "src/main/java/FooTest.java",
    "src/FooSpec.kt",
    "tests/test_parser.py",
    "test_utils.py",
    "conftest.py",
    "cypress/fixtures/user.json",
  ];
  for (const p of testPaths) {
    expect(isTestFile(p), p).toBe(true);
  }
});

test("test-file: does not match production code", () => {
  const prodPaths = [
    "src/browser/lib/test-file.ts", // implementation, not test
    "src/api/api.ts",
    "src/contest/rules.ts", // "contest" contains "test" as substring
    "src/latest/index.ts",
    "src/testing-library-wrapper.ts", // no recognized convention
    "docs/testing.md",
    "protest/march.ts",
    "src/attest.go",
    "testimony.py", // not test_*.py
    "src/spectrum.ts",
  ];
  for (const p of prodPaths) {
    expect(isTestFile(p), p).toBe(false);
  }
});

test("test-file: countTestFiles", () => {
  expect(
    countTestFiles(["a_test.go", "a.go", "b.test.ts", "docs/readme.md"])
  ).toBe(2);
});
