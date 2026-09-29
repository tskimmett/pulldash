import { useMemo } from "react";
import type { ReviewComment } from "@/api/types";
import { usePRReviewSelector, visibleComments } from ".";

const EMPTY_COMMENTS: ReviewComment[] = [];

/** Get comments for current file, honoring the hide-resolved toggle */
export function useCurrentFileComments(): ReviewComment[] {
  const selectedFile = usePRReviewSelector((s) => s.selectedFile);
  const comments = usePRReviewSelector((s) => s.comments);
  const hideResolved = usePRReviewSelector((s) => s.hideResolvedComments);
  return useMemo(() => {
    if (!selectedFile) return EMPTY_COMMENTS;
    return visibleComments(
      comments.filter((c) => c.path === selectedFile),
      hideResolved
    );
  }, [selectedFile, comments, hideResolved]);
}

/** Number of resolved comments in the current file (regardless of the toggle) */
export function useCurrentFileResolvedCount(): number {
  const selectedFile = usePRReviewSelector((s) => s.selectedFile);
  const comments = usePRReviewSelector((s) => s.comments);
  return useMemo(() => {
    if (!selectedFile) return 0;
    let n = 0;
    for (const c of comments) {
      if (c.path === selectedFile && c.is_resolved) n++;
    }
    return n;
  }, [selectedFile, comments]);
}
