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
