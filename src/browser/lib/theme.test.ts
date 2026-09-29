import { test, expect } from "bun:test";
import { isTheme, nextTheme, resolveTheme } from "./theme";

test("isTheme accepts only the three theme values", () => {
  expect(isTheme("light")).toBe(true);
  expect(isTheme("dark")).toBe(true);
  expect(isTheme("system")).toBe(true);
  expect(isTheme("Dark")).toBe(false);
  expect(isTheme(null)).toBe(false);
  expect(isTheme(undefined)).toBe(false);
  expect(isTheme("")).toBe(false);
});

test("nextTheme cycles light -> dark -> system -> light", () => {
  expect(nextTheme("light")).toBe("dark");
  expect(nextTheme("dark")).toBe("system");
  expect(nextTheme("system")).toBe("light");
});

test("resolveTheme passes explicit themes through unchanged", () => {
  expect(resolveTheme("light")).toBe("light");
  expect(resolveTheme("dark")).toBe("dark");
});
