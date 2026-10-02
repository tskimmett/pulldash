import { useCallback, useEffect, useRef, useState } from "react";
import { GitPullRequest, Loader2 } from "lucide-react";
import { cn } from "../cn";
import { useOpenPRReviewTab } from "../contexts/tabs";
import {
  useGitHubReady,
  useGitHubStore,
  type PRSearchResult,
} from "../contexts/github";
import { getFilterConfig, buildSearchQueries } from "../lib/feed-filters";
import {
  buildTextSearchQueries,
  extractRepoFromUrl,
  mergeSearchResults,
  parsePRQuery,
} from "../lib/pr-query";

const MIN_CHARS = 2;
const MAX_RESULTS = 8;
const DEBOUNCE_MS = 250;

// Header input: paste a PR URL to open it, or type text to search the PRs
// covered by the feed's filters.
export function PRSearchInput() {
  const openPRReviewTab = useOpenPRReviewTab();
  const store = useGitHubStore();
  const { ready } = useGitHubReady();
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<PRSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const parsed = parsePRQuery(value);
  const searchText =
    parsed.kind === "text" && parsed.text.length >= MIN_CHARS
      ? parsed.text
      : "";

  useEffect(() => {
    setActive(0);
    setError(null);
    if (!searchText || !ready) {
      setResults([]);
      setLoading(false);
      return;
    }
    const feedQueries = buildSearchQueries(getFilterConfig());
    const queries = buildTextSearchQueries(feedQueries, searchText);
    if (queries.length === 0) {
      setResults([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = setTimeout(() => {
      Promise.all(
        queries.map((q) =>
          store.searchPRs(q, 1, MAX_RESULTS, controller.signal)
        )
      )
        .then((all) => {
          if (controller.signal.aborted) return;
          setResults(
            mergeSearchResults(
              all.map((r) => r.items as PRSearchResult[]),
              MAX_RESULTS
            )
          );
          setLoading(false);
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          setError(err?.status === 403 ? "Rate limited" : "Search failed");
          setResults([]);
          setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [searchText, ready, store]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const openResult = useCallback(
    (pr: PRSearchResult) => {
      const repo = extractRepoFromUrl(pr.repository_url);
      if (!repo) return;
      openPRReviewTab(repo.owner, repo.repo, pr.number);
      setValue("");
      setOpen(false);
    },
    [openPRReviewTab]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      setOpen(false);
    } else if (e.key === "ArrowDown" && results.length > 0) {
      e.preventDefault();
      setActive((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp" && results.length > 0) {
      e.preventDefault();
      setActive((i) => (i - 1 + results.length) % results.length);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (parsed.kind === "pr") {
      openPRReviewTab(parsed.owner, parsed.repo, parsed.number);
      setValue("");
      setOpen(false);
    } else if (results[active]) {
      openResult(results[active]);
    }
  };

  const showDropdown = open && searchText.length > 0;
  const hasFeed = buildSearchQueries(getFilterConfig()).length > 0;

  return (
    <div ref={containerRef} className="relative w-[260px]">
      <form onSubmit={handleSubmit}>
        <div className="relative">
          <input
            type="text"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onKeyDown={handleKeyDown}
            placeholder="Search PRs or paste URL..."
            className="w-full h-6 pl-6 pr-2 rounded-md border border-border/50 bg-foreground/5 text-[11px] placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring focus:border-transparent font-mono"
          />
          {loading ? (
            <Loader2 className="absolute left-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground/50 animate-spin" />
          ) : (
            <GitPullRequest className="absolute left-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground/50" />
          )}
        </div>
      </form>
      {showDropdown && (
        <div className="absolute right-0 top-full mt-1 w-[520px] rounded-md border border-border bg-card shadow-lg z-50 overflow-hidden">
          {!hasFeed ? (
            <Message>No repositories in your feed</Message>
          ) : error ? (
            <Message>{error}</Message>
          ) : results.length === 0 ? (
            <Message>{loading ? "Searching..." : "No matching PRs"}</Message>
          ) : (
            results.map((pr, i) => (
              <ResultRow
                key={pr.id}
                pr={pr}
                active={i === active}
                onHover={() => setActive(i)}
                onSelect={() => openResult(pr)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function Message({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-3 py-3 text-xs text-muted-foreground">{children}</div>
  );
}

function ResultRow({
  pr,
  active,
  onHover,
  onSelect,
}: {
  pr: PRSearchResult;
  active: boolean;
  onHover: () => void;
  onSelect: () => void;
}) {
  const repo = extractRepoFromUrl(pr.repository_url);
  const merged = !!pr.pull_request?.merged_at;
  const dot = merged
    ? "bg-purple-500"
    : pr.state === "closed"
      ? "bg-red-500"
      : pr.draft
        ? "bg-muted-foreground"
        : "bg-green-500";
  return (
    <button
      type="button"
      onMouseEnter={onHover}
      onClick={onSelect}
      className={cn(
        "w-full flex items-center gap-2 px-3 py-1.5 text-left",
        active && "bg-foreground/10"
      )}
    >
      <span className={cn("w-2 h-2 rounded-full shrink-0", dot)} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs">{pr.title}</span>
        <span className="block truncate text-[10px] text-muted-foreground font-mono">
          {repo ? `${repo.owner}/${repo.repo}` : ""}#{pr.number}
          {pr.user ? ` · ${pr.user.login}` : ""}
        </span>
      </span>
    </button>
  );
}
