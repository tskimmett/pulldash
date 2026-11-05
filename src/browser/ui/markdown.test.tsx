import { expect, test } from "bun:test";
import { collectPreviewImages } from "./markdown";

test("collectPreviewImages returns nested images in document order", () => {
  const first = {
    type: "element" as const,
    tag: "img",
    attributes: { src: "a.png", alt: "A" },
  };
  const noSrc = { type: "element" as const, tag: "img", attributes: {} };
  const second = {
    type: "element" as const,
    tag: "img",
    attributes: { src: "b.png" },
  };
  const { images, indexByNode } = collectPreviewImages([
    {
      type: "element",
      tag: "p",
      children: [{ type: "text", content: "hi" }, first],
    },
    noSrc,
    {
      type: "element",
      tag: "a",
      children: [{ type: "element", tag: "p", children: [second] }],
    },
  ]);
  expect(images).toEqual([
    { src: "a.png", alt: "A" },
    { src: "b.png", alt: undefined },
  ]);
  expect(indexByNode.get(first)).toBe(0);
  expect(indexByNode.get(second)).toBe(1);
  expect(indexByNode.has(noSrc)).toBe(false);
});
