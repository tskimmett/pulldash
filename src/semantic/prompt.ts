/**
 * Prompt construction and output extraction for semantic review analysis.
 * Pure functions - shared by all providers and unit-testable.
 */

import type { AnalysisInput, AnalysisFile } from "./providers/types";
import { SEMANTIC_REVIEW_VERSION } from "./schema";

/** Files whose patch bodies are noise; listed by name only. */
const ELIDED_PATCH_RE =
  /(^|\/)(package-lock\.json|bun\.lock|bun\.lockb|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock|poetry\.lock|uv\.lock)$|\.(min\.js|min\.css|map|snap)$/;

/**
 * Default ceiling on prompt size in characters. Providers with smaller
 * context windows override this via `promptBudgetChars`.
 */
export const DEFAULT_MAX_PROMPT_CHARS = 600_000;

export function isElidedPatch(filename: string): boolean {
  return ELIDED_PATCH_RE.test(filename);
}

export function buildAnalysisPrompt(
  input: AnalysisInput,
  maxChars: number = DEFAULT_MAX_PROMPT_CHARS
): string {
  const header = `You are analyzing a pull request to produce a "semantic review": a reorganization of the diff from a flat file list into a guided, dependency-ordered walkthrough.

PR: ${input.owner}/${input.repo}#${input.number} (head ${input.headSha})
Title: ${input.title}

Description:
${input.body ? input.body.trim() : "(no description)"}

## Your task

Partition ALL hunks of the diff below into cohorts and layers:

1. **Cohorts**: 2-7 independent, logically related groups of changes, named by intent (e.g. "Auth token refresh", "Config plumbing"). Grouping is hunk-level: one file's hunks may belong to different cohorts.
2. **Layers**: within each cohort, an ordered reading sequence. Foundational changes first (types, data shapes, contracts), then consumers/call sites, then tests. Each layer anchors to exact line ranges in the diff.
3. **Coverage**: every hunk must be covered by at least one layer range. Do not skip anything.
4. **Summaries**: explain WHY the change exists in plain language; never restate the diff mechanically.
5. **Diagrams**: attach a Mermaid diagram to a layer ONLY when it introduces an API interaction, state machine, or schema relationship where a visual genuinely helps. Most layers should have none.

## Line-range rules

- Ranges use NEW-side line numbers (the file after the change), i.e. the line numbers implied by the "+" side of each hunk header.
- Only for hunks that purely delete lines (no added lines), use side "old" with OLD-side line numbers.
- A range must intersect actual changed lines; do not invent ranges outside the hunks shown.

## Output

Output ONLY a JSON object (no prose, no code fences) matching:

{
  "version": ${SEMANTIC_REVIEW_VERSION},
  "provider": "<your provider id, given below>",
  "headSha": "${input.headSha}",
  "generatedAt": "<ISO 8601 timestamp>",
  "overview": "<2-5 sentence markdown overview of the whole PR>",
  "cohorts": [
    {
      "id": "<kebab-case unique id>",
      "title": "<short title>",
      "summary": "<1-3 sentences>",
      "layers": [
        {
          "id": "<kebab-case unique id>",
          "title": "<short title>",
          "summary": "<markdown, explains why>",
          "diagram": { "kind": "sequence|state|er|flow", "mermaid": "<mermaid source>" },
          "ranges": [
            { "file": "<path>", "side": "new", "startLine": 1, "endLine": 10, "summary": "<optional>" }
          ]
        }
      ]
    }
  ]
}

The "diagram" field is optional. The "summary" field on ranges is optional.

## The diff

`;

  const sections: string[] = [];
  let elided: string[] = [];
  for (const file of input.files) {
    const label = `${file.filename} (${file.status}, +${file.additions}/-${file.deletions})`;
    if (!file.patch) {
      elided.push(`${label} [binary or too large: no patch]`);
    } else if (isElidedPatch(file.filename)) {
      elided.push(`${label} [generated/lockfile: patch elided]`);
    } else {
      sections.push(`### ${label}\n${file.patch}`);
    }
  }

  let body = sections.join("\n\n");

  // Stay under the prompt ceiling: elide the largest patches first.
  if (header.length + body.length > maxChars) {
    const sorted = input.files
      .filter((f) => f.patch && !isElidedPatch(f.filename))
      .sort((a, b) => (b.patch?.length ?? 0) - (a.patch?.length ?? 0));
    const dropped = new Set<string>();
    let size = header.length + body.length;
    for (const file of sorted) {
      if (size <= maxChars) break;
      dropped.add(file.filename);
      size -= file.patch!.length;
    }
    body = input.files
      .filter((f) => f.patch && !isElidedPatch(f.filename))
      .map((f) =>
        dropped.has(f.filename)
          ? null
          : `### ${f.filename} (${f.status}, +${f.additions}/-${f.deletions})\n${f.patch}`
      )
      .filter(Boolean)
      .join("\n\n");
    for (const name of dropped) {
      const f = input.files.find((x) => x.filename === name)!;
      elided.push(
        `${f.filename} (${f.status}, +${f.additions}/-${f.deletions}) [patch too large: elided]`
      );
    }
  }

  const elidedSection =
    elided.length > 0
      ? `\n\n### Files listed without patches\n${elided.map((e) => `- ${e}`).join("\n")}\nAssign each of these to a sensible cohort with a range of 1-1 on side "new" if changed lines are unknown.\n`
      : "";

  return header + body + elidedSection;
}

// ============================================================================
// Map-reduce path for PRs too large for a single prompt
// ============================================================================

/**
 * A semantic fragment identified during the map phase: a coherent slice of
 * the diff with enough summary for the reduce phase to organize it without
 * re-reading the patch.
 */
export interface DiffFragment {
  file: string;
  side: "new" | "old";
  startLine: number;
  endLine: number;
  label: string;
  summary: string;
}

/** True when the full single-shot prompt would exceed the budget. */
export function analysisPromptFits(
  input: AnalysisInput,
  maxChars: number
): boolean {
  return buildAnalysisPrompt(input, Number.MAX_SAFE_INTEGER).length <= maxChars;
}

/**
 * Greedily partition analyzable files into batches whose combined patch size
 * stays under `maxChars`. A single file larger than the budget gets its own
 * batch (its patch is truncated at prompt-build time).
 */
export function partitionFilesForMap(
  files: AnalysisFile[],
  maxChars: number
): AnalysisFile[][] {
  const analyzable = files.filter((f) => f.patch && !isElidedPatch(f.filename));
  const batches: AnalysisFile[][] = [];
  let current: AnalysisFile[] = [];
  let size = 0;
  for (const file of analyzable) {
    const len = file.patch!.length;
    if (current.length > 0 && size + len > maxChars) {
      batches.push(current);
      current = [];
      size = 0;
    }
    current.push(file);
    size += len;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** Map-phase prompt: annotate one batch of files with semantic fragments. */
export function buildMapPrompt(
  input: AnalysisInput,
  batch: AnalysisFile[],
  batchIndex: number,
  batchCount: number,
  maxChars: number = DEFAULT_MAX_PROMPT_CHARS
): string {
  const header = `You are analyzing section ${batchIndex} of ${batchCount} of a large pull request diff. Other sections are analyzed separately; a final pass will organize all sections into a review guide.

PR: ${input.owner}/${input.repo}#${input.number}
Title: ${input.title}

Description:
${input.body ? input.body.trim() : "(no description)"}

## Your task

Split the hunks below into coherent semantic fragments. A fragment is a contiguous range of changed lines serving one purpose (a type change, a new function, a call-site update, a test). Prefer fewer, larger fragments over line-by-line slicing.

## Line-range rules

- Ranges use NEW-side line numbers (side "new"), i.e. the line numbers implied by the "+" side of each hunk header.
- Only for hunks that purely delete lines (no added lines), use side "old" with OLD-side line numbers.
- Every hunk must be covered by at least one fragment. Do not skip anything.

## Output

Output ONLY a JSON object (no prose, no code fences) matching:

{
  "fragments": [
    { "file": "<path>", "side": "new", "startLine": 1, "endLine": 10, "label": "<3-8 word label>", "summary": "<1-3 sentences: what changed and why it matters>" }
  ]
}

## The diff section

`;

  const sections = batch.map((file) => {
    const label = `${file.filename} (${file.status}, +${file.additions}/-${file.deletions})`;
    let patch = file.patch!;
    const room = maxChars - header.length;
    if (patch.length > room) {
      patch = `${patch.slice(0, Math.max(0, room))}\n[... patch truncated ...]`;
    }
    return `### ${label}\n${patch}`;
  });

  return header + sections.join("\n\n");
}

/**
 * Reduce-phase prompt: organize fragments from all map batches into the
 * final cohort/layer structure. Reuses the single-shot output contract but
 * feeds fragment annotations instead of raw patches.
 */
export function buildReducePrompt(
  input: AnalysisInput,
  fragments: DiffFragment[]
): string {
  const elided = input.files
    .filter((f) => !f.patch || isElidedPatch(f.filename))
    .map(
      (f) =>
        `- ${f.filename} (${f.status}, +${f.additions}/-${f.deletions}) [patch not analyzed]`
    );

  const fragmentLines = fragments.map(
    (f) =>
      `- ${f.file} L${f.startLine}-${f.endLine} (side ${f.side}) — ${f.label}: ${f.summary}`
  );

  return `You are producing a "semantic review" of a pull request: a reorganization of its diff from a flat file list into a guided, dependency-ordered walkthrough. The diff was too large to show directly; instead you get semantic fragments extracted from it by prior analysis passes.

PR: ${input.owner}/${input.repo}#${input.number} (head ${input.headSha})
Title: ${input.title}

Description:
${input.body ? input.body.trim() : "(no description)"}

## Your task

Organize ALL fragments below into cohorts and layers:

1. **Cohorts**: 2-7 independent, logically related groups of changes, named by intent (e.g. "Auth token refresh", "Config plumbing").
2. **Layers**: within each cohort, an ordered reading sequence. Foundational changes first (types, data shapes, contracts), then consumers/call sites, then tests.
3. **Coverage**: every fragment must appear in exactly the ranges of some layer. Copy each fragment's file, side, startLine, and endLine verbatim into a layer's ranges; you may put multiple fragments in one layer but never alter or invent ranges.
4. **Summaries**: explain WHY the changes exist in plain language, synthesizing the fragment summaries.
5. **Diagrams**: attach a Mermaid diagram to a layer ONLY when it introduces an API interaction, state machine, or schema relationship where a visual genuinely helps. Most layers should have none.

## Output

Output ONLY a JSON object (no prose, no code fences) matching:

{
  "version": ${SEMANTIC_REVIEW_VERSION},
  "provider": "<your provider id, given below>",
  "headSha": "${input.headSha}",
  "generatedAt": "<ISO 8601 timestamp>",
  "overview": "<2-5 sentence markdown overview of the whole PR>",
  "cohorts": [
    {
      "id": "<kebab-case unique id>",
      "title": "<short title>",
      "summary": "<1-3 sentences>",
      "layers": [
        {
          "id": "<kebab-case unique id>",
          "title": "<short title>",
          "summary": "<markdown, explains why>",
          "diagram": { "kind": "sequence|state|er|flow", "mermaid": "<mermaid source>" },
          "ranges": [
            { "file": "<path>", "side": "new", "startLine": 1, "endLine": 10, "summary": "<optional>" }
          ]
        }
      ]
    }
  ]
}

The "diagram" field is optional. The "summary" field on ranges is optional.

## The fragments

${fragmentLines.join("\n")}
${
  elided.length > 0
    ? `\n## Files without analyzed patches\n${elided.join("\n")}\nAssign each of these to a sensible cohort with a range of 1-1 on side "new".\n`
    : ""
}`;
}

/** Parse and sanitize map-phase output; invalid entries are dropped. */
export function parseFragments(
  raw: string,
  validFiles: Set<string>
): DiffFragment[] {
  let parsed: unknown;
  try {
    parsed = extractJson(raw);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { fragments?: unknown[] })?.fragments)
      ? (parsed as { fragments: unknown[] }).fragments
      : [];

  const fragments: DiffFragment[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const f = entry as Record<string, unknown>;
    if (typeof f.file !== "string" || !validFiles.has(f.file)) continue;
    const startLine = Number(f.startLine);
    const endLine = Number(f.endLine);
    if (!Number.isInteger(startLine) || !Number.isInteger(endLine)) continue;
    if (startLine < 1 || endLine < startLine) continue;
    fragments.push({
      file: f.file,
      side: f.side === "old" ? "old" : "new",
      startLine,
      endLine,
      label: typeof f.label === "string" ? f.label : "change",
      summary: typeof f.summary === "string" ? f.summary : "",
    });
  }
  return fragments;
}

/**
 * Build the self-correction prompt sent back to a provider whose output
 * failed validation.
 */
export function buildCorrectionPrompt(
  originalPrompt: string,
  previousOutput: string,
  errors: string[]
): string {
  return `${originalPrompt}

## Correction required

Your previous output failed validation. Errors:
${errors.map((e) => `- ${e}`).join("\n")}

Previous output:
${previousOutput}

Output ONLY the corrected JSON object.`;
}

/**
 * Extract a JSON object from agent output that may be wrapped in prose or
 * code fences.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();

  // Direct parse first.
  try {
    return JSON.parse(trimmed);
  } catch {}

  // Fenced block.
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(trimmed);
  if (fence) {
    try {
      return JSON.parse(fence[1]!);
    } catch {}
  }

  // First "{" to last "}".
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {}
  }

  throw new Error("no parseable JSON object found in provider output");
}
