import { Check, GitCommitHorizontal, History, Loader2, X } from "lucide-react";
import { memo, useMemo, useState } from "react";
import { cn } from "../cn";
import { usePRReviewSelector, usePRReviewStore } from "../contexts/pr-review";
import {
  commitsAfter,
  commitsInRange,
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
 * - The dropdown can select both commit boundaries, or reset to the full PR.
 */
export const DiffRangeButton = memo(function DiffRangeButton() {
  const store = usePRReviewStore();
  const pr = usePRReviewSelector((s) => s.pr);
  const commits = usePRReviewSelector((s) => s.commits);
  const reviews = usePRReviewSelector((s) => s.reviews);
  const currentUser = usePRReviewSelector((s) => s.currentUser);
  const range = usePRReviewSelector((s) => s.diffRange);
  const loading = usePRReviewSelector((s) => s.diffRangeLoading);
  const [startSha, setStartSha] = useState("");
  const [endSha, setEndSha] = useState("");

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
  const rangeEndSha = range?.endSha ?? pr.head.sha;
  const rangeCommits = range
    ? commitsInRange(commits, range.startSha, rangeEndSha)
    : null;
  const draftStart = startSha || range?.startSha || commits[0]?.sha || "";
  const draftEnd = endSha || rangeEndSha;
  const startIndex = commits.findIndex((commit) => commit.sha === draftStart);
  const availableEnds = commits.slice(startIndex + 1);
  const selectedEnd = availableEnds.some((commit) => commit.sha === draftEnd)
    ? draftEnd
    : pr.head.sha;
  const shortRange = range?.endSha && range.endSha !== pr.head.sha;

  const label = loading
    ? "Loading…"
    : active
      ? range.source === "review"
        ? "Since your review"
        : shortRange
          ? `${range.startSha.slice(0, 7)}…${rangeEndSha.slice(0, 7)}`
          : `Since ${range.startSha.slice(0, 7)}`
      : sinceReview
        ? `${sinceReview.length} new ${sinceReview.length === 1 ? "commit" : "commits"}`
        : "Changes since…";

  const title = active
    ? `Showing ${rangeCommits?.length ?? "?"} commits from ${range.startSha.slice(0, 7)} through ${rangeEndSha.slice(0, 7)}. Click to show all changes.`
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

  const onPickerOpenChange = (open: boolean) => {
    if (open) {
      setStartSha(range?.startSha ?? "");
      setEndSha(range?.endSha ?? pr.head.sha);
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
        Show changes between commits
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
      <div className="px-2 py-1.5 space-y-2">
        <label className="block text-xs text-muted-foreground">
          Start after
          <select
            value={draftStart}
            onChange={(event) => {
              setStartSha(event.target.value);
              if (!isRangeAvailable(commits, event.target.value, selectedEnd)) {
                setEndSha(pr.head.sha);
              }
            }}
            onKeyDown={(event) => event.stopPropagation()}
            className="mt-1 block w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground"
          >
            {commits.slice(0, -1).map((commit) => (
              <option key={commit.sha} value={commit.sha}>
                {commit.sha.slice(0, 7)} ·{" "}
                {commit.commit.message.split("\n")[0]}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs text-muted-foreground">
          End at (included)
          <select
            value={selectedEnd}
            onChange={(event) => setEndSha(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
            className="mt-1 block w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground"
          >
            {availableEnds.map((commit) => (
              <option key={commit.sha} value={commit.sha}>
                {commit.sha.slice(0, 7)} ·{" "}
                {commit.commit.message.split("\n")[0]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <DropdownMenuItem
        disabled={
          loading || !isRangeAvailable(commits, draftStart, selectedEnd)
        }
        onClick={() =>
          void store.setDiffRange({
            startSha: draftStart,
            ...(selectedEnd === pr.head.sha ? {} : { endSha: selectedEnd }),
            source: "manual",
          })
        }
        className="text-xs font-medium"
      >
        <Check className="w-3.5 h-3.5 mr-1.5" />
        Show selected range
      </DropdownMenuItem>
    </DropdownMenuContent>
  );

  if (primaryIsPicker) {
    return (
      <DropdownMenu onOpenChange={onPickerOpenChange}>
        <DropdownMenuTrigger asChild>{primary}</DropdownMenuTrigger>
        {menu}
      </DropdownMenu>
    );
  }

  return (
    <div className="flex items-center">
      {primary}
      <DropdownMenu onOpenChange={onPickerOpenChange}>
        <DropdownMenuTrigger asChild>
          <button
            className={cn(
              "px-1 py-1 text-xs rounded-r-md border-l transition-colors",
              active
                ? "bg-blue-600 text-white hover:bg-blue-700 border-blue-500"
                : "bg-blue-600/20 text-blue-600 dark:text-blue-400 hover:bg-blue-600/30 border-blue-600/30"
            )}
            title="Pick a commit range"
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

  const endSha = range.endSha ?? commits.at(-1)?.sha ?? "";
  const rangeCommits = commitsInRange(commits, range.startSha, endSha) ?? [];
  const n = rangeCommits.length;

  return (
    <div className="shrink-0 bg-blue-500/10 border-b border-blue-500/20 px-4 py-2 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 text-sm min-w-0">
        <History className="w-4 h-4 text-blue-500 shrink-0" />
        <span className="text-blue-700 dark:text-blue-200 truncate">
          <span className="font-medium">
            {range.source === "review"
              ? "Changes since your last review"
              : range.endSha
                ? `Changes from ${range.startSha.slice(0, 7)} through ${range.endSha.slice(0, 7)}`
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
