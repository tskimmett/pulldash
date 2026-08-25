/**
 * Prompt construction and output extraction for semantic review analysis.
 * Pure functions - shared by all providers and unit-testable.
 */

import type { AnalysisInput } from "./providers/types";
import { SEMANTIC_REVIEW_VERSION } from "./schema";

/** Files whose patch bodies are noise; listed by name only. */
const ELIDED_PATCH_RE =
  /(^|\/)(package-lock\.json|bun\.lock|bun\.lockb|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock|poetry\.lock|uv\.lock)$|\.(min\.js|min\.css|map|snap)$/;

/** Rough ceiling on prompt size; ~4 chars/token, aim under ~150k tokens. */
const MAX_PROMPT_CHARS = 600_000;

export function isElidedPatch(filename: string): boolean {
  return ELIDED_PATCH_RE.test(filename);
}

export function buildAnalysisPrompt(input: AnalysisInput): string {
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
  if (header.length + body.length > MAX_PROMPT_CHARS) {
    const sorted = input.files
      .filter((f) => f.patch && !isElidedPatch(f.filename))
      .sort((a, b) => (b.patch?.length ?? 0) - (a.patch?.length ?? 0));
    const dropped = new Set<string>();
    let size = header.length + body.length;
    for (const file of sorted) {
      if (size <= MAX_PROMPT_CHARS) break;
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
