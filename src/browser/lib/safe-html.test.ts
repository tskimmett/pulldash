import { test, expect } from "bun:test";
import { isAllowedHtmlAttribute, isAllowedHtmlTag } from "./safe-html";

test("safe-html: blocks executable tags, keeps content tags", () => {
  for (const tag of ["script", "SCRIPT", "iframe", "object", "foreignObject"]) {
    expect(isAllowedHtmlTag(tag)).toBe(false);
  }
  for (const tag of ["p", "a", "img", "code", "svg", "details"]) {
    expect(isAllowedHtmlTag(tag)).toBe(true);
  }
});

test("safe-html: blocks event handlers and script URLs", () => {
  expect(isAllowedHtmlAttribute("onerror", "x")).toBe(false);
  expect(isAllowedHtmlAttribute("href", "javascript:alert(1)")).toBe(false);
  expect(isAllowedHtmlAttribute("href", " java\tscript:alert(1)")).toBe(false);
  expect(isAllowedHtmlAttribute("src", "data:text/html,x")).toBe(false);
  expect(isAllowedHtmlAttribute("srcset", "a.png 1x, javascript:x 2x")).toBe(
    false
  );

  expect(isAllowedHtmlAttribute("href", "https://github.com/a")).toBe(true);
  expect(isAllowedHtmlAttribute("href", "#heading")).toBe(true);
  expect(isAllowedHtmlAttribute("href", "/owner/repo")).toBe(true);
  expect(isAllowedHtmlAttribute("href", "mailto:a@b.c")).toBe(true);
  expect(isAllowedHtmlAttribute("src", "image.png")).toBe(true);
  expect(isAllowedHtmlAttribute("class", "javascript:")).toBe(true);
});
