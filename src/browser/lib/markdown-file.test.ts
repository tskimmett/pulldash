import { test, expect } from "bun:test";
import { isMarkdownFile } from "./markdown-file";

test("isMarkdownFile matches markdown extensions only", () => {
  for (const path of ["README.md", "docs/Guide.MD", "notes.markdown"]) {
    expect(isMarkdownFile(path)).toBe(true);
  }
  for (const path of ["src/app.mdx", "md", "readme.md.txt", "a.tsx"]) {
    expect(isMarkdownFile(path)).toBe(false);
  }
});
