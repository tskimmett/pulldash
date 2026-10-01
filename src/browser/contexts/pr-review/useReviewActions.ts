import type { ReviewComment } from "@/api/types";
import { cacheKeys, useGitHub, type Review } from "@/browser/contexts/github";
import { useTelemetry } from "@/browser/contexts/telemetry";
import { usePRReviewStore, usePRReviewSelector } from ".";

export function useReviewActions() {
  const store = usePRReviewStore();
  const github = useGitHub();
  const owner = usePRReviewSelector((s) => s.owner);
  const repo = usePRReviewSelector((s) => s.repo);
  const pr = usePRReviewSelector((s) => s.pr);
  const { track } = useTelemetry();

  const submitReview = async (
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT"
  ) => {
    const state = store.getSnapshot();
    store.setSubmittingReview(true);

    let newReview: Review | null = null;
    let submittedReviewId: number | null = null;

    try {
      // Get the pending review node ID (from GraphQL)
      const reviewNodeId = store.getPendingReviewNodeId();

      if (reviewNodeId) {
        submittedReviewId = await github.submitPendingReview(
          reviewNodeId,
          event,
          state.reviewBody
        );
      } else if (state.pendingComments.length > 0) {
        // Fallback: create a new review with all comments via REST
        newReview = await github.createPRReview(owner, repo, pr.number, {
          commit_id: pr.head.sha,
          event,
          body: state.reviewBody,
          comments: state.pendingComments.map(
            ({ path, line, body, side, start_line }) => ({
              path,
              line,
              body,
              side: side as "LEFT" | "RIGHT",
              start_line,
            })
          ),
        });
      } else {
        // Just submitting a review with no comments (APPROVE, etc)
        newReview = await github.createPRReview(owner, repo, pr.number, {
          commit_id: pr.head.sha,
          event,
          body: state.reviewBody,
          comments: [],
        });
      }

      // Track review submission
      track("review_submitted", {
        pr_number: pr.number,
        owner,
        repo,
        review_type: event,
        comment_count: state.pendingComments.length,
        files_reviewed: state.viewedFiles.size,
      });

      submittedReviewId ??= newReview?.id ?? null;
      const { updatedPR, newComments, reviews, timeline, threadsResult } =
        await refreshUntilReviewVisible(submittedReviewId);
      // Reviewing removes you from requested reviewers
      if (updatedPR) store.setPr(updatedPR);
      // Threads first so setComments can stamp resolved state onto comments
      if (threadsResult) store.setReviewThreads(threadsResult.threads);
      store.setComments(newComments as ReviewComment[]);
      store.setReviews(reviews);
      store.setTimeline(timeline);

      // Scroll to the submitted review, or the latest one if its ID is unknown
      let scrollTarget: string | undefined;
      if (submittedReviewId) {
        scrollTarget = `pullrequestreview-${submittedReviewId}`;
      } else if (reviews.length > 0) {
        // Find the most recent review (likely the one we just submitted)
        const sortedReviews = [...reviews].sort(
          (a, b) =>
            new Date(b.submitted_at ?? 0).getTime() -
            new Date(a.submitted_at ?? 0).getTime()
        );
        if (sortedReviews[0]) {
          scrollTarget = `pullrequestreview-${sortedReviews[0].id}`;
        }
      }

      store.clearReviewState();

      // Navigate to overview page and scroll to the new review
      store.selectOverview(scrollTarget);
    } finally {
      store.setSubmittingReview(false);
    }
  };

  /**
   * Refetch the conversation after submitting. GitHub's lists can lag a
   * moment behind a write, so retry until the submitted review shows up.
   */
  const refreshUntilReviewVisible = async (reviewId: number | null) => {
    const prKey = cacheKeys.pr(owner, repo, pr.number);
    for (let attempt = 0; ; attempt++) {
      // Just the PR itself, not its files and other nested data
      github.invalidateCache((key) => key === prKey);
      github.invalidateCache(cacheKeys.prTimeline(owner, repo, pr.number));
      github.invalidateCache(cacheKeys.prComments(owner, repo, pr.number));
      github.invalidateCache(cacheKeys.prReviews(owner, repo, pr.number));
      github.invalidateCache(cacheKeys.prThreads(owner, repo, pr.number));

      const [updatedPR, newComments, reviews, timeline, threadsResult] =
        await Promise.all([
          github.getPR(owner, repo, pr.number).catch(() => null),
          github.getPRComments(owner, repo, pr.number),
          github.getPRReviews(owner, repo, pr.number),
          github.getPRTimeline(owner, repo, pr.number),
          github.getReviewThreads(owner, repo, pr.number).catch(() => null),
        ]);
      const visible =
        reviewId === null ||
        (reviews.some((r) => r.id === reviewId) &&
          timeline.some(
            (e) =>
              (e as { event?: string; id?: number }).event === "reviewed" &&
              (e as { id?: number }).id === reviewId
          ));
      if (visible || attempt >= 3) {
        return { updatedPR, newComments, reviews, timeline, threadsResult };
      }
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  };

  return { submitReview };
}
