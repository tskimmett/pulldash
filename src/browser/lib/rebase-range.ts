/**
 * Keep base-branch merges out of "changes since commit X" diffs.
 *
 * A plain compare of X...head includes everything a merge of the base branch
 * brought in. Instead, each file's content at X gets the base branch's changes
 * replayed onto it (a 3-way merge, as if X were rebased onto the new merge
 * base), and that is diffed against head. What remains is only work done on
 * the PR, including how merge conflicts were resolved.
 */
import type { PullRequestFile } from "@/api/types";
import { diffArrays } from "diff";
import { generatePatch } from "./recover-patches";

/**
 * A file in a narrowed range. `rebased_base` is set when the old side of the
 * patch is the start commit with base-branch changes replayed, so it exists in
 * no commit; `key` identifies that content for caching parsed diffs.
 */
export type RangeFile = PullRequestFile & {
  rebased_base?: { key: string; content: string };
};

/** GitHub's compare endpoint lists at most this many files. */
export const COMPARE_FILE_LIMIT = 300;

function splitLines(content: string): string[] {
  return content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

interface Change {
  start: number;
  end: number;
  lines: string[];
  side: "ours" | "theirs";
}

/** Changed base-line ranges between `base` and `other`, with their new lines. */
function changes(
  base: string[],
  other: string[],
  side: Change["side"]
): Change[] {
  const parts = diffArrays(base, other, { timeout: 5000 });
  if (!parts) throw new Error("Merging the file exceeded the work limit");
  const result: Change[] = [];
  let pos = 0;
  let current: Change | null = null;
  for (const part of parts) {
    if (!part.added && !part.removed) {
      if (current) result.push(current);
      current = null;
      pos += part.count;
      continue;
    }
    current ??= { start: pos, end: pos, lines: [], side };
    if (part.removed) {
      pos += part.count;
      current.end = pos;
    } else {
      current.lines.push(...part.value);
    }
  }
  if (current) result.push(current);
  return result;
}

/** Apply one side's changes in a group to base lines [start, end). */
function applySide(
  base: string[],
  group: Change[],
  side: Change["side"],
  start: number,
  end: number
): string[] {
  const out: string[] = [];
  let pos = start;
  for (const change of group) {
    if (change.side !== side) continue;
    out.push(...base.slice(pos, change.start), ...change.lines);
    pos = change.end;
  }
  out.push(...base.slice(pos, end));
  return out;
}

/** Most conflicts per file worth resolving against head; beyond, ours wins. */
const MAX_RESOLVED_CONFLICTS = 10;

/** Lines that differ between two versions, or Infinity past the work limit. */
function diffSize(a: string[], b: string[]): number {
  const parts = diffArrays(a, b, { timeout: 1000 });
  if (!parts) return Infinity;
  return parts.reduce((n, p) => (p.added || p.removed ? n + p.count : n), 0);
}

/**
 * 3-way merge of line-based text. Where both sides changed the same lines,
 * `ours` wins, so a conflict resolution shows up as a change against what was
 * reviewed. Given the merged result (`head`), a conflict may instead keep
 * both sides (in either order) when that is closer to how head resolved it,
 * since neither side's lines are new work there. Theirs never replaces ours
 * outright: if the resolution dropped reviewed lines, that should show.
 */
export function merge3(
  base: string,
  ours: string,
  theirs: string,
  head?: string
): string {
  if (ours === base) return theirs;
  if (theirs === base || theirs === ours) return ours;
  const baseLines = splitLines(base);
  const all = [
    ...changes(baseLines, splitLines(ours), "ours"),
    ...changes(baseLines, splitLines(theirs), "theirs"),
  ].sort((a, b) => a.start - b.start || a.end - b.end);

  // Merged text as fixed runs, with conflicts left as alternatives.
  const segments: (string[] | { options: string[][] })[] = [];
  let pos = 0;
  let i = 0;
  while (i < all.length) {
    const group = [all[i]];
    const start = all[i].start;
    let end = all[i].end;
    // Changes overlap when their base ranges intersect; two insertions at the
    // same point also collide. Changes that only touch are merged cleanly.
    while (++i < all.length) {
      const next = all[i];
      const insertionAtEnd = group.some(
        (c) => c.start === end && c.end === end
      );
      if (
        next.start < end ||
        (next.start === end && next.end === end && insertionAtEnd)
      ) {
        group.push(next);
        end = Math.max(end, next.end);
      } else break;
    }
    segments.push(baseLines.slice(pos, start));
    if (group.every((c) => c.side === "theirs")) {
      segments.push(applySide(baseLines, group, "theirs", start, end));
    } else if (group.every((c) => c.side === "ours")) {
      segments.push(applySide(baseLines, group, "ours", start, end));
    } else {
      const mine = applySide(baseLines, group, "ours", start, end);
      const other = applySide(baseLines, group, "theirs", start, end);
      segments.push({
        options: [mine, [...mine, ...other], [...other, ...mine]],
      });
    }
    pos = end;
  }
  segments.push(baseLines.slice(pos));

  const conflicts = segments.filter((s) => !Array.isArray(s)).length;
  const choice = new Map<number, number>();
  const assemble = () =>
    segments.flatMap((s, index) =>
      Array.isArray(s) ? s : s.options[choice.get(index) ?? 0]
    );
  if (head !== undefined && conflicts <= MAX_RESOLVED_CONFLICTS) {
    const headLines = splitLines(head);
    // Greedy: settle each conflict in turn against the choices so far.
    segments.forEach((segment, index) => {
      if (Array.isArray(segment)) return;
      let best = 0;
      let bestSize = Infinity;
      segment.options.forEach((_, option) => {
        choice.set(index, option);
        const size = diffSize(assemble(), headLines);
        if (size < bestSize) {
          best = option;
          bestSize = size;
        }
      });
      choice.set(index, best);
    });
  }
  return assemble().join("");
}

/**
 * Result of diffing a rebased start file against head. `patch` is undefined
 * for binary files.
 */
export type RebaseResult =
  | { identical: true }
  | { identical: false; rebased: string; patch: string | undefined };

/**
 * Patch from the start content (with base-branch changes from `baseOld` to
 * `baseNew` replayed) to `head`.
 */
export function rebasedPatch(
  baseOld: string,
  ours: string,
  baseNew: string,
  head: string
): RebaseResult {
  if ([baseOld, ours, baseNew, head].some((c) => c.includes("\0"))) {
    return { identical: false, rebased: ours, patch: undefined };
  }
  const rebased = merge3(baseOld, ours, baseNew, head);
  if (rebased === head) return { identical: true };
  return { identical: false, patch: generatePatch(rebased, head), rebased };
}

function countChanges(patch: string) {
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions, changes: additions + deletions };
}

function paths(files: PullRequestFile[]): Set<string> {
  const set = new Set<string>();
  for (const file of files) {
    set.add(file.filename);
    if (file.previous_filename) set.add(file.previous_filename);
  }
  return set;
}

export interface RebaseRangeInput {
  /** Compare of start...end. */
  rangeFiles: PullRequestFile[];
  /** PR changes at the start commit (oldMergeBase...start). */
  prStartFiles: PullRequestFile[];
  /** PR changes at the end commit (newMergeBase...end). */
  prEndFiles: PullRequestFile[];
  /** Base-branch changes merged in (oldMergeBase...newMergeBase). */
  baseFiles: PullRequestFile[];
  startSha: string;
  endSha: string;
  oldMergeBase: string;
  newMergeBase: string;
  /** File content at a ref; "" when the file does not exist there. */
  getContent: (path: string, ref: string) => Promise<string>;
  rebase: (
    baseOld: string,
    ours: string,
    baseNew: string,
    head: string
  ) => Promise<RebaseResult>;
}

/**
 * Range files with base-branch changes removed. Files only the base branch
 * changed are dropped; files both sides changed get a patch against the
 * rebased start content. Also surfaces files where the merge discarded or
 * altered base-branch changes (identical at start and end, so absent from the
 * range compare), and PR files cut from a truncated range compare.
 */
export async function rebaseRangeFiles(
  input: RebaseRangeInput
): Promise<RangeFile[]> {
  const {
    rangeFiles,
    prStartFiles,
    prEndFiles,
    baseFiles,
    startSha,
    endSha,
    oldMergeBase,
    newMergeBase,
    getContent,
    rebase,
  } = input;
  // Truncated lists can't prove a file is untouched, so fall back to content.
  const prComplete =
    prStartFiles.length < COMPARE_FILE_LIMIT &&
    prEndFiles.length < COMPARE_FILE_LIMIT;
  const rangeComplete = rangeFiles.length < COMPARE_FILE_LIMIT;
  const baseComplete = baseFiles.length < COMPARE_FILE_LIMIT;
  const prPaths = paths([...prStartFiles, ...prEndFiles]);
  const basePaths = paths(baseFiles);
  const rangePaths = paths(rangeFiles);
  // Where the PR renamed a file, its path on the base branch.
  const renamedFrom = (files: PullRequestFile[]) =>
    new Map(
      files.flatMap((f) =>
        f.previous_filename ? [[f.filename, f.previous_filename] as const] : []
      )
    );
  const startRenames = renamedFrom(prStartFiles);
  const endRenames = renamedFrom(prEndFiles);
  const key = `${startSha}+${newMergeBase}`;
  const touches = (set: Set<string>, ...candidates: (string | undefined)[]) =>
    candidates.some((p) => p !== undefined && set.has(p));

  interface Job {
    file: PullRequestFile;
    startPath: string;
    endPath: string;
    startMissing: boolean;
    endMissing: boolean;
  }

  const result: (RangeFile | null)[] = [];
  const jobs: { index: number; job: Job }[] = [];
  const addJob = (job: Job, fallback: RangeFile | null) => {
    jobs.push({ index: result.length, job });
    result.push(fallback);
  };

  for (const file of rangeFiles) {
    if (prComplete && !touches(prPaths, file.filename, file.previous_filename))
      continue;
    if (
      baseComplete &&
      !touches(basePaths, file.filename, file.previous_filename)
    ) {
      result.push(file);
      continue;
    }
    addJob(
      {
        file,
        startPath: file.previous_filename ?? file.filename,
        endPath: file.filename,
        startMissing: file.status === "added",
        endMissing: file.status === "removed",
      },
      file
    );
  }

  if (prComplete) {
    const seen = new Set<string>();
    for (const file of [...prEndFiles, ...prStartFiles]) {
      const path = file.filename;
      if (seen.has(path) || rangePaths.has(path)) continue;
      seen.add(path);
      // A complete range compare proves the file is the same at start and
      // end, so only a base-branch change can make the merge differ.
      if (
        rangeComplete &&
        baseComplete &&
        !touches(basePaths, path, startRenames.get(path), endRenames.get(path))
      )
        continue;
      addJob(
        {
          file: { ...file, previous_filename: undefined, patch: undefined },
          startPath: path,
          endPath: path,
          startMissing: false,
          endMissing: false,
        },
        null
      );
    }
  }

  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, jobs.length) }, async () => {
      while (next < jobs.length) {
        const { index, job } = jobs[next++];
        try {
          const oldBasePath = startRenames.get(job.startPath) ?? job.startPath;
          const newBasePath = endRenames.get(job.endPath) ?? job.endPath;
          const [baseOld, baseNew, start, end] = await Promise.all([
            getContent(oldBasePath, oldMergeBase),
            getContent(newBasePath, newMergeBase),
            job.startMissing ? "" : getContent(job.startPath, startSha),
            job.endMissing ? "" : getContent(job.endPath, endSha),
          ]);
          const outcome = await rebase(baseOld, start, baseNew, end);
          if (outcome.identical) {
            result[index] = null;
          } else if (outcome.patch !== undefined) {
            const { rebased } = outcome;
            result[index] = {
              ...job.file,
              ...countChanges(outcome.patch),
              status:
                job.file.status === "renamed"
                  ? "renamed"
                  : rebased === ""
                    ? "added"
                    : end === ""
                      ? "removed"
                      : "modified",
              patch: outcome.patch,
              rebased_base: { key, content: rebased },
            };
          }
        } catch (error) {
          console.error(
            `Could not rebase diff for ${job.file.filename}`,
            error
          );
        }
      }
    })
  );

  return result.filter((f): f is RangeFile => f !== null);
}

/** Blob oid by path for every file in a commit. */
export type Tree = Map<string, string>;

/** A path's blob oids at the four commits; undefined where it is absent. */
export interface TreeChange {
  path: string;
  oldBase?: string;
  start?: string;
  newBase?: string;
  end?: string;
}

/**
 * Paths that may hold PR changes between start and end. Unlike the compare
 * endpoint this has no file limit. A path is skipped when it is the same at
 * both ends with no base change, or when the PR leaves it untouched at both
 * ends (any difference is the base branch's).
 */
export function treeChanges(
  oldBase: Tree,
  start: Tree,
  newBase: Tree,
  end: Tree
): TreeChange[] {
  const result: TreeChange[] = [];
  const all = new Set([
    ...oldBase.keys(),
    ...start.keys(),
    ...newBase.keys(),
    ...end.keys(),
  ]);
  for (const path of all) {
    const change = {
      path,
      oldBase: oldBase.get(path),
      start: start.get(path),
      newBase: newBase.get(path),
      end: end.get(path),
    };
    if (change.start === change.end && change.oldBase === change.newBase)
      continue;
    if (change.start === change.oldBase && change.end === change.newBase)
      continue;
    result.push(change);
  }
  return result;
}

export interface BlobRequest {
  oid: string;
  /** Where the blob lives, for fetching it by path when needed. */
  path: string;
  ref: string;
}

export interface TreeRangeInput {
  changes: TreeChange[];
  /** Compare of start...end, possibly truncated; its patches are reused. */
  rangeFiles: PullRequestFile[];
  startSha: string;
  endSha: string;
  oldMergeBase: string;
  newMergeBase: string;
  /** Blob text by oid; null for binary blobs. */
  getBlobs: (requests: BlobRequest[]) => Promise<Map<string, string | null>>;
  rebase: TreeRangeRebase;
}

type TreeRangeRebase = (
  baseOld: string,
  ours: string,
  baseNew: string,
  head: string
) => Promise<RebaseResult>;

function treeFile(
  path: string,
  sha: string,
  status: PullRequestFile["status"],
  extra: Partial<RangeFile> = {}
): RangeFile {
  return {
    sha,
    filename: path,
    status,
    additions: 0,
    deletions: 0,
    changes: 0,
    blob_url: "",
    raw_url: "",
    contents_url: "",
    ...extra,
  };
}

/**
 * Range files built from tree listings, for ranges too large for the compare
 * endpoint's file limit. Same rules as rebaseRangeFiles; paths the base branch
 * didn't touch are plain start-to-end diffs. Renames are only detected for
 * files moved without changes.
 */
export async function rangeFromTrees(
  input: TreeRangeInput
): Promise<RangeFile[]> {
  const { changes, startSha, endSha, oldMergeBase, newMergeBase } = input;
  const key = `${startSha}+${newMergeBase}`;
  const rangeByPath = new Map(
    input.rangeFiles
      .filter((f) => !f.previous_filename && f.patch)
      .map((f) => [f.filename, f])
  );
  const plain = (c: TreeChange) => c.oldBase === c.newBase;
  const reusable = (c: TreeChange) => {
    const file = rangeByPath.get(c.path);
    if (!file || !plain(c)) return null;
    return (c.end ?? c.start) === file.sha ? file : null;
  };

  // Exact moves pair up as renames, as GitHub would show them.
  const moves = new Map<string, TreeChange>();
  const added = new Map<string, TreeChange>();
  for (const c of changes) {
    if (plain(c) && c.end && !c.start) added.set(c.end, c);
  }
  for (const c of changes) {
    const target = c.start && !c.end && plain(c) && added.get(c.start);
    if (target && !moves.has(target.path)) {
      moves.set(target.path, c);
      moves.set(c.path, c);
    }
  }

  const requests: BlobRequest[] = [];
  const pending = changes.filter((c) => !moves.has(c.path) && !reusable(c));
  for (const c of pending) {
    if (c.start) requests.push({ oid: c.start, path: c.path, ref: startSha });
    if (c.end) requests.push({ oid: c.end, path: c.path, ref: endSha });
    if (plain(c)) continue;
    if (c.oldBase)
      requests.push({ oid: c.oldBase, path: c.path, ref: oldMergeBase });
    if (c.newBase)
      requests.push({ oid: c.newBase, path: c.path, ref: newMergeBase });
  }
  const blobs = await input.getBlobs(requests);
  const text = (oid: string | undefined) =>
    oid === undefined ? "" : blobs.get(oid);

  const result: RangeFile[] = [];
  for (const c of changes) {
    const reused = reusable(c);
    if (reused) result.push(reused);
    const from = moves.get(c.path);
    if (from && from.path !== c.path) {
      result.push(
        treeFile(c.path, c.end!, "renamed", { previous_filename: from.path })
      );
    }
  }

  await Promise.all(
    pending.map(async (c) => {
      const start = text(c.start);
      const end = text(c.end);
      const baseOld = plain(c) ? start : text(c.oldBase);
      const baseNew = plain(c) ? start : text(c.newBase);
      const sha = c.end ?? c.start ?? "";
      const status = (oldMissing: boolean): PullRequestFile["status"] =>
        oldMissing ? "added" : c.end ? "modified" : "removed";
      if ([start, end, baseOld, baseNew].some((t) => t == null)) {
        // Binary (or unavailable): shown without a patch when the PR side changed
        if (c.start !== c.end)
          result.push(treeFile(c.path, sha, status(!c.start)));
        return;
      }
      try {
        const outcome = await input.rebase(baseOld!, start!, baseNew!, end!);
        if (outcome.identical) return;
        if (outcome.patch === undefined) {
          if (c.start !== c.end)
            result.push(treeFile(c.path, sha, status(!c.start)));
          return;
        }
        const oldMissing = !c.start && (plain(c) || !c.newBase);
        result.push(
          treeFile(c.path, sha, status(oldMissing), {
            ...countChanges(outcome.patch),
            patch: outcome.patch,
            ...(plain(c)
              ? {}
              : { rebased_base: { key, content: outcome.rebased } }),
          })
        );
      } catch (error) {
        console.error(`Could not rebase diff for ${c.path}`, error);
      }
    })
  );
  return result;
}
