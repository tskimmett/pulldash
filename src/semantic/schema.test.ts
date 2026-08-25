import { test, expect } from "bun:test";
import { validateSemanticReview } from "./schema";

function validReview() {
  return {
    version: 1,
    provider: "claude",
    headSha: "abc123",
    generatedAt: "2026-08-25T12:00:00Z",
    overview: "Adds a thing.",
    cohorts: [
      {
        id: "c1",
        title: "The thing",
        summary: "Adds the thing end to end.",
        layers: [
          {
            id: "l1",
            title: "Contract",
            summary: "New types.",
            ranges: [
              { file: "src/a.ts", side: "new", startLine: 1, endLine: 10 },
            ],
          },
        ],
      },
    ],
  };
}

test("schema: accepts a valid review", () => {
  const result = validateSemanticReview(validReview());
  expect(result.ok).toBe(true);
  expect(result.value?.cohorts.length).toBe(1);
});

test("schema: accepts optional diagram and range summary", () => {
  const review = validReview();
  review.cohorts[0]!.layers[0]! = {
    ...review.cohorts[0]!.layers[0]!,
    diagram: { kind: "sequence", mermaid: "sequenceDiagram\n A->>B: hi" },
    ranges: [
      {
        file: "src/a.ts",
        side: "new",
        startLine: 1,
        endLine: 10,
        summary: "the range",
      },
    ],
  } as never;
  expect(validateSemanticReview(review).ok).toBe(true);
});

test("schema: collects all errors", () => {
  const result = validateSemanticReview({
    version: 2,
    provider: "",
    headSha: "abc",
    generatedAt: "not-a-date",
    overview: "x",
    cohorts: [
      {
        id: "c1",
        title: "t",
        summary: "s",
        layers: [
          {
            id: "l1",
            title: "t",
            summary: "s",
            diagram: { kind: "pie", mermaid: "" },
            ranges: [
              { file: "f", side: "left", startLine: 0, endLine: -1 },
              { file: "f", side: "new", startLine: 5, endLine: 2 },
            ],
          },
        ],
      },
    ],
  });
  expect(result.ok).toBe(false);
  expect(result.errors).toContain("version: expected 1");
  expect(result.errors).toContain("provider: expected non-empty string");
  expect(result.errors).toContain("generatedAt: expected ISO 8601 timestamp");
  expect(result.errors.some((e) => e.includes("diagram.kind"))).toBe(true);
  expect(result.errors.some((e) => e.includes("side"))).toBe(true);
  expect(result.errors.some((e) => e.includes("endLine < startLine"))).toBe(
    true
  );
});

test("schema: rejects duplicate ids and empty collections", () => {
  const review = validReview() as Record<string, unknown>;
  (review.cohorts as unknown[]).push(structuredClone(validReview().cohorts[0]));
  const result = validateSemanticReview(review);
  expect(result.ok).toBe(false);
  expect(result.errors.some((e) => e.includes('duplicate id "c1"'))).toBe(true);

  expect(validateSemanticReview({ ...validReview(), cohorts: [] }).ok).toBe(
    false
  );
  expect(validateSemanticReview(null).ok).toBe(false);
});
