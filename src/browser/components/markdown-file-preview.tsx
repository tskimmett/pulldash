import { memo, useEffect, useState } from "react";
import { useGitHub } from "../contexts/github";
import { usePRReviewSelector } from "../contexts/pr-review";
import { Markdown } from "../ui/markdown";
import { Skeleton } from "../ui/skeleton";

/** Renders a markdown file as it reads at the head of the reviewed range. */
export const MarkdownFilePreview = memo(function MarkdownFilePreview({
  filename,
}: {
  filename: string;
}) {
  const github = useGitHub();
  const owner = usePRReviewSelector((s) => s.owner);
  const repo = usePRReviewSelector((s) => s.repo);
  const ref = usePRReviewSelector((s) => s.diffRange?.endSha ?? s.pr.head.sha);
  const key = `${ref}:${filename}`;
  const [state, setState] = useState<{
    key: string;
    content?: string;
    error?: boolean;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    github
      .getFileContent(owner, repo, filename, ref, false)
      .then((content) => !cancelled && setState({ key, content }))
      .catch((error) => {
        console.error("Failed to load markdown preview:", error);
        if (!cancelled) setState({ key, error: true });
      });
    return () => {
      cancelled = true;
    };
  }, [github, owner, repo, filename, ref, key]);

  const current = state?.key === key ? state : null;

  return (
    <div className="flex-1 min-h-0 overflow-auto">
      <div className="max-w-4xl mx-auto px-6 py-6">
        {!current ? (
          <div className="space-y-3">
            <Skeleton className="h-7 w-1/2" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-5/6" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        ) : current.error ? (
          <p className="text-sm text-muted-foreground text-center">
            Couldn't load this file.
          </p>
        ) : (
          <Markdown
            emptyState={
              <p className="text-sm text-muted-foreground text-center">
                This file is empty.
              </p>
            }
          >
            {current.content ?? ""}
          </Markdown>
        )}
      </div>
    </div>
  );
});
