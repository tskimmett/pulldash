import type { PullRequestFile } from "@/api/types";

/**
 * What the viewer saw when they marked a file viewed. A later push that
 * changes the file un-views it, the way GitHub's "changed since last viewed"
 * does.
 */
export interface ViewedRecord {
  /** Head blob sha of the file when viewed */
  sha?: string;
  /** Hash of the file's patch when viewed */
  patch?: string;
  /** PR head commit when viewed; the start of "changes since viewed" */
  at?: string;
}

export type ViewedRecords = Record<string, ViewedRecord>;

export interface ViewedState {
  /** Files whose viewed version is still current */
  viewedFiles: Set<string>;
  /** Files viewed at an older version -> head sha they were viewed at */
  changedSinceViewed: Map<string, string | undefined>;
}

const patchHashes = new WeakMap<PullRequestFile, string>();

/** FNV-1a; patches are compared for equality, not secrecy. */
function hashPatch(file: PullRequestFile): string | undefined {
  if (file.patch === undefined) return undefined;
  let hash = patchHashes.get(file);
  if (hash === undefined) {
    let h = 0x811c9dc5;
    const patch = file.patch;
    for (let i = 0; i < patch.length; i++) {
      h ^= patch.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    hash = `${patch.length}:${(h >>> 0).toString(36)}`;
    patchHashes.set(file, hash);
  }
  return hash;
}

export function recordView(
  file: PullRequestFile | undefined,
  headSha: string
): ViewedRecord {
  return {
    sha: file?.sha || undefined,
    patch: file && hashPatch(file),
    at: headSha,
  };
}

/**
 * Same blob at head, or the same patch (a rebase that leaves the change
 * itself untouched), both mean the viewer has already seen this version.
 * Records with no fingerprint predate tracking and stay viewed.
 */
export function isStillViewed(
  record: ViewedRecord,
  file: PullRequestFile | undefined
): boolean {
  if (!file || (!record.sha && !record.patch)) return true;
  if (record.sha && record.sha === file.sha) return true;
  return record.patch !== undefined && record.patch === hashPatch(file);
}

export function deriveViewed(
  records: ViewedRecords,
  files: PullRequestFile[]
): ViewedState {
  const byName = new Map(files.map((f) => [f.filename, f]));
  const viewedFiles = new Set<string>();
  const changedSinceViewed = new Map<string, string | undefined>();
  for (const [filename, record] of Object.entries(records)) {
    const file = byName.get(filename);
    if (isStillViewed(record, file)) viewedFiles.add(filename);
    else changedSinceViewed.set(filename, record.at);
  }
  return { viewedFiles, changedSinceViewed };
}

/** Reads both the current format and the legacy array of filenames. */
export function parseViewedRecords(stored: string | null): ViewedRecords {
  if (!stored) return {};
  try {
    const parsed: unknown = JSON.parse(stored);
    if (Array.isArray(parsed)) {
      return Object.fromEntries(
        parsed
          .filter((f): f is string => typeof f === "string")
          .map((f) => [f, {}])
      );
    }
    if (parsed && typeof parsed === "object") return parsed as ViewedRecords;
  } catch {}
  return {};
}
