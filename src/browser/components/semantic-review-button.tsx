import { Loader2, Sparkles, TriangleAlert, X } from "lucide-react";
import { memo, useEffect } from "react";
import { cn } from "../cn";
import { usePRReviewSelector, usePRReviewStore } from "../contexts/pr-review";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

/**
 * Header button for the semantic review feature.
 *
 * Renders nothing when no local agent providers are available (hosted
 * deployment). Otherwise:
 * - idle:    "Semantic review" -> provider picker -> starts analysis
 * - running: spinner + live progress; dropdown shows the log + cancel
 * - done:    toggles between file view and semantic view; offers re-run
 * - error:   shows the failure + retry per provider
 */
export const SemanticReviewButton = memo(function SemanticReviewButton() {
  const store = usePRReviewStore();
  const providers = usePRReviewSelector((s) => s.semanticProviders);
  const status = usePRReviewSelector((s) => s.semanticStatus);
  const review = usePRReviewSelector((s) => s.semanticReview);
  const progress = usePRReviewSelector((s) => s.semanticProgress);
  const error = usePRReviewSelector((s) => s.semanticError);
  const viewMode = usePRReviewSelector((s) => s.viewMode);

  // Load providers + cached result once; tear down any live SSE stream on
  // unmount (the job itself keeps running server-side and lands in cache).
  useEffect(() => {
    void store.initSemanticReview();
    return () => store.disposeSemantic();
  }, [store]);

  if (!providers || providers.length === 0) return null;

  if (status === "running") {
    const latest = progress[progress.length - 1];
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-md bg-violet-600/20 text-violet-600 dark:text-violet-400 hover:bg-violet-600/30 transition-colors max-w-[220px]"
            title={latest ?? "Analyzing…"}
          >
            <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
            <span className="truncate">{latest ?? "Analyzing…"}</span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-[360px]">
          <DropdownMenuLabel className="font-semibold">
            Semantic analysis in progress
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <div className="max-h-[200px] overflow-y-auto px-2 py-1 space-y-0.5 themed-scrollbar">
            {progress.map((line, i) => (
              <div
                key={i}
                className={cn(
                  "text-xs font-mono",
                  i === progress.length - 1
                    ? "text-foreground"
                    : "text-muted-foreground"
                )}
              >
                {line}
              </div>
            ))}
            {progress.length === 0 && (
              <div className="text-xs text-muted-foreground">Starting…</div>
            )}
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => store.cancelSemanticAnalysis()}
            className="text-destructive"
          >
            <X className="w-3.5 h-3.5 mr-1.5" />
            Cancel analysis
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );
  }

  if (status === "done" && review) {
    const semanticActive = viewMode === "semantic";
    return (
      <div className="flex items-center">
        <button
          onClick={() =>
            store.setViewMode(semanticActive ? "files" : "semantic")
          }
          className={cn(
            "flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-l-md transition-colors",
            semanticActive
              ? "bg-violet-600 text-white hover:bg-violet-700"
              : "bg-violet-600/20 text-violet-600 dark:text-violet-400 hover:bg-violet-600/30"
          )}
          title={
            semanticActive
              ? "Back to file view"
              : "Review by semantic change groups"
          }
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span className="hidden sm:inline">Semantic</span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              className={cn(
                "px-1 py-1 text-xs rounded-r-md border-l transition-colors",
                semanticActive
                  ? "bg-violet-600 text-white hover:bg-violet-700 border-violet-500"
                  : "bg-violet-600/20 text-violet-600 dark:text-violet-400 hover:bg-violet-600/30 border-violet-600/30"
              )}
              title="Semantic review options"
            >
              <span className="px-0.5">▾</span>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[240px]">
            <DropdownMenuLabel className="font-semibold">
              Re-run analysis
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {providers.map((p) => (
              <DropdownMenuItem
                key={p.id}
                onClick={() => store.startSemanticAnalysis(p.id)}
              >
                <Sparkles className="w-3.5 h-3.5 mr-1.5" />
                {p.displayName}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    );
  }

  // idle or error
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className={cn(
            "flex items-center gap-1.5 px-2 py-1 text-xs font-medium rounded-md transition-colors",
            status === "error"
              ? "bg-red-600/20 text-red-600 dark:text-red-400 hover:bg-red-600/30"
              : "bg-violet-600/20 text-violet-600 dark:text-violet-400 hover:bg-violet-600/30"
          )}
          title={
            status === "error"
              ? (error ?? "Analysis failed")
              : "Analyze this PR into semantic change groups"
          }
        >
          {status === "error" ? (
            <TriangleAlert className="w-3.5 h-3.5" />
          ) : (
            <Sparkles className="w-3.5 h-3.5" />
          )}
          <span className="hidden sm:inline">Semantic review</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[280px]">
        {status === "error" && (
          <>
            <div className="px-2 py-1.5 text-xs text-red-600 dark:text-red-400 break-words">
              {error ?? "Analysis failed"}
            </div>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuLabel className="font-semibold">
          {status === "error" ? "Retry with" : "Analyze with"}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {providers.map((p) => (
          <DropdownMenuItem
            key={p.id}
            onClick={() => store.startSemanticAnalysis(p.id)}
          >
            <Sparkles className="w-3.5 h-3.5 mr-1.5" />
            {p.displayName}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});
