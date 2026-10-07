import { expect, test } from "bun:test";
import { htmlLineWidth } from "./line-width";

test("htmlLineWidth counts visible characters, erring wide", () => {
  expect(htmlLineWidth('<span class="k">const</span> a = 1;')).toBe(12);
  expect(htmlLineWidth("a &lt;= b &amp;&amp; c&#39;")).toBe(12);
  expect(htmlLineWidth("\tx")).toBe(5);
  expect(htmlLineWidth("日本🙂")).toBe(6);
  expect(htmlLineWidth("")).toBe(0);
});
