import {
  Check,
  ChevronRight,
  CircleCheck,
  FileCode,
  Layers,
  TriangleAlert,
  X,
} from "lucide-react";
import { memo, useMemo } from "react";
import { cn } from "../cn";
import { usePRReviewSelector, usePRReviewStore } from "../contexts/pr-review";
import { Markdown } from "../ui/markdown";
import type { SemanticLayer, SemanticRange } from "@/semantic/schema";

// ============================================================================
// Semantic Sidebar (replaces the file tree while in semantic view mode)
// ============================================================================

interface SemanticSidebarProps {
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  onLayerSelect?: () => void;
}

export const SemanticSidebar = memo(function SemanticSidebar({
  mobileOpen,
  onMobileClose,
  onLayerSelect,
}: SemanticSidebarProps) {
  const store = usePRReviewStore();
  const review = usePRReviewSelector((s) => s.semanticReview);
  const selectedLayerId = usePRReviewSelector((s) => s.selectedLayerId);
  const reviewedLayers = usePRReviewSelector((s) => s.reviewedLayers);
  const pr = usePRReviewSelector((s) => s.pr);

  const totalLayers = useMemo(
    () => review?.cohorts.reduce((n, c) => n + c.layers.length, 0) ?? 0,
    [review]
  );
  const reviewedCount = useMemo(() => {
    if (!review) return 0;
    let n = 0;
    for (const c of review.cohorts) {
      for (const l of c.layers) {
        if (reviewedLayers.has(`${c.id}/${l.id}`)) n++;
      }
    }
    return n;
  }, [review, reviewedLayers]);

  if (!review) return null;

  const stale = review.headSha !== pr.head.sha;

  return (
    <aside
      className={cn(
        "w-72 border-r border-border flex flex-col overflow-hidden shrink-0 bg-background",
        "fixed inset-y-0 left-0 z-50 transition-transform duration-200 ease-in-out md:relative md:translate-x-0",
        mobileOpen ? "translate-x-0" : "-translate-x-full"
      )}
    >
      {/* Mobile close button */}
      <div className="flex items-center justify-between px-2 py-2 border-b border-border md:hidden">
        <span className="text-sm font-medium">Semantic review</span>
        <button
          onClick={onMobileClose}
          className="p-1 rounded hover:bg-muted transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Header */}
      <div className="px-3 pt-3 pb-2 border-b border-border">
        <div className="flex items-center gap-1.5 text-sm font-medium text-violet-400">
          <Layers className="w-4 h-4" />
          Semantic review
        </div>
        {stale && (
          <div className="mt-2 flex items-start gap-1.5 text-xs text-amber-400 bg-amber-500/10 rounded-md px-2 py-1.5">
            <TriangleAlert className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            <span>
              Out of date — the PR has new commits. Re-run from the header
              button.
            </span>
          </div>
        )}
        <p className="mt-2 text-xs text-muted-foreground line-clamp-4">
          {review.overview}
        </p>
      </div>

      {/* Cohort -> layer tree */}
      <div className="flex-1 overflow-y-auto themed-scrollbar py-1">
        {review.cohorts.map((cohort) => (
          <div key={cohort.id} className="mb-1">
            <div
              className="px-3 py-1.5 text-xs font-semibold text-foreground/90"
              title={cohort.summary}
            >
              {cohort.title}
            </div>
            {cohort.layers.map((layer, i) => {
              const key = `${cohort.id}/${layer.id}`;
              const isSelected = selectedLayerId === key;
              const isReviewed = reviewedLayers.has(key);
              return (
                <button
                  key={key}
                  onClick={() => {
                    store.selectSemanticLayer(key);
                    onLayerSelect?.();
                  }}
                  className={cn(
                    "w-full flex items-start gap-2 pl-4 pr-2 py-1.5 text-left text-xs transition-colors",
                    isSelected
                      ? "bg-violet-600/20 text-foreground"
                      : "hover:bg-muted/50",
                    isReviewed && !isSelected && "text-muted-foreground"
                  )}
                >
                  <span
                    className={cn(
                      "mt-px shrink-0",
                      isReviewed ? "text-green-500" : "text-muted-foreground/50"
                    )}
                  >
                    {isReviewed ? (
                      <CircleCheck className="w-3.5 h-3.5" />
                    ) : (
                      <span className="inline-block w-3.5 text-center font-mono">
                        {i + 1}
                      </span>
                    )}
                  </span>
                  <span className="min-w-0">
                    <span
                      className={cn(
                        "block truncate",
                        isReviewed &&
                          "line-through decoration-muted-foreground/50"
                      )}
                    >
                      {layer.title}
                    </span>
                    <span className="block text-muted-foreground truncate">
                      {layer.ranges.length} range
                      {layer.ranges.length !== 1 ? "s" : ""}
                      {" · "}
                      {new Set(layer.ranges.map((r) => r.file)).size} file
                      {new Set(layer.ranges.map((r) => r.file)).size !== 1
                        ? "s"
                        : ""}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>

      {/* Progress footer */}
      <div className="px-3 py-2 border-t border-border text-xs text-muted-foreground flex items-center justify-between">
        <span>
          {reviewedCount}/{totalLayers} layers reviewed
        </span>
        <button
          onClick={() => store.setViewMode("files")}
          className="text-violet-400 hover:underline"
        >
          Files view
        </button>
      </div>
    </aside>
  );
});

// ============================================================================
// Layer Bar (renders above the diff while a layer is selected)
// ============================================================================

export const SemanticLayerBar = memo(function SemanticLayerBar() {
  const store = usePRReviewStore();
  const selectedLayerId = usePRReviewSelector((s) => s.selectedLayerId);
  const reviewedLayers = usePRReviewSelector((s) => s.reviewedLayers);
  const selectedFile = usePRReviewSelector((s) => s.selectedFile);
  const warnings = usePRReviewSelector((s) => s.semanticWarnings);

  const found = selectedLayerId
    ? store.getSemanticLayer(selectedLayerId)
    : null;
  if (!found || !selectedLayerId) return null;

  const { cohort, layer } = found;
  const isReviewed = reviewedLayers.has(selectedLayerId);

  return (
    <div className="shrink-0 border-b border-border bg-violet-950/20 px-3 py-2 space-y-1.5">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-xs text-muted-foreground truncate shrink-0 max-w-[180px]">
          {cohort.title}
        </span>
        <ChevronRight className="w-3 h-3 text-muted-foreground shrink-0" />
        <span className="text-sm font-medium truncate flex-1 min-w-0">
          {layer.title}
        </span>
        <button
          onClick={() => store.toggleLayerReviewed(selectedLayerId)}
          className={cn(
            "flex items-center gap-1 px-2 py-0.5 text-xs rounded-md transition-colors shrink-0",
            isReviewed
              ? "bg-green-600/20 text-green-400 hover:bg-green-600/30"
              : "bg-muted text-muted-foreground hover:bg-muted/70"
          )}
          title="Mark layer reviewed (V)"
        >
          <Check className="w-3 h-3" />
          {isReviewed ? "Reviewed" : "Mark reviewed"}
          <span className="px-1 text-[10px] bg-background/40 rounded font-mono">
            V
          </span>
        </button>
      </div>

      <div className="text-xs text-muted-foreground [&_p]:my-0">
        <Markdown>{layer.summary}</Markdown>
      </div>

      <RangeChips layer={layer} selectedFile={selectedFile} />

      {warnings.length > 0 && (
        <div className="text-[11px] text-amber-400/80">
          {warnings.length} coverage warning
          {warnings.length !== 1 ? "s" : ""} from analysis (see "Uncovered
          changes" cohort)
        </div>
      )}
    </div>
  );
});

function RangeChips({
  layer,
  selectedFile,
}: {
  layer: SemanticLayer;
  selectedFile: string | null;
}) {
  const store = usePRReviewStore();

  const chips = useMemo(() => {
    const byFile = new Map<string, SemanticRange[]>();
    for (const range of layer.ranges) {
      const existing = byFile.get(range.file) ?? [];
      existing.push(range);
      byFile.set(range.file, existing);
    }
    return [...byFile.entries()];
  }, [layer]);

  return (
    <div className="flex flex-wrap gap-1">
      {chips.map(([file, ranges]) =>
        ranges.map((range, i) => {
          const name = file.split("/").pop() ?? file;
          const isCurrent = selectedFile === file;
          return (
            <button
              key={`${file}:${i}`}
              onClick={() => store.jumpToSemanticRange(range)}
              className={cn(
                "flex items-center gap-1 px-1.5 py-0.5 text-[11px] rounded font-mono transition-colors",
                isCurrent
                  ? "bg-violet-600/30 text-violet-300"
                  : "bg-muted/60 text-muted-foreground hover:bg-muted"
              )}
              title={
                range.summary ?? `${file} L${range.startLine}-${range.endLine}`
              }
            >
              <FileCode className="w-3 h-3" />
              {name}:{range.startLine}
              {range.endLine !== range.startLine ? `–${range.endLine}` : ""}
            </button>
          );
        })
      )}
    </div>
  );
}
