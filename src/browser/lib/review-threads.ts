import type { ReviewComment } from "@/api/types";
import type { ReviewThread } from "@/browser/contexts/github";

/**
 * Stamp GraphQL review-thread info (thread id, resolved state, resolver) onto
 * REST review comments. The REST API has no notion of threads, so without this
 * every inline thread renders as unresolved and can't be resolved from the UI.
 *
 * Comments that don't match any thread keep whatever they already had, so
 * passing an empty thread list (e.g. GraphQL failed) never wipes known state.
 */
export function enrichCommentsWithThreads(
  comments: ReviewComment[],
  threads: ReviewThread[]
): ReviewComment[] {
  if (threads.length === 0) return comments;

  const byCommentId = new Map<number, ReviewThread>();
  for (const thread of threads) {
    for (const c of thread.comments.nodes) {
      byCommentId.set(c.databaseId, thread);
    }
  }

  return comments.map((comment) => {
    const thread = byCommentId.get(comment.id);
    if (!thread) return comment;
    return {
      ...comment,
      pull_request_review_thread_id: thread.id,
      is_resolved: thread.isResolved,
      resolved_by: thread.resolvedBy
        ? {
            login: thread.resolvedBy.login,
            avatar_url: thread.resolvedBy.avatarUrl,
          }
        : null,
    };
  });
}

type Side = "LEFT" | "RIGHT";

/** Lookup key for comments anchored to `line` on one side of the diff. */
export function sideLineKey(side: Side, line: number): string {
  return `${side}:${line}`;
}

/**
 * Keys a diff line answers to. Deleted lines live on LEFT, added lines on
 * RIGHT, and context lines on both. Line numbers alone collide: old line 10
 * and new line 10 are usually different lines.
 */
export function diffLineKeys(line: {
  type: "insert" | "delete" | "normal";
  oldLineNumber?: number;
  newLineNumber?: number;
}): string[] {
  const keys: string[] = [];
  if (line.type !== "insert" && line.oldLineNumber)
    keys.push(sideLineKey("LEFT", line.oldLineNumber));
  if (line.type !== "delete" && line.newLineNumber)
    keys.push(sideLineKey("RIGHT", line.newLineNumber));
  return keys;
}

/** Group comments into threads (root first, replies after), keyed by side and line. */
export function groupThreadsBySideLine(
  comments: ReviewComment[]
): Map<string, ReviewComment[][]> {
  const roots = new Map<number, ReviewComment[]>();
  const result = new Map<string, ReviewComment[][]>();
  for (const c of comments) {
    if (c.in_reply_to_id) continue;
    const line = c.line ?? c.original_line;
    if (!line) continue;
    const thread = [c];
    roots.set(c.id, thread);
    const key = sideLineKey(c.side === "LEFT" ? "LEFT" : "RIGHT", line);
    result.set(key, [...(result.get(key) ?? []), thread]);
  }
  for (const c of comments) {
    if (c.in_reply_to_id) roots.get(c.in_reply_to_id)?.push(c);
  }
  return result;
}
