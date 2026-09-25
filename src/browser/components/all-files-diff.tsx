import { memo, useEffect, useMemo, useRef, useState } from "react";
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
import { usePRReviewSelector, usePRReviewStore } from "../contexts/pr-review";
import { parsePatchLines, type PatchLine } from "../lib/patch-lines";
import { isTestFile } from "../lib/test-file";
import type { PullRequestFile } from "@/api/types";

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
  const matchingLines = useMemo(() => {
    const result = new Set<string>();
    matches.forEach(({ fileIndex, lineIndex }) =>
      result.add(`${fileIndex}:${lineIndex}`)
    );
    return result;
  }, [matches]);

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

  useEffect(() => {
    virtualizer.measure();
  }, [estimatedHeights, virtualizer]);

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
          className="relative mx-4 my-4"
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
                className="absolute left-0 top-0 w-full pb-4"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <AllFileSection
                  file={file}
                  isViewed={viewedFiles.has(file.filename)}
                  fileIndex={item.index}
                  matchingLines={matchingLines}
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

const AllFileSection = memo(function AllFileSection({
  file,
  isViewed,
  fileIndex,
  matchingLines,
  activeLine,
}: {
  file: PullRequestFile;
  isViewed: boolean;
  fileIndex: number;
  matchingLines: Set<string>;
  activeLine: number | null;
}) {
  const store = usePRReviewStore();
  const lines = useMemo(
    () => (isViewed ? [] : parsePatchLines(file.patch ?? "")),
    [file.patch, isViewed]
  );

  return (
    <section className="border border-border rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 bg-muted/50 border-b border-border">
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
          {isViewed ? "Viewed" : "Mark as viewed"}
        </button>
      </div>
      {isViewed ? null : lines.length ? (
        <div className="font-mono text-xs overflow-x-auto [--code-added:theme(colors.green.500)] [--code-removed:theme(colors.orange.600)] diff-line-container">
          {lines.map((line, index) => (
            <div
              key={index}
              data-find-line={index}
              className={cn(
                matchingLines.has(`${fileIndex}:${index}`) &&
                  "outline outline-1 outline-yellow-400",
                activeLine === index &&
                  "relative z-10 outline-2 outline-yellow-500"
              )}
            >
              <AllFileLine line={line} />
            </div>
          ))}
        </div>
      ) : (
        <div className="p-4 text-sm text-muted-foreground">
          Binary file or file too large to display
        </div>
      )}
    </section>
  );
});

function AllFileLine({ line }: { line: PatchLine }) {
  if (line.type === "hunk") {
    return (
      <div className="h-5 px-2 whitespace-pre bg-blue-500/10 text-blue-400">
        {line.content}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "flex h-5 min-h-5 whitespace-pre-wrap box-border contain-layout diff-line-row"
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
      <span className="flex-1 whitespace-pre-wrap break-words pr-6 overflow-hidden pl-2">
        {line.content || " "}
      </span>
    </div>
  );
}
