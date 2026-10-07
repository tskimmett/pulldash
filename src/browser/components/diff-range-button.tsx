import { ChevronDown, History, Loader2, X } from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { cn } from "../cn";
import {
  getTimeAgo,
  usePRReviewSelector,
  usePRReviewStore,
} from "../contexts/pr-review";
import type { PRCommit } from "../contexts/github";
import {
  commitsAfter,
  commitsInRange,
  findLastReviewedSha,
  isRangeAvailable,
  rangeToSelection,
  selectionToRange,
} from "@/browser/lib/review-range";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";

/** "abc1234" or "abc1234…def5678" for the commits a range includes. */
function describeCommits(commits: PRCommit[]): string {
  const first = commits[0]?.sha.slice(0, 7) ?? "?";
  const last = commits.at(-1)?.sha.slice(0, 7) ?? "?";
  return commits.length === 1 ? first : `${first}…${last}`;
}

/**
 * Header control for narrowing the diff to a subset of the PR's commits.
 *
 * - When the viewer has a submitted review and newer commits exist, the
 *   button reads "N new commits" and one click shows only those changes.
 * - The picker lists every commit: click one, drag across several, or
 *   shift-click to extend the selection.
 */
export const DiffRangeButton = memo(function DiffRangeButton() {
  const store = usePRReviewStore();
  const pr = usePRReviewSelector((s) => s.pr);
  const commits = usePRReviewSelector((s) => s.commits);
  const reviews = usePRReviewSelector((s) => s.reviews);
  const currentUser = usePRReviewSelector((s) => s.currentUser);
  const range = usePRReviewSelector((s) => s.diffRange);
  const loading = usePRReviewSelector((s) => s.diffRangeLoading);
  const [open, setOpen] = useState(false);

  const lastReviewedSha = findLastReviewedSha(reviews, currentUser);
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

  const label = loading
    ? "Loading…"
    : active
      ? range.source === "review"
        ? "Since your review"
        : rangeCommits
          ? describeCommits(rangeCommits)
          : `Since ${range.startSha.slice(0, 7)}`
      : sinceReview
        ? `${sinceReview.length} new ${sinceReview.length === 1 ? "commit" : "commits"}`
        : "Commits…";

  const title = active
    ? `Showing ${rangeCommits?.length ?? "?"} of ${commits.length} commits. Click to show all changes.`
    : sinceReview
      ? `Show only the ${sinceReview.length} commits pushed since your last review`
      : "Show only some commits";

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
      <span className="hidden md:inline">{label}</span>
    </button>
  );

  const content = (
    <PopoverContent
      align="end"
      className="w-[560px] max-w-[calc(100vw-1rem)] p-0 overflow-hidden"
      // Keep the app's global shortcuts (j/k, etc.) from firing underneath.
      onKeyDown={(event) => {
        if (event.key !== "Escape" && event.key !== "Tab") {
          event.stopPropagation();
        }
      }}
    >
      {open && (
        <CommitRangePicker
          commits={commits}
          sinceReviewCount={sinceReview?.length ?? null}
          onClose={() => setOpen(false)}
        />
      )}
    </PopoverContent>
  );

  if (primaryIsPicker) {
    return (
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>{primary}</PopoverTrigger>
        {content}
      </Popover>
    );
  }

  return (
    <div className="flex items-stretch">
      {primary}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            className={cn(
              "flex items-center px-1 text-xs rounded-r-md border-l transition-colors",
              active
                ? "bg-blue-600 text-white hover:bg-blue-700 border-blue-500"
                : "bg-blue-600/20 text-blue-600 dark:text-blue-400 hover:bg-blue-600/30 border-blue-600/30"
            )}
            title="Pick commits to view"
          >
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        </PopoverTrigger>
        {content}
      </Popover>
    </div>
  );
});

type Selection = [number, number];

const EDGE_SCROLL_PX = 32;

function CommitRangePicker({
  commits,
  sinceReviewCount,
  onClose,
}: {
  commits: PRCommit[];
  sinceReviewCount: number | null;
  onClose: () => void;
}) {
  const store = usePRReviewStore();
  const range = usePRReviewSelector((s) => s.diffRange);
  const last = commits.length - 1;
  const current: Selection | null = range
    ? rangeToSelection(commits, range)
    : null;
  const [draft, setDraft] = useState<Selection | null>(current);
  const [cursor, setCursor] = useState(current?.[1] ?? last);
  const anchorRef = useRef(current?.[0] ?? last);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const listRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const frameRef = useRef(0);

  const apply = useCallback(
    (selection: Selection | null) => {
      onClose();
      if (!selection) return;
      const next = selectionToRange(commits, selection[0], selection[1]);
      if (next === null) void store.clearDiffRange();
      else if (next) void store.setDiffRange({ ...next, source: "manual" });
    },
    [commits, onClose, store]
  );

  const select = useCallback((index: number, extend: boolean) => {
    if (!extend) anchorRef.current = index;
    const anchor = anchorRef.current;
    setDraft([Math.min(anchor, index), Math.max(anchor, index)]);
    setCursor(index);
  }, []);

  // Start scrolled to the current selection, or the newest commits.
  useLayoutEffect(() => {
    listRef.current
      ?.querySelector(`[data-commit-index="${current?.[1] ?? last}"]`)
      ?.scrollIntoView({ block: "nearest" });
    listRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  const indexAt = (x: number, y: number): number | null => {
    const list = listRef.current;
    if (!list) return null;
    const rect = list.getBoundingClientRect();
    // Past the ends of the list, clamp to the first/last visible row.
    const clampedY = Math.min(Math.max(y, rect.top + 1), rect.bottom - 1);
    const clampedX = Math.min(Math.max(x, rect.left + 1), rect.right - 1);
    const row = document
      .elementFromPoint(clampedX, clampedY)
      ?.closest<HTMLElement>("[data-commit-index]");
    return row ? Number(row.dataset.commitIndex) : null;
  };

  // While dragging near an edge, keep scrolling and extending the selection.
  const tick = () => {
    const drag = dragRef.current;
    const list = listRef.current;
    if (!drag || !list) return;
    const rect = list.getBoundingClientRect();
    const delta =
      drag.y < rect.top + EDGE_SCROLL_PX
        ? -Math.ceil((rect.top + EDGE_SCROLL_PX - drag.y) / 4)
        : drag.y > rect.bottom - EDGE_SCROLL_PX
          ? Math.ceil((drag.y - rect.bottom + EDGE_SCROLL_PX) / 4)
          : 0;
    if (delta !== 0) list.scrollTop += delta;
    const index = indexAt(drag.x, drag.y);
    if (index !== null) select(index, true);
    frameRef.current = delta !== 0 ? requestAnimationFrame(tick) : 0;
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const index = indexAt(event.clientX, event.clientY);
    if (index === null) return;
    event.preventDefault();
    listRef.current?.focus({ preventScroll: true });
    select(index, event.shiftKey);
    dragRef.current = { x: event.clientX, y: event.clientY };

    const onMove = (move: globalThis.PointerEvent) => {
      dragRef.current = { x: move.clientX, y: move.clientY };
      if (!frameRef.current) frameRef.current = requestAnimationFrame(tick);
    };
    const onUp = () => {
      dragRef.current = null;
      cancelAnimationFrame(frameRef.current);
      frameRef.current = 0;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      apply(draftRef.current);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (event.key === "ArrowDown" || event.key === "j") next = cursor + 1;
    else if (event.key === "ArrowUp" || event.key === "k") next = cursor - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      apply(draftRef.current ?? [cursor, cursor]);
      return;
    } else return;
    event.preventDefault();
    next = Math.min(Math.max(next, 0), last);
    select(next, event.shiftKey);
    listRef.current
      ?.querySelector(`[data-commit-index="${next}"]`)
      ?.scrollIntoView({ block: "nearest" });
  };

  const isAll = !range;
  const isReview = range?.source === "review";

  return (
    <div className="flex flex-col">
      <div className="px-3 py-2 border-b border-border">
        <div className="text-sm font-semibold">Select commits to view</div>
        <div className="text-xs text-muted-foreground">
          Click a commit, or drag / shift-click to select a range
        </div>
      </div>
      <div className="p-1 border-b border-border">
        <PresetRow
          label="All commits"
          count={commits.length}
          active={isAll}
          onClick={() => {
            onClose();
            void store.clearDiffRange();
          }}
        />
        {sinceReviewCount !== null && (
          <PresetRow
            label="Changes since your last review"
            count={sinceReviewCount}
            active={isReview}
            onClick={() => {
              onClose();
              void store.showChangesSinceLastReview();
            }}
          />
        )}
      </div>
      <div
        ref={listRef}
        role="listbox"
        aria-multiselectable
        aria-label="Commits"
        aria-activedescendant={`commit-option-${cursor}`}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        className="max-h-[min(60vh,480px)] overflow-y-auto py-1 select-none outline-none"
      >
        {commits.map((commit, index) => (
          <CommitRow
            key={commit.sha}
            commit={commit}
            index={index}
            selected={draft !== null && index >= draft[0] && index <= draft[1]}
            selectionStart={draft?.[0] === index}
            selectionEnd={draft?.[1] === index}
            focused={cursor === index}
          />
        ))}
      </div>
    </div>
  );
}

function PresetRow({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        active ? "bg-blue-500/15 text-foreground" : "hover:bg-muted"
      )}
    >
      <span className={cn(active && "font-medium")}>{label}</span>
      <span className="text-xs text-muted-foreground">
        {count} {count === 1 ? "commit" : "commits"}
      </span>
    </button>
  );
}

const CommitRow = memo(function CommitRow({
  commit,
  index,
  selected,
  selectionStart,
  selectionEnd,
  focused,
}: {
  commit: PRCommit;
  index: number;
  selected: boolean;
  selectionStart: boolean;
  selectionEnd: boolean;
  focused: boolean;
}) {
  const author = commit.author?.login ?? commit.commit.author?.name;
  const date = commit.commit.author?.date;
  return (
    <div
      id={`commit-option-${index}`}
      role="option"
      aria-selected={selected}
      data-commit-index={index}
      className={cn(
        "relative mx-1 flex cursor-pointer items-start gap-3 px-3 py-1.5",
        selected
          ? "bg-blue-500/15"
          : focused
            ? "bg-muted/70 rounded-md"
            : "hover:bg-muted/50 rounded-md",
        selected && selectionStart && "rounded-t-md",
        selected && selectionEnd && "rounded-b-md",
        selected && focused && "ring-1 ring-inset ring-blue-500/50"
      )}
    >
      {selected && (
        <span
          className={cn(
            "absolute left-0 top-0 bottom-0 w-0.5 bg-blue-500",
            selectionStart && "top-1",
            selectionEnd && "bottom-1"
          )}
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">
          {commit.commit.message.split("\n")[0]}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {author}
          {date && ` committed ${getTimeAgo(new Date(date))}`}
        </div>
      </div>
      <code className="shrink-0 pt-0.5 text-xs text-muted-foreground">
        {commit.sha.slice(0, 7)}
      </code>
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
              : n === 1
                ? `Changes in ${describeCommits(rangeCommits)}`
                : n > 1
                  ? `Changes from ${rangeCommits[0]!.sha.slice(0, 7)} through ${rangeCommits[n - 1]!.sha.slice(0, 7)}`
                  : `Changes since ${range.startSha.slice(0, 7)}`}
          </span>
          <span className="text-blue-700/70 dark:text-blue-200/70 ml-1.5">
            – {n} {n === 1 ? "commit" : "commits"}, {fileCount}
            {/* A range can touch files the PR's net diff doesn't */}
            {fileCount <= totalFiles ? ` of ${totalFiles}` : ""}{" "}
            {(fileCount <= totalFiles ? totalFiles : fileCount) === 1
              ? "file"
              : "files"}
            . Comments on the old side are disabled in this view.
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
