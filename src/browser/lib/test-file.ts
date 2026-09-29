/**
 * Heuristic classification of test/spec files by path.
 *
 * Used by the "hide test files" toggle to reduce cognitive load when
 * reviewing large PRs. Intentionally conservative: only well-known test
 * naming conventions match, so production code is never hidden.
 */

// Directory names that indicate everything inside is test-related.
const TEST_DIRS = new Set([
  "__tests__",
  "__mocks__",
  "__snapshots__",
  "testdata",
  "test",
  "tests",
  "spec",
  "specs",
  "e2e",
  "fixtures",
]);

// Filename patterns for test files across common ecosystems.
const TEST_FILE_RE =
  /(\.(test|spec|unit)\.[^./]+|_test\.[^./]+|Test\.(java|kt|cs|scala|groovy)|Spec\.(java|kt|cs|scala|groovy)|\.snap)$/;

// Python convention: test_*.py
const PYTHON_TEST_RE = /^test_[^/]*\.py$/;

// conftest.py is pytest plumbing.
const PYTEST_CONFTEST = "conftest.py";

export function isTestFile(path: string): boolean {
  const segments = path.split("/");
  const basename = segments[segments.length - 1]!;

  for (let i = 0; i < segments.length - 1; i++) {
    // Case-insensitive: C#/Java projects use `Tests/`, `Test/`, etc.
    const segment = segments[i]!.toLowerCase();
    if (TEST_DIRS.has(segment)) return true;
    // .NET test-project folders: `MyProject.Tests/`, `MyProject.UnitTests/`.
    if (/\.[a-z0-9]*tests?$/.test(segment)) return true;
  }

  return (
    TEST_FILE_RE.test(basename) ||
    PYTHON_TEST_RE.test(basename) ||
    basename === PYTEST_CONFTEST
  );
}

/** Count how many of the given filenames are test files. */
export function countTestFiles(filenames: readonly string[]): number {
  let count = 0;
  for (const f of filenames) {
    if (isTestFile(f)) count++;
  }
  return count;
}
