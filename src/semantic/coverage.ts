/**
 * Coverage invariant enforcement for semantic reviews.
 *
 * Every hunk in the PR diff must be reachable from at least one layer range,
 * or the reviewer can't trust semantic mode to show the whole PR. Provider
 * output is reconciled against the actual diff here:
 *
 *  - ranges that match no real hunk are pruned (with a warning)
 *  - hunks no surviving range covers are collected into a synthetic
 *    "Uncovered changes" cohort appended to the review
 */

import type { SemanticCohort, SemanticRange, SemanticReview } from "./schema";
import { parsePatchHunks, type PatchHunk } from "./patch";

export interface DiffFileInput {
  filename: string;
  /** Unified patch from the GitHub files API. Absent for binary files. */
  patch?: string;
}

export interface CoverageResult {
  review: SemanticReview;
  warnings: string[];
  /** Number of hunks that had to be swept into the synthetic cohort. */
  uncoveredHunkCount: number;
}

export const UNCOVERED_COHORT_ID = "__uncovered__";

function overlaps(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): boolean {
  return aStart <= bEnd && bStart <= aEnd;
}

/** Whether a range touches the given hunk (full hunk spans, context included). */
function rangeHitsHunk(range: SemanticRange, hunk: PatchHunk): boolean {
  if (range.side === "new") {
    return overlaps(range.startLine, range.endLine, hunk.newStart, hunk.newEnd);
  }
  return overlaps(range.startLine, range.endLine, hunk.oldStart, hunk.oldEnd);
}

export function reconcileCoverage(
  review: SemanticReview,
  files: DiffFileInput[]
): CoverageResult {
  const warnings: string[] = [];
  const hunksByFile = new Map<string, PatchHunk[]>();
  for (const file of files) {
    if (file.patch) {
      hunksByFile.set(file.filename, parsePatchHunks(file.patch));
    }
  }

  const coveredHunks = new Map<string, Set<number>>();
  const markCovered = (file: string, hunkIndex: number) => {
    let set = coveredHunks.get(file);
    if (!set) {
      set = new Set();
      coveredHunks.set(file, set);
    }
    set.add(hunkIndex);
  };

  // Prune ranges that don't match any hunk; record what each range covers.
  const cohorts: SemanticCohort[] = review.cohorts
    .filter((c) => c.id !== UNCOVERED_COHORT_ID)
    .map((cohort) => ({
      ...cohort,
      layers: cohort.layers
        .map((layer) => ({
          ...layer,
          ranges: layer.ranges.filter((range) => {
            const hunks = hunksByFile.get(range.file);
            if (!hunks) {
              warnings.push(
                `pruned range for unknown or binary file: ${range.file}:${range.startLine}-${range.endLine}`
              );
              return false;
            }
            let hit = false;
            for (const hunk of hunks) {
              if (rangeHitsHunk(range, hunk)) {
                markCovered(range.file, hunk.index);
                hit = true;
              }
            }
            if (!hit) {
              warnings.push(
                `pruned range matching no hunk: ${range.file}:${range.startLine}-${range.endLine} (${range.side})`
              );
            }
            return hit;
          }),
        }))
        .filter((layer) => layer.ranges.length > 0),
    }))
    .filter((cohort) => cohort.layers.length > 0);

  if (cohorts.length < review.cohorts.length) {
    warnings.push("dropped cohorts/layers left empty after range pruning");
  }

  // Collect uncovered hunks into a synthetic cohort.
  const uncoveredRanges: SemanticRange[] = [];
  for (const file of files) {
    const hunks = hunksByFile.get(file.filename);
    if (!hunks) continue;
    const covered = coveredHunks.get(file.filename);
    for (const hunk of hunks) {
      if (covered?.has(hunk.index)) continue;
      // Anchor to the changed lines; fall back to the hunk span. Deletion-only
      // hunks anchor on the old side since they have no new-side lines.
      if (hunk.changedNew) {
        uncoveredRanges.push({
          file: file.filename,
          side: "new",
          startLine: hunk.changedNew.start,
          endLine: hunk.changedNew.end,
        });
      } else if (hunk.changedOld) {
        uncoveredRanges.push({
          file: file.filename,
          side: "old",
          startLine: hunk.changedOld.start,
          endLine: hunk.changedOld.end,
        });
      }
    }
  }

  if (uncoveredRanges.length > 0) {
    cohorts.push({
      id: UNCOVERED_COHORT_ID,
      title: "Uncovered changes",
      summary:
        "Changes the analysis did not assign to any cohort. Review these to ensure full coverage of the PR.",
      layers: [
        {
          id: `${UNCOVERED_COHORT_ID}-layer`,
          title: "Unassigned hunks",
          summary:
            "Hunks not covered by any range in the semantic analysis output.",
          ranges: uncoveredRanges,
        },
      ],
    });
    warnings.push(
      `${uncoveredRanges.length} hunk(s) were not covered by the analysis`
    );
  }

  return {
    review: { ...review, cohorts },
    warnings,
    uncoveredHunkCount: uncoveredRanges.length,
  };
}
