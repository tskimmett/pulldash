/**
 * Semantic review data model.
 *
 * This is the contract between the analysis providers (Claude, Codex, ...)
 * and the browser UI. Providers emit JSON that must validate against this
 * schema before it is cached or rendered. See docs/semantic-review.md.
 */

export const SEMANTIC_REVIEW_VERSION = 1;

export interface SemanticRange {
  file: string;
  /** "old" only for ranges in pure deletions; otherwise "new". */
  side: "new" | "old";
  startLine: number;
  endLine: number;
  summary?: string;
}

export interface SemanticDiagram {
  kind: "sequence" | "state" | "er" | "flow";
  mermaid: string;
}

export interface SemanticLayer {
  id: string;
  title: string;
  /** Markdown. */
  summary: string;
  diagram?: SemanticDiagram;
  ranges: SemanticRange[];
}

export interface SemanticCohort {
  id: string;
  title: string;
  summary: string;
  layers: SemanticLayer[];
}

export interface SemanticReview {
  version: typeof SEMANTIC_REVIEW_VERSION;
  provider: string;
  headSha: string;
  /** ISO 8601. */
  generatedAt: string;
  /** Markdown, 2-5 sentences. */
  overview: string;
  cohorts: SemanticCohort[];
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  value?: SemanticReview;
}

const DIAGRAM_KINDS = new Set(["sequence", "state", "er", "flow"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

/**
 * Structurally validate provider output. Collects every error rather than
 * failing fast so the provider's self-correction round-trip gets a complete
 * picture of what to fix.
 */
export function validateSemanticReview(input: unknown): ValidationResult {
  const errors: string[] = [];

  if (!isRecord(input)) {
    return { ok: false, errors: ["root: expected an object"] };
  }

  if (input.version !== SEMANTIC_REVIEW_VERSION) {
    errors.push(`version: expected ${SEMANTIC_REVIEW_VERSION}`);
  }
  if (!isNonEmptyString(input.provider)) {
    errors.push("provider: expected non-empty string");
  }
  if (!isNonEmptyString(input.headSha)) {
    errors.push("headSha: expected non-empty string");
  }
  if (
    !isNonEmptyString(input.generatedAt) ||
    Number.isNaN(Date.parse(input.generatedAt))
  ) {
    errors.push("generatedAt: expected ISO 8601 timestamp");
  }
  if (!isNonEmptyString(input.overview)) {
    errors.push("overview: expected non-empty string");
  }

  if (!Array.isArray(input.cohorts) || input.cohorts.length === 0) {
    errors.push("cohorts: expected non-empty array");
  } else {
    const cohortIds = new Set<string>();
    input.cohorts.forEach((cohort, ci) => {
      const path = `cohorts[${ci}]`;
      if (!isRecord(cohort)) {
        errors.push(`${path}: expected an object`);
        return;
      }
      if (!isNonEmptyString(cohort.id)) {
        errors.push(`${path}.id: expected non-empty string`);
      } else if (cohortIds.has(cohort.id)) {
        errors.push(`${path}.id: duplicate id "${cohort.id}"`);
      } else {
        cohortIds.add(cohort.id);
      }
      if (!isNonEmptyString(cohort.title)) {
        errors.push(`${path}.title: expected non-empty string`);
      }
      if (!isNonEmptyString(cohort.summary)) {
        errors.push(`${path}.summary: expected non-empty string`);
      }
      if (!Array.isArray(cohort.layers) || cohort.layers.length === 0) {
        errors.push(`${path}.layers: expected non-empty array`);
        return;
      }
      const layerIds = new Set<string>();
      cohort.layers.forEach((layer, li) => {
        const lpath = `${path}.layers[${li}]`;
        if (!isRecord(layer)) {
          errors.push(`${lpath}: expected an object`);
          return;
        }
        if (!isNonEmptyString(layer.id)) {
          errors.push(`${lpath}.id: expected non-empty string`);
        } else if (layerIds.has(layer.id)) {
          errors.push(`${lpath}.id: duplicate id "${layer.id}"`);
        } else {
          layerIds.add(layer.id);
        }
        if (!isNonEmptyString(layer.title)) {
          errors.push(`${lpath}.title: expected non-empty string`);
        }
        if (!isNonEmptyString(layer.summary)) {
          errors.push(`${lpath}.summary: expected non-empty string`);
        }
        if (layer.diagram !== undefined) {
          if (!isRecord(layer.diagram)) {
            errors.push(`${lpath}.diagram: expected an object`);
          } else {
            if (!DIAGRAM_KINDS.has(layer.diagram.kind as string)) {
              errors.push(
                `${lpath}.diagram.kind: expected one of ${[...DIAGRAM_KINDS].join(", ")}`
              );
            }
            if (!isNonEmptyString(layer.diagram.mermaid)) {
              errors.push(
                `${lpath}.diagram.mermaid: expected non-empty string`
              );
            }
          }
        }
        if (!Array.isArray(layer.ranges) || layer.ranges.length === 0) {
          errors.push(`${lpath}.ranges: expected non-empty array`);
          return;
        }
        layer.ranges.forEach((range, ri) => {
          const rpath = `${lpath}.ranges[${ri}]`;
          if (!isRecord(range)) {
            errors.push(`${rpath}: expected an object`);
            return;
          }
          if (!isNonEmptyString(range.file)) {
            errors.push(`${rpath}.file: expected non-empty string`);
          }
          if (range.side !== "new" && range.side !== "old") {
            errors.push(`${rpath}.side: expected "new" or "old"`);
          }
          if (!isPositiveInt(range.startLine)) {
            errors.push(`${rpath}.startLine: expected positive integer`);
          }
          if (!isPositiveInt(range.endLine)) {
            errors.push(`${rpath}.endLine: expected positive integer`);
          }
          if (
            isPositiveInt(range.startLine) &&
            isPositiveInt(range.endLine) &&
            range.endLine < range.startLine
          ) {
            errors.push(`${rpath}: endLine < startLine`);
          }
          if (
            range.summary !== undefined &&
            typeof range.summary !== "string"
          ) {
            errors.push(`${rpath}.summary: expected string`);
          }
        });
      });
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, errors: [], value: input as unknown as SemanticReview };
}
