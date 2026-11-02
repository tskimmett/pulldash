import { memo, useCallback, useEffect, useState } from "react";
import { useCanWrite } from "../contexts/auth";
import {
  useCurrentUser,
  useGitHub,
  type Reaction,
  type ReactionContent,
} from "../contexts/github";
import { usePRReviewSelector } from "../contexts/pr-review";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "../ui/dialog";
import { CommentBox } from "./pr-overview";

/** The PR body card with its reactions. Shared by the overview and the modal. */
export const PRDescription = memo(function PRDescription({
  isFocused,
}: {
  isFocused?: boolean;
}) {
  const github = useGitHub();
  const canWrite = useCanWrite();
  const pr = usePRReviewSelector((s) => s.pr);
  const owner = usePRReviewSelector((s) => s.owner);
  const repo = usePRReviewSelector((s) => s.repo);
  const currentUser = useCurrentUser()?.login ?? null;
  const [reactions, setReactions] = useState<Reaction[]>([]);

  useEffect(() => {
    let cancelled = false;
    github
      .getIssueReactions(owner, repo, pr.number)
      .then((r) => !cancelled && setReactions(r))
      .catch((error) => console.error("Failed to fetch PR reactions:", error));
    return () => {
      cancelled = true;
    };
  }, [github, owner, repo, pr.number]);

  const handleAdd = useCallback(
    async (content: ReactionContent) => {
      try {
        const created = await github.addIssueReaction(
          owner,
          repo,
          pr.number,
          content
        );
        setReactions((prev) => [...prev, created]);
      } catch (error) {
        console.error("Failed to add reaction:", error);
      }
    },
    [github, owner, repo, pr.number]
  );

  const handleRemove = useCallback(
    async (reactionId: number) => {
      try {
        await github.deleteIssueReaction(owner, repo, pr.number, reactionId);
        setReactions((prev) => prev.filter((r) => r.id !== reactionId));
      } catch (error) {
        console.error("Failed to remove reaction:", error);
      }
    },
    [github, owner, repo, pr.number]
  );

  return (
    <CommentBox
      id="pr-description"
      user={pr.user}
      createdAt={pr.created_at}
      body={pr.body}
      bodyHtml={pr.body_html}
      isAuthor
      reactions={reactions}
      onAddReaction={canWrite ? handleAdd : undefined}
      onRemoveReaction={canWrite ? handleRemove : undefined}
      currentUser={currentUser}
      isFocused={isFocused}
    />
  );
});

/** Right-hand drawer so reviewers can read the description without leaving the diff. */
export function PRDescriptionDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const title = usePRReviewSelector((s) => s.pr.title);
  const number = usePRReviewSelector((s) => s.pr.number);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="top-0 right-0 left-auto h-full max-h-none w-full max-w-full translate-x-0 translate-y-0 content-start overflow-y-auto rounded-none border-y-0 border-r-0 border-border bg-background sm:max-w-4xl data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100 data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right">
        <DialogTitle className="pr-6 text-base leading-snug">
          {title}
          <span className="text-muted-foreground ml-1.5 font-normal">
            #{number}
          </span>
        </DialogTitle>
        <DialogDescription className="sr-only">
          Pull request description
        </DialogDescription>
        {/* Only mount while open so reactions aren't fetched until needed. */}
        {open && <PRDescription />}
      </DialogContent>
    </Dialog>
  );
}
