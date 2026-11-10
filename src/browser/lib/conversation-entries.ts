import type {
  IssueComment,
  Review,
  ReviewThread,
  TimelineEvent,
} from "@/browser/contexts/github";

export type ConversationFilter = "all" | "unresolved" | "mine";

export type CommittedEvent = Extract<
  TimelineEvent,
  { sha: string; author: { date: string } }
>;

export type ConversationEntry =
  | { type: "comment"; data: IssueComment }
  | { type: "review"; data: Review; threads: ReviewThread[] }
  | { type: "event"; data: TimelineEvent }
  | { type: "thread"; data: ReviewThread }
  | { type: "commits"; data: CommittedEvent[] };

function participated(thread: ReviewThread, login: string): boolean {
  return thread.comments.nodes.some((c) => c.author?.login === login);
}

/**
 * Build the Conversation tab's entries, newest first, using GitHub's timeline
 * order as the source of truth. Consecutive commits are grouped, review
 * threads are nested under their review, and threads with no review come
 * first.
 *
 * `filter` narrows the list like GitHub's All / Unresolved / Mine toggle:
 * - unresolved: only unresolved review threads (under their review)
 * - mine: comments and reviews by `currentUser`, plus threads they took part in
 * Both drop commits and other events.
 */
export function buildConversationEntries({
  timeline,
  conversation,
  reviews,
  reviewThreads,
  merged,
  filter = "all",
  currentUser = null,
}: {
  timeline: TimelineEvent[];
  conversation: IssueComment[];
  reviews: Review[];
  reviewThreads: ReviewThread[];
  merged: boolean;
  filter?: ConversationFilter;
  currentUser?: string | null;
}): ConversationEntry[] {
  const keepThread = (thread: ReviewThread, reviewIsMine: boolean) => {
    if (filter === "unresolved") return !thread.isResolved;
    if (filter === "mine") {
      return (
        reviewIsMine ||
        (currentUser !== null && participated(thread, currentUser))
      );
    }
    return true;
  };

  const threadsByReviewId = new Map<number, ReviewThread[]>();
  const orphanedThreads: ReviewThread[] = [];
  for (const thread of reviewThreads) {
    const reviewId = thread.pullRequestReview?.databaseId;
    if (reviewId) {
      const existing = threadsByReviewId.get(reviewId);
      if (existing) existing.push(thread);
      else threadsByReviewId.set(reviewId, [thread]);
    } else {
      orphanedThreads.push(thread);
    }
  }

  const commentsById = new Map(conversation.map((c) => [c.id, c]));
  const reviewsById = new Map(reviews.map((r) => [r.id, r]));
  const showEvents = filter === "all";

  const entries: ConversationEntry[] = [];
  let pendingCommits: CommittedEvent[] = [];
  const flushCommits = () => {
    if (pendingCommits.length > 0) {
      entries.push({ type: "commits", data: pendingCommits });
      pendingCommits = [];
    }
  };

  for (const event of timeline) {
    // timeline-committed-event (has sha + author)
    if ("sha" in event && "author" in event) {
      if (showEvents) pendingCommits.push(event as CommittedEvent);
      continue;
    }
    flushCommits();

    if (!("event" in event)) continue;
    const eventType = event.event;

    // Redundant with the merge event
    if (eventType === "closed" && merged) continue;

    if (eventType === "commented" && "id" in event) {
      const comment = commentsById.get(event.id as unknown as number);
      if (!comment) continue;
      if (filter === "unresolved") continue;
      if (filter === "mine" && comment.user?.login !== currentUser) continue;
      entries.push({ type: "comment", data: comment });
      continue;
    }

    if (eventType === "reviewed" && "id" in event) {
      const review = reviewsById.get(event.id as unknown as number);
      if (!review) continue;
      const allThreads = threadsByReviewId.get(review.id) ?? [];
      const reviewIsMine =
        currentUser !== null && review.user?.login === currentUser;
      const threads = allThreads.filter((t) => keepThread(t, reviewIsMine));

      if (filter === "unresolved" && threads.length === 0) continue;
      if (filter === "mine" && !reviewIsMine && threads.length === 0) continue;
      // Show APPROVED/CHANGES_REQUESTED always, COMMENTED only if it has a
      // body or threads.
      if (
        review.body ||
        review.state === "APPROVED" ||
        review.state === "CHANGES_REQUESTED" ||
        threads.length > 0
      ) {
        entries.push({ type: "review", data: review, threads });
      }
      continue;
    }

    // Shown inline in reviews
    if (eventType === "line-commented") continue;

    if (showEvents) entries.push({ type: "event", data: event });
  }
  flushCommits();

  for (const thread of orphanedThreads) {
    if (thread.comments.nodes[0] && keepThread(thread, false)) {
      entries.push({ type: "thread", data: thread });
    }
  }

  return entries.reverse();
}

/** DOM ids of the entries keyboard navigation (j/k) steps through. */
export function navigableEntryIds(entries: ConversationEntry[]): string[] {
  const ids: string[] = [];
  for (const entry of entries) {
    if (entry.type === "comment") ids.push(`issuecomment-${entry.data.id}`);
    else if (entry.type === "thread") ids.push(`reviewthread-${entry.data.id}`);
    else if (entry.type === "review") {
      ids.push(`pullrequestreview-${entry.data.id}`);
      for (const t of entry.threads) ids.push(`reviewthread-${t.id}`);
    }
  }
  return ids;
}
