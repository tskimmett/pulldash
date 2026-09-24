import { Check, GitCommitHorizontal, History, Loader2, X } from "lucide-react";
import { memo, useMemo } from "react";
import { cn } from "../cn";
import { usePRReviewSelector, usePRReviewStore } from "../contexts/pr-review";
import {
  commitsAfter,
  findLastReviewedSha,
  isRangeAvailable,
} from "@/browser/lib/review-range";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

/**
 * Header control for narrowing the diff to "changes since" a commit.
 *
 * - When the viewer has a submitted review and newer commits exist, the
 *   button reads "N new commits" and one click shows only those changes.
 * - The dropdown lists every commit so any start point can be picked, and
 *   offers a reset to the full PR.
 */
export const DiffRangeButton = memo(function DiffRangeButton() {
  const store = usePRReviewStore();
  const pr = usePRReviewSelector((s) => s.pr);
  const commits = usePRReviewSelector((s) => s.commits);
  const reviews = usePRReviewSelector((s) => s.reviews);
  const currentUser = usePRReviewSelector((s) => s.currentUser);
  const range = usePRReviewSelector((s) => s.diffRange);
  const loading = usePRReviewSelector((s) => s.diffRangeLoading);

  const lastReviewedSha = useMemo(
    () => findLastReviewedSha(reviews, currentUser),
    [reviews, currentUser]
  );
  const sinceReview =
    lastReviewedSha && isRangeAvailable(commits, lastReviewedSha, pr.head.sha)
      ? commitsAfter(commits, lastReviewedSha)
      : null;

  if (commits.length < 2 && !range) return null;

  const active = range !== null;
  const rangeCommits = range ? commitsAfter(commits, range.startSha) : null;

  const label = loading
    ? "Loading…"
    : active
      ? range.source === "review"
        ? "Since your review"
        : `Since ${range.startSha.slice(0, 7)}`
      : sinceReview
        ? `${sinceReview.length} new ${sinceReview.length === 1 ? "commit" : "commits"}`
        : "Changes since…";

  const title = active
    ? `Showing ${rangeCommits?.length ?? "?"} commits since ${range.startSha.slice(0, 7)}. Click to show all changes.`
    : sinceReview
      ? `Show only the ${sinceReview.length} commits pushed since your last review`
      : "Show only changes since a commit";

  const primaryClass = active
    ? "bg-blue-600 text-white hover:bg-blue-700"
    : sinceReview
      ? "bg-blue-600/20 text-blue-600 dark:text-blue-400 hover:bg-blue-600/30"
      : "bg-muted text-muted-foreground hover:bg-muted/70";

  const onPrimaryClick = () => {
    if (active) {
      void store.clearDiffRange();
    } else if (sinceReview) {
      void store.showChangesSinceLastReview();
    }
  };

  // Without a review to anchor on, the whole button is the picker.
  const primaryIsPicker = !active && !sinceReview;

  const primary = (
    <button
      onClick={primaryIsPicker ? undefined : onPrimaryClick}
      disabled={loading}
      className={cn(
        "flex items-center gap-1.5 px-2 py-1 text-xs font-medium transition-colors",
        primaryIsPicker ? "rounded-md" : "rounded-l-md",
        primaryClass
      )}
      title={title}
    >
      {loading ? (
        <Loader2 className="w-3.5 h-3.5 animate-spin" />
      ) : active ? (
        <X className="w-3.5 h-3.5" />
      ) : (
        <History className="w-3.5 h-3.5" />
      )}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );

  const menu = (
    <DropdownMenuContent align="end" className="w-[360px]">
      <DropdownMenuLabel className="font-semibold">
        Show changes since
      </DropdownMenuLabel>
      <DropdownMenuSeparator />
      {sinceReview && (
        <DropdownMenuItem
          onClick={() => void store.showChangesSinceLastReview()}
          className="text-xs"
        >
          <History className="w-3.5 h-3.5 mr-1.5 shrink-0" />
          <span className="flex-1 truncate">Your last review</span>
          {range?.source === "review" && (
            <Check className="w-3.5 h-3.5 ml-1.5 shrink-0" />
          )}
        </DropdownMenuItem>
      )}
      <DropdownMenuItem
        onClick={() => void store.clearDiffRange()}
        className="text-xs"
      >
        <GitCommitHorizontal className="w-3.5 h-3.5 mr-1.5 shrink-0" />
        <span className="flex-1 truncate">All changes</span>
        {!range && <Check className="w-3.5 h-3.5 ml-1.5 shrink-0" />}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <div className="max-h-[280px] overflow-y-auto themed-scrollbar">
        {commits.map((commit, i) => {
          const isHead = i === commits.length - 1;
          const selected =
            range?.source === "manual" && range.startSha === commit.sha;
          const subject = commit.commit.message.split("\n")[0];
          return (
            <DropdownMenuItem
              key={commit.sha}
              disabled={isHead}
              onClick={() =>
                void store.setDiffRange({
                  startSha: commit.sha,
                  source: "manual",
                })
              }
              className="text-xs items-start"
              title={isHead ? "This is the head commit" : `Since ${subject}`}
            >
              <code className="font-mono text-muted-foreground mr-2 shrink-0">
                {commit.sha.slice(0, 7)}
              </code>
              <span className="flex-1 truncate">{subject}</span>
              {selected && <Check className="w-3.5 h-3.5 ml-1.5 shrink-0" />}
            </DropdownMenuItem>
          );
        })}
      </div>
    </DropdownMenuContent>
  );

  if (primaryIsPicker) {
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{primary}</DropdownMenuTrigger>
        {menu}
      </DropdownMenu>
    );
  }

  return (
    <div className="flex items-center">
      {primary}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={cn(
              "px-1 py-1 text-xs rounded-r-md border-l transition-colors",
              active
                ? "bg-blue-600 text-white hover:bg-blue-700 border-blue-500"
                : "bg-blue-600/20 text-blue-600 dark:text-blue-400 hover:bg-blue-600/30 border-blue-600/30"
            )}
            title="Pick a commit to show changes since"
          >
            <span className="px-0.5">▾</span>
          </button>
        </DropdownMenuTrigger>
        {menu}
      </DropdownMenu>
    </div>
  );
});

/**
 * Banner above the diff while a range is active, or when a requested range
 * failed (force-push removed the start commit).
 */
export const DiffRangeBanner = memo(function DiffRangeBanner() {
  const store = usePRReviewStore();
  const range = usePRReviewSelector((s) => s.diffRange);
  const error = usePRReviewSelector((s) => s.diffRangeError);
  const commits = usePRReviewSelector((s) => s.commits);
  const fileCount = usePRReviewSelector((s) => s.files.length);
  const totalFiles = usePRReviewSelector((s) => s.allFiles.length);

  if (error) {
    return (
      <div className="shrink-0 bg-amber-500/10 border-b border-amber-500/20 px-4 py-2 flex items-center justify-between gap-3">
        <div className="text-sm text-amber-700 dark:text-amber-200 truncate">
          {error}
        </div>
        <button
          onClick={() => void store.clearDiffRange()}
          className="shrink-0 flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md bg-amber-500/20 text-amber-700 dark:text-amber-200 hover:bg-amber-500/30 transition-colors"
        >
          Dismiss
        </button>
      </div>
    );
  }

  if (!range) return null;

  const rangeCommits = commitsAfter(commits, range.startSha) ?? [];
  const n = rangeCommits.length;

  return (
    <div className="shrink-0 bg-blue-500/10 border-b border-blue-500/20 px-4 py-2 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-sm min-w-0">
        <History className="w-4 h-4 text-blue-500 shrink-0" />
        <span className="text-blue-700 dark:text-blue-200 truncate">
          <span className="font-medium">
            {range.source === "review"
              ? "Changes since your last review"
              : `Changes since ${range.startSha.slice(0, 7)}`}
          </span>
          <span className="text-blue-700/70 dark:text-blue-200/70 ml-1.5">
            – {n} {n === 1 ? "commit" : "commits"}, {fileCount} of {totalFiles}{" "}
            {totalFiles === 1 ? "file" : "files"}. Comments on the old side are
            disabled in this view.
          </span>
        </span>
      </div>
      <button
        onClick={() => void store.clearDiffRange()}
        className="shrink-0 flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md bg-blue-500/20 text-blue-700 dark:text-blue-200 hover:bg-blue-500/30 transition-colors"
      >
        <X className="w-3.5 h-3.5" />
        Show all changes
      </button>
    </div>
  );
});
