import { useFindHighlights } from "../lib/find-highlight";
import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Check,
  ChevronDown,
  ChevronUp,
  FileCode,
  Search,
  X,
} from "lucide-react";
import { cn } from "../cn";
import {
  usePRReviewSelector,
  usePRReviewStore,
  visibleComments,
  type LocalPendingComment,
} from "../contexts/pr-review";
import { diffService } from "../lib/diff";
import { parsePatchLines, type PatchLine } from "../lib/patch-lines";
import { isTestFile } from "../lib/test-file";
import type { PullRequestFile, ReviewComment } from "@/api/types";
import {
  CommentThread,
  InlineCommentForm,
  PendingCommentItem,
} from "./pr-review";

const highlightedPatchCache = new WeakMap<PullRequestFile, string[]>();

export const AllFilesDiff = memo(function AllFilesDiff() {
  const store = usePRReviewStore();
  const prFiles = usePRReviewSelector((s) => s.files);
  const hideTestFiles = usePRReviewSelector((s) => s.hideTestFiles);
  const files = useMemo(
    () =>
      hideTestFiles ? prFiles.filter((f) => !isTestFile(f.filename)) : prFiles,
    [prFiles, hideTestFiles]
  );
  const selectedFile = usePRReviewSelector((s) => s.selectedFile);
  const viewedFiles = usePRReviewSelector((s) => s.viewedFiles);
  const scrollRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findIndex, setFindIndex] = useState(0);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "f")
        return;
      const target = event.target as HTMLElement;
      if (
        target !== findInputRef.current &&
        target.closest("input, textarea, [contenteditable='true']")
      )
        return;
      event.preventDefault();
      setFindOpen(true);
      requestAnimationFrame(() => findInputRef.current?.select());
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const searchableLines = useMemo(
    () =>
      findOpen
        ? files.map((file) =>
            viewedFiles.has(file.filename)
              ? []
              : parsePatchLines(file.patch ?? "").map((line) =>
                  line.content.toLocaleLowerCase()
                )
          )
        : [],
    [files, viewedFiles, findOpen]
  );

  const matches = useMemo(() => {
    const needle = findQuery.toLocaleLowerCase();
    if (!needle) return [];
    const result: { fileIndex: number; lineIndex: number }[] = [];
    searchableLines.forEach((lines, fileIndex) => {
      lines.forEach((content, lineIndex) => {
        if (content.includes(needle)) result.push({ fileIndex, lineIndex });
      });
    });
    return result;
  }, [searchableLines, findQuery]);
  const activeIndex = Math.min(findIndex, matches.length - 1);
  const activeMatch = matches[activeIndex];
  useFindHighlights(scrollRef, findQuery, findOpen);

  const stepFind = (direction: number) => {
    if (!matches.length) return;
    setFindIndex(
      (index) => (index + direction + matches.length) % matches.length
    );
  };
  const estimatedHeights = useMemo(
    () =>
      files.map((file) =>
        viewedFiles.has(file.filename)
          ? 60
          : 90 + Math.min(file.patch?.split("\n").length ?? 1, 500) * 20
      ),
    [files, viewedFiles]
  );

  const virtualizer = useVirtualizer({
    count: files.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => files[index].filename,
    estimateSize: (index) => estimatedHeights[index],
    overscan: 2,
  });

  // No virtualizer.measure() on estimate changes: it drops every measured row
  // height, and mounted rows only re-report when they resize, so unchanged
  // rows would fall back to estimates and overlap. Rows that change size
  // (e.g. toggled viewed) report via ResizeObserver, which also refreshes
  // estimates for rows not measured yet.
  useEffect(() => {
    const index = files.findIndex((file) => file.filename === selectedFile);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "start" });
  }, [files, selectedFile, virtualizer]);

  useEffect(() => {
    if (!findOpen || !activeMatch) return;
    virtualizer.scrollToIndex(activeMatch.fileIndex, { align: "start" });
    const frame = requestAnimationFrame(() => {
      const row = scrollRef.current?.querySelector<HTMLElement>(
        `[data-find-file="${activeMatch.fileIndex}"] [data-find-line="${activeMatch.lineIndex}"]`
      );
      if (row) {
        row.scrollIntoView({ block: "center" });
      } else {
        const file = virtualizer.measurementsCache[activeMatch.fileIndex];
        if (file) {
          virtualizer.scrollToOffset(
            file.start + 40 + activeMatch.lineIndex * 20,
            {
              align: "center",
            }
          );
        }
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [findOpen, activeMatch, virtualizer]);

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      {findOpen && (
        <div className="flex items-center gap-2 border-b border-border bg-background px-3 py-1.5">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            ref={findInputRef}
            autoFocus
            aria-label="Find in diff"
            placeholder="Find in diff"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none"
            value={findQuery}
            onChange={(event) => {
              setFindQuery(event.target.value);
              setFindIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                stepFind(event.shiftKey ? -1 : 1);
              } else if (event.key === "Escape") {
                event.preventDefault();
                setFindOpen(false);
                setFindQuery("");
                scrollRef.current?.focus();
              }
            }}
          />
          <span className="text-xs tabular-nums text-muted-foreground">
            {findQuery
              ? `${matches.length ? activeIndex + 1 : 0} / ${matches.length}`
              : ""}
          </span>
          <button
            type="button"
            aria-label="Previous match"
            disabled={!matches.length}
            onClick={() => stepFind(-1)}
            className="p-1 disabled:opacity-40"
          >
            <ChevronUp className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="Next match"
            disabled={!matches.length}
            onClick={() => stepFind(1)}
            className="p-1 disabled:opacity-40"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label="Close find"
            onClick={() => {
              setFindOpen(false);
              setFindQuery("");
            }}
            className="p-1"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      <div
        ref={scrollRef}
        tabIndex={-1}
        className="flex-1 min-h-0 overflow-auto diff-scrollbar"
      >
        <div
          className="relative mx-2 my-2 md:mx-4 md:my-4"
          style={{ height: virtualizer.getTotalSize() }}
        >
          {virtualizer.getVirtualItems().map((item) => {
            const file = files[item.index];
            return (
              <div
                key={item.key}
                data-index={item.index}
                data-find-file={item.index}
                ref={virtualizer.measureElement}
                className="absolute left-0 top-0 w-full pb-8"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <AllFileSection
                  file={file}
                  isViewed={viewedFiles.has(file.filename)}
                  fileIndex={item.index}
                  activeLine={
                    activeMatch?.fileIndex === item.index
                      ? activeMatch.lineIndex
                      : null
                  }
                />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});

// Diffs shorter than roughly a screen (~20px per line) skip the footer bar
const FOOTER_MIN_LINES = 40;

// Header above the diff, repeated below it so a file can be marked viewed
// without scrolling back up.
function FileBar({
  file,
  isViewed,
  footer,
}: {
  file: PullRequestFile;
  isViewed: boolean;
  footer?: boolean;
}) {
  const store = usePRReviewStore();
  return (
    <div
      className={cn(
        "flex items-center gap-2 px-3 py-2 bg-muted/50 border-foreground/15",
        footer ? "border-t" : "border-b"
      )}
    >
      <FileCode className="w-4 h-4 text-muted-foreground shrink-0" />
      <button
        className="font-mono text-sm font-medium truncate text-left hover:text-blue-400"
        onClick={() => {
          store.selectFile(file.filename);
          store.setFileLayoutMode("single");
        }}
        title="Open single file view"
      >
        {file.filename}
      </button>
      <span className="text-xs text-muted-foreground shrink-0">
        <span className="text-green-500">+{file.additions}</span>{" "}
        <span className="text-red-500">−{file.deletions}</span>
      </span>
      <button
        className={cn(
          "ml-auto flex items-center gap-1 px-2 py-1 text-xs rounded shrink-0",
          isViewed
            ? "bg-green-500/20 text-green-500"
            : "bg-muted text-muted-foreground hover:text-foreground"
        )}
        onClick={() => store.toggleViewed(file.filename)}
        aria-label={`${isViewed ? "Unmark" : "Mark"} ${file.filename} as viewed`}
      >
        <Check className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">
          {isViewed ? "Viewed" : "Mark as viewed"}
        </span>
      </button>
    </div>
  );
}

const AllFileSection = memo(function AllFileSection({
  file,
  isViewed,
  fileIndex,
  activeLine,
}: {
  file: PullRequestFile;
  isViewed: boolean;
  fileIndex: number;
  activeLine: number | null;
}) {
  const store = usePRReviewStore();
  const lines = useMemo(
    () => (isViewed ? [] : parsePatchLines(file.patch ?? "")),
    [file.patch, isViewed]
  );
  const allComments = usePRReviewSelector((s) => s.comments);
  const allPending = usePRReviewSelector((s) => s.pendingComments);
  const hideResolved = usePRReviewSelector((s) => s.hideResolvedComments);
  const commenting = usePRReviewSelector((s) =>
    s.commentingOnLine?.path === file.filename ? s.commentingOnLine : null
  );
  const focusedCommentId = usePRReviewSelector((s) => s.focusedCommentId);
  const focusedPendingCommentId = usePRReviewSelector(
    (s) => s.focusedPendingCommentId
  );
  const editingCommentId = usePRReviewSelector((s) => s.editingCommentId);
  const editingPendingCommentId = usePRReviewSelector(
    (s) => s.editingPendingCommentId
  );
  const replyingToCommentId = usePRReviewSelector((s) => s.replyingToCommentId);

  // Keyed by `${side}:${line}` so old-side and new-side comments stay apart.
  const threadsByKey = useMemo(() => {
    const roots = new Map<number, ReviewComment[]>();
    const result = new Map<string, ReviewComment[][]>();
    const fileComments = visibleComments(
      allComments.filter((c) => c.path === file.filename),
      hideResolved
    );
    for (const c of fileComments) {
      if (c.in_reply_to_id) continue;
      const line = c.line ?? c.original_line;
      if (!line) continue;
      const thread = [c];
      roots.set(c.id, thread);
      const key = `${c.side === "LEFT" ? "LEFT" : "RIGHT"}:${line}`;
      result.set(key, [...(result.get(key) ?? []), thread]);
    }
    for (const c of fileComments) {
      if (c.in_reply_to_id) roots.get(c.in_reply_to_id)?.push(c);
    }
    return result;
  }, [allComments, file.filename, hideResolved]);
  const pendingByKey = useMemo(() => {
    const result = new Map<string, LocalPendingComment[]>();
    for (const c of allPending) {
      if (c.path !== file.filename) continue;
      const key = `${c.side ?? "RIGHT"}:${c.line}`;
      result.set(key, [...(result.get(key) ?? []), c]);
    }
    return result;
  }, [allPending, file.filename]);
  const [highlighted, setHighlighted] = useState<{
    file: PullRequestFile;
    lines: string[];
  } | null>(() => {
    const cached = highlightedPatchCache.get(file);
    return cached ? { file, lines: cached } : null;
  });
  const highlightedLines =
    highlighted?.file === file
      ? highlighted.lines
      : highlightedPatchCache.get(file);

  useEffect(() => {
    const cached = highlightedPatchCache.get(file);
    if (cached) {
      setHighlighted({ file, lines: cached });
      return;
    }
    if (isViewed || !lines.length) return;

    let active = true;
    const codeLines = lines.filter((line) => line.type !== "hunk");
    if (!codeLines.length) return;
    diffService
      .highlightLines(
        codeLines.map((line) => line.content).join("\n"),
        file.filename,
        1,
        codeLines.length
      )
      .then((result) => {
        const highlighted = result.map((line) => line.content[0].html);
        highlightedPatchCache.set(file, highlighted);
        if (active) setHighlighted({ file, lines: highlighted });
      })
      .catch(() => {
        // Keep plain text visible if highlighting fails.
      });
    return () => {
      active = false;
    };
  }, [file, isViewed, lines]);

  let codeLineIndex = 0;

  return (
    <section className="border border-foreground/15 rounded-lg overflow-hidden">
      <FileBar file={file} isViewed={isViewed} />
      {isViewed ? null : lines.length ? (
        <div className="font-mono text-xs overflow-x-auto [--code-added:theme(colors.green.500)] [--code-removed:theme(colors.orange.600)] diff-line-container">
          {lines.map((line, index) => {
            const side = line.type === "delete" ? "LEFT" : "RIGHT";
            const lineNum = side === "LEFT" ? line.oldLine : line.newLine;
            const key = `${side}:${lineNum}`;
            return (
              <Fragment key={index}>
                <div
                  data-find-line={index}
                  data-find-active={activeLine === index ? "" : undefined}
                >
                  <AllFileLine
                    line={line}
                    html={
                      line.type === "hunk"
                        ? undefined
                        : highlightedLines?.[codeLineIndex++]
                    }
                    onComment={
                      lineNum
                        ? () =>
                            store.startCommenting(
                              lineNum,
                              undefined,
                              side === "LEFT" ? "old" : "new",
                              file.filename
                            )
                        : undefined
                    }
                  />
                </div>
                {lineNum &&
                  pendingByKey
                    .get(key)
                    ?.map((comment) => (
                      <PendingCommentItem
                        key={comment.id}
                        comment={comment}
                        isFocused={focusedPendingCommentId === comment.id}
                        isEditing={editingPendingCommentId === comment.id}
                      />
                    ))}
                {lineNum &&
                  threadsByKey
                    .get(key)
                    ?.map((thread) => (
                      <CommentThread
                        key={thread[0].id}
                        comments={thread}
                        focusedCommentId={focusedCommentId}
                        editingCommentId={editingCommentId}
                        replyingToCommentId={replyingToCommentId}
                      />
                    ))}
                {lineNum &&
                  commenting?.line === lineNum &&
                  commenting.side === side && (
                    <InlineCommentForm
                      path={file.filename}
                      line={commenting.line}
                      startLine={commenting.startLine}
                      side={commenting.side}
                    />
                  )}
              </Fragment>
            );
          })}
        </div>
      ) : (
        <div className="p-4 text-sm text-muted-foreground">
          Binary file or file too large to display
        </div>
      )}
      {!isViewed && lines.length >= FOOTER_MIN_LINES && (
        <FileBar file={file} isViewed={isViewed} footer />
      )}
    </section>
  );
});

function AllFileLine({
  line,
  html,
  onComment,
}: {
  line: PatchLine;
  html?: string;
  onComment?: () => void;
}) {
  if (line.type === "hunk") {
    return (
      <div className="h-5 px-2 whitespace-pre bg-blue-500/10 text-blue-400">
        {line.content}
      </div>
    );
  }

  return (
    <div
      onClick={() => {
        if (!window.getSelection()?.toString()) onComment?.();
      }}
      className={cn(
        "flex min-h-5 whitespace-pre-wrap box-border contain-layout diff-line-row",
        onComment && "cursor-pointer"
      )}
      style={
        line.type === "normal"
          ? undefined
          : {
              background: `linear-gradient(var(--diff-line-${line.type === "insert" ? "insert" : "delete"}-bg), var(--diff-line-${line.type === "insert" ? "insert" : "delete"}-bg))`,
              backgroundSize: "100% calc(100% + 2px)",
              backgroundRepeat: "no-repeat",
            }
      }
    >
      <span
        className={cn(
          "w-1 shrink-0 border-l-[3px] border-transparent",
          line.type === "insert" && "!border-[var(--code-added)]/60",
          line.type === "delete" && "!border-[var(--code-removed)]/80"
        )}
      />
      <span className="w-10 shrink-0 tabular-nums text-right opacity-50 pr-2 text-xs select-none pt-0.5">
        {line.oldLine}
      </span>
      <span className="w-10 shrink-0 tabular-nums text-right opacity-50 pr-2 text-xs select-none pt-0.5 border-r border-border/30">
        {line.newLine}
      </span>
      <span
        data-find-code
        className="flex-1 min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] leading-5 pr-6 pointer-coarse:pr-2 pl-2"
      >
        {html === undefined ? (
          line.content || " "
        ) : (
          <span dangerouslySetInnerHTML={{ __html: html || " " }} />
        )}
      </span>
    </div>
  );
}
