import { test, expect } from "bun:test";
import { hasRequiredScopes } from "./auth";

test("hasRequiredScopes: classic tokens need full repo, fine-grained pass", () => {
  expect(hasRequiredScopes("ghp_x", "read:user, repo")).toBe(true);
  expect(hasRequiredScopes("ghp_x", "public_repo, read:user")).toBe(false);
  expect(hasRequiredScopes("ghp_x", null)).toBe(false);
  expect(hasRequiredScopes("github_pat_x", null)).toBe(true);
});
