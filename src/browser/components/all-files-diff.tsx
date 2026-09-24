import { memo, useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, FileCode } from "lucide-react";
import { cn } from "../cn";
import { usePRReviewSelector, usePRReviewStore } from "../contexts/pr-review";
import { parsePatchLines, type PatchLine } from "../lib/patch-lines";
import type { PullRequestFile } from "@/api/types";

export const AllFilesDiff = memo(function AllFilesDiff() {
  const store = usePRReviewStore();
  const files = usePRReviewSelector((s) => s.files);
  const selectedFile = usePRReviewSelector((s) => s.selectedFile);
  const viewedFiles = usePRReviewSelector((s) => s.viewedFiles);
  const scrollRef = useRef<HTMLDivElement>(null);
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

  return (
    <div
      ref={scrollRef}
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
              ref={virtualizer.measureElement}
              className="absolute left-0 top-0 w-full pb-4"
              style={{ transform: `translateY(${item.start}px)` }}
            >
              <AllFileSection
                file={file}
                isViewed={viewedFiles.has(file.filename)}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
});

const AllFileSection = memo(function AllFileSection({
  file,
  isViewed,
}: {
  file: PullRequestFile;
  isViewed: boolean;
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
            <AllFileLine key={index} line={line} />
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
