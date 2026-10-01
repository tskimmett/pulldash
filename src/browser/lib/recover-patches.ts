import type { PullRequestFile } from "@/api/types";
import { createTwoFilesPatch } from "diff";

/** Generate only hunk text, matching GitHub's patch field. Runs in a worker. */
export function generatePatch(
  oldContent: string,
  newContent: string
): string | undefined {
  if (oldContent.includes("\0") || newContent.includes("\0")) return undefined;
  const patch = createTwoFilesPatch(
    "file",
    "file",
    oldContent,
    newContent,
    undefined,
    undefined,
    { timeout: 5000 }
  );
  if (!patch)
    throw new Error("Generating the file diff exceeded the work limit");
  const start = patch.indexOf("@@ ");
  return start === -1 ? undefined : patch.slice(start);
}

/** Recover omitted text patches with bounded concurrency; preserve supplied patches. */
export async function recoverPatches(
  files: PullRequestFile[],
  baseRef: string,
  headRef: string,
  getContent: (path: string, ref: string) => Promise<string>,
  makePatch: (
    oldContent: string,
    newContent: string
  ) => Promise<string | undefined>
): Promise<PullRequestFile[]> {
  const result = [...files];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, files.length) }, async () => {
      while (next < files.length) {
        const index = next++;
        const file = files[index];
        if (file.patch || file.changes === 0) continue;
        try {
          const [oldContent, newContent] = await Promise.all([
            file.status === "added"
              ? ""
              : getContent(file.previous_filename ?? file.filename, baseRef),
            file.status === "removed" ? "" : getContent(file.filename, headRef),
          ]);
          const patch = await makePatch(oldContent, newContent);
          if (patch) result[index] = { ...file, patch };
        } catch (error) {
          console.error(`Could not recover diff for ${file.filename}`, error);
        }
      }
    })
  );
  return result;
}

const recoveryKey = (file: PullRequestFile) =>
  [
    file.filename,
    file.previous_filename,
    file.sha,
    file.additions,
    file.deletions,
  ].join("\0");

/**
 * GitHub keeps omitting the same large patches on every fetch. Reuse patches
 * rebuilt for an earlier copy of the list when the file change is identical.
 */
export function carryOverRecoveredPatches(
  files: PullRequestFile[],
  previous: PullRequestFile[]
): PullRequestFile[] {
  if (!files.some((file) => !file.patch && file.changes > 0)) return files;
  const patches = new Map(
    previous.flatMap((file) =>
      file.patch ? [[recoveryKey(file), file.patch] as const] : []
    )
  );
  return files.map((file) => {
    if (file.patch || file.changes === 0) return file;
    const patch = patches.get(recoveryKey(file));
    return patch ? { ...file, patch } : file;
  });
}
