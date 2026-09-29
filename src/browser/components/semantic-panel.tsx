import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  Layers,
  TriangleAlert,
  X,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../cn";
import {
  useCommentCountsByFile,
  useFileCopyActions,
  usePendingCommentCountsByFile,
  usePRReviewSelector,
  usePRReviewStore,
} from "../contexts/pr-review";
import { Markdown } from "../ui/markdown";
import { FileRow, FILE_TREE_ROW_HEIGHT } from "./file-tree-row";
import { MermaidDiagram } from "./mermaid-diagram";
import {
  SidebarResizeHandle,
  useSidebarWidth,
} from "@/browser/lib/sidebar-width";
import type { PullRequestFile } from "@/api/types";
import { layerFilesInOrder, type LayerFileEntry } from "@/semantic/layer-files";
import type { SemanticCohort, SemanticLayer } from "@/semantic/schema";

// ============================================================================
// Semantic Sidebar (replaces the file tree while in semantic view mode)
// ============================================================================

interface SemanticSidebarProps {
  mobileOpen?: boolean;
  onMobileClose?: () => void;
  /** Fired whenever a click changes what the diff panel shows (mobile drawer close). */
  onLayerSelect?: () => void;
}

const layerKeyOf = (cohort: SemanticCohort, layer: SemanticLayer) =>
  `${cohort.id}/${layer.id}`;

export const SemanticSidebar = memo(function SemanticSidebar({
  mobileOpen,
  onMobileClose,
  onLayerSelect,
}: SemanticSidebarProps) {
  const store = usePRReviewStore();
  const review = usePRReviewSelector((s) => s.semanticReview);
  const selectedLayerId = usePRReviewSelector((s) => s.selectedLayerId);
  const reviewedLayers = usePRReviewSelector((s) => s.reviewedLayers);
  const selectedFile = usePRReviewSelector((s) => s.selectedFile);
  const viewedFiles = usePRReviewSelector((s) => s.viewedFiles);
  const files = usePRReviewSelector((s) => s.files);
  const pr = usePRReviewSelector((s) => s.pr);
  const commentCounts = useCommentCountsByFile();
  const pendingCommentCounts = usePendingCommentCountsByFile();
  const { copyDiff, copyFile, copyMainVersion } = useFileCopyActions();

  const fileByName = useMemo(
    () => new Map(files.map((f) => [f.filename, f])),
    [files]
  );

  /** layerKey -> files of that layer in range order (PR files only). */
  const layerEntries = useMemo(() => {
    const map = new Map<string, LayerFileEntry[]>();
    if (!review) return map;
    const present = new Set(fileByName.keys());
    for (const cohort of review.cohorts) {
      for (const layer of cohort.layers) {
        map.set(layerKeyOf(cohort, layer), layerFilesInOrder(layer, present));
      }
    }
    return map;
  }, [review, fileByName]);

  const totalLayers = useMemo(
    () => review?.cohorts.reduce((n, c) => n + c.layers.length, 0) ?? 0,
    [review]
  );
  const reviewedCount = useMemo(() => {
    if (!review) return 0;
    let n = 0;
    for (const c of review.cohorts) {
      for (const l of c.layers) {
        if (reviewedLayers.has(layerKeyOf(c, l))) n++;
      }
    }
    return n;
  }, [review, reviewedLayers]);

  // Collapsed cohort ids / layer keys. Empty set = everything expanded, so a
  // freshly loaded review needs no seeding (unlike the file tree's expanded set).
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggleCollapsed = useCallback((id: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  // j/k and the file-header arrows can land on a layer inside a collapsed
  // group; reveal it so the selection is always visible.
  useEffect(() => {
    if (!selectedLayerId) return;
    const cohortId = selectedLayerId.slice(0, selectedLayerId.indexOf("/"));
    setCollapsed((prev) => {
      if (!prev.has(selectedLayerId) && !prev.has(cohortId)) return prev;
      const next = new Set(prev);
      next.delete(selectedLayerId);
      next.delete(cohortId);
      return next;
    });
  }, [selectedLayerId]);

  // Keep the selected file row in view (same guard pattern as the file tree).
  const listRef = useRef<HTMLDivElement>(null);
  const lastScrolledRef = useRef<string | null>(null);
  useEffect(() => {
    const key = `${selectedLayerId}|${selectedFile}`;
    if (lastScrolledRef.current === key) return;
    const el = listRef.current?.querySelector<HTMLElement>("[data-selected]");
    if (!el) return;
    lastScrolledRef.current = key;
    el.scrollIntoView({ block: "nearest" });
  }, [selectedLayerId, selectedFile, collapsed]);

  const sidebarWidth = useSidebarWidth();

  if (!review) return null;

  const stale = review.headSha !== pr.head.sha;

  return (
    <aside
      className={cn(
        "max-w-[85vw] border-r border-border flex flex-col overflow-hidden shrink-0 bg-background",
        "fixed inset-y-0 left-0 z-50 transition-transform duration-200 ease-in-out md:relative md:translate-x-0",
        mobileOpen ? "translate-x-0" : "-translate-x-full"
      )}
      style={{ width: sidebarWidth }}
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
        <div className="flex items-center gap-1.5 text-sm font-medium text-violet-600 dark:text-violet-400">
          <Layers className="w-4 h-4" />
          Semantic review
        </div>
        {stale && (
          <div className="mt-2 flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400 bg-amber-500/10 rounded-md px-2 py-1.5">
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

      {/* Cohort -> layer -> file tree */}
      <div
        ref={listRef}
        className="flex-1 overflow-y-auto themed-scrollbar py-1"
      >
        {review.cohorts.map((cohort) => {
          const cohortCollapsed = collapsed.has(cohort.id);
          return (
            <div key={cohort.id} className="mb-1">
              <button
                onClick={() => toggleCollapsed(cohort.id)}
                className="w-full flex items-center gap-1 px-2 text-left text-[13px] font-semibold text-foreground/90 hover:bg-muted/50 transition-colors"
                style={{ height: FILE_TREE_ROW_HEIGHT }}
                title={cohort.summary}
              >
                <Chevron open={!cohortCollapsed} />
                <span className="truncate">{cohort.title}</span>
              </button>
              {!cohortCollapsed &&
                cohort.layers.map((layer, i) => {
                  const key = layerKeyOf(cohort, layer);
                  return (
                    <LayerGroup
                      key={key}
                      layerKey={key}
                      layer={layer}
                      index={i}
                      entries={layerEntries.get(key) ?? []}
                      fileByName={fileByName}
                      isSelectedLayer={selectedLayerId === key}
                      selectedFile={selectedFile}
                      isReviewed={reviewedLayers.has(key)}
                      isCollapsed={collapsed.has(key)}
                      viewedFiles={viewedFiles}
                      commentCounts={commentCounts}
                      pendingCommentCounts={pendingCommentCounts}
                      onToggleCollapsed={toggleCollapsed}
                      onSelectLayer={() => {
                        store.selectSemanticLayer(key);
                        onLayerSelect?.();
                      }}
                      onSelectFile={(entry) => {
                        store.jumpToSemanticRange(entry.ranges[0], key);
                        onLayerSelect?.();
                      }}
                      onToggleViewed={store.toggleViewed}
                      onCopyDiff={copyDiff}
                      onCopyFile={copyFile}
                      onCopyMainVersion={copyMainVersion}
                    />
                  );
                })}
            </div>
          );
        })}
      </div>

      {/* Progress footer */}
      <div className="px-3 py-2 border-t border-border text-xs text-muted-foreground flex items-center justify-between">
        <span>
          {reviewedCount}/{totalLayers} layers reviewed
        </span>
        <button
          onClick={() => store.setViewMode("files")}
          className="text-violet-600 dark:text-violet-400 hover:underline"
        >
          Files view
        </button>
      </div>
      <SidebarResizeHandle />
    </aside>
  );
});

function Chevron({ open }: { open: boolean }) {
  return open ? (
    <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
  ) : (
    <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
  );
}

interface LayerGroupProps {
  layerKey: string;
  layer: SemanticLayer;
  index: number;
  entries: LayerFileEntry[];
  fileByName: Map<string, PullRequestFile>;
  isSelectedLayer: boolean;
  selectedFile: string | null;
  isReviewed: boolean;
  isCollapsed: boolean;
  viewedFiles: Set<string>;
  commentCounts: Record<string, number>;
  pendingCommentCounts: Record<string, number>;
  onToggleCollapsed: (id: string) => void;
  onSelectLayer: () => void;
  onSelectFile: (entry: LayerFileEntry) => void;
  onToggleViewed: (filename: string) => void;
  onCopyDiff: (filename: string) => void;
  onCopyFile: (filename: string) => void;
  onCopyMainVersion: (filename: string) => void;
}

/** One layer row plus its file rows. Memoized so a selection change only re-renders the affected layers. */
const LayerGroup = memo(function LayerGroup({
  layerKey,
  layer,
  index,
  entries,
  fileByName,
  isSelectedLayer,
  selectedFile,
  isReviewed,
  isCollapsed,
  viewedFiles,
  commentCounts,
  pendingCommentCounts,
  onToggleCollapsed,
  onSelectLayer,
  onSelectFile,
  onToggleViewed,
  onCopyDiff,
  onCopyFile,
  onCopyMainVersion,
}: LayerGroupProps) {
  return (
    <>
      <button
        onClick={onSelectLayer}
        className={cn(
          "w-full flex items-start gap-1 pr-2 py-1.5 text-left text-[13px] transition-colors",
          isSelectedLayer
            ? "bg-violet-600/20 text-foreground"
            : "hover:bg-muted/50",
          isReviewed && !isSelectedLayer && "text-muted-foreground"
        )}
        style={{ paddingLeft: 12 + 8 }}
      >
        <span
          role="button"
          aria-label={isCollapsed ? "Expand layer" : "Collapse layer"}
          onClick={(e) => {
            e.stopPropagation();
            onToggleCollapsed(layerKey);
          }}
          className="mt-0.5 flex items-center shrink-0 rounded hover:bg-muted"
        >
          <Chevron open={!isCollapsed} />
        </span>
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
              {index + 1}
            </span>
          )}
        </span>
        <span className="min-w-0">
          <span
            className={cn(
              "block truncate",
              isReviewed && "line-through decoration-muted-foreground/50"
            )}
          >
            {layer.title}
          </span>
          <span className="block text-xs text-muted-foreground truncate">
            {layer.ranges.length} range
            {layer.ranges.length !== 1 ? "s" : ""}
            {" · "}
            {entries.length} file{entries.length !== 1 ? "s" : ""}
          </span>
        </span>
      </button>

      {!isCollapsed &&
        entries.map((entry) => {
          const file = fileByName.get(entry.file);
          if (!file) return null;
          const isSelected = isSelectedLayer && selectedFile === entry.file;
          return (
            <div
              key={entry.file}
              style={{ height: FILE_TREE_ROW_HEIGHT }}
              data-selected={isSelected || undefined}
            >
              <FileRow
                file={file}
                name={entry.file.split("/").pop() ?? entry.file}
                title={entry.file}
                depth={2}
                isSelected={isSelected}
                isViewed={viewedFiles.has(entry.file)}
                commentCount={commentCounts[entry.file] ?? 0}
                pendingCount={pendingCommentCounts[entry.file] ?? 0}
                trailing={
                  entry.ranges.length > 1 ? (
                    <span
                      className="text-[10px] text-muted-foreground tabular-nums"
                      title={`${entry.ranges.length} ranges in this layer`}
                    >
                      ×{entry.ranges.length}
                    </span>
                  ) : undefined
                }
                onClick={() => onSelectFile(entry)}
                onToggleViewed={() => onToggleViewed(entry.file)}
                onCopyDiff={() => onCopyDiff(entry.file)}
                onCopyFile={() => onCopyFile(entry.file)}
                onCopyMainVersion={() => onCopyMainVersion(entry.file)}
              />
            </div>
          );
        })}
    </>
  );
});

// ============================================================================
// Layer Bar (renders above the diff while a layer is selected)
// ============================================================================

export const SemanticLayerBar = memo(function SemanticLayerBar() {
  const store = usePRReviewStore();
  const selectedLayerId = usePRReviewSelector((s) => s.selectedLayerId);
  const reviewedLayers = usePRReviewSelector((s) => s.reviewedLayers);
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
              ? "bg-green-600/20 text-green-600 dark:text-green-400 hover:bg-green-600/30"
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

      {layer.diagram && (
        <LayerDiagram
          key={selectedLayerId}
          mermaid={layer.diagram.mermaid}
          kind={layer.diagram.kind}
        />
      )}

      {warnings.length > 0 && (
        <div className="text-[11px] text-amber-600 dark:text-amber-400/80">
          {warnings.length} coverage warning
          {warnings.length !== 1 ? "s" : ""} from analysis (see "Uncovered
          changes" cohort)
        </div>
      )}
    </div>
  );
});

/** Collapsed-by-default diagram; mermaid only loads when first expanded. */
function LayerDiagram({ mermaid, kind }: { mermaid: string; kind: string }) {
  const [open, setOpen] = useState(false);

  // Collapse again when the layer changes (component is keyed by layer).
  useEffect(() => setOpen(false), [mermaid]);

  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="text-[11px] text-violet-600 dark:text-violet-400 hover:underline"
      >
        {open ? "Hide" : "Show"} {kind} diagram
      </button>
      {open && (
        <div className="mt-1.5 max-h-[320px] overflow-y-auto themed-scrollbar rounded-md bg-background/60 p-2">
          <MermaidDiagram source={mermaid} />
        </div>
      )}
    </div>
  );
}
