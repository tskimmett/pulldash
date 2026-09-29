import { useMemo } from "react";
import { usePRReviewSelector, visibleComments } from ".";

/** Get comment counts per file, honoring the hide-resolved toggle */
export function useCommentCountsByFile(): Record<string, number> {
  const allComments = usePRReviewSelector((s) => s.comments);
  const hideResolved = usePRReviewSelector((s) => s.hideResolvedComments);
  return useMemo(() => {
    const comments = visibleComments(allComments, hideResolved);
    const counts: Record<string, number> = {};
    for (const c of comments) {
      counts[c.path] = (counts[c.path] || 0) + 1;
    }
    return counts;
  }, [allComments, hideResolved]);
}
