import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { GitPullRequest, Loader2 } from "lucide-react";
import { cn } from "../cn";
import { useOpenPRReviewTab } from "../contexts/tabs";
import {
  useGitHubReady,
  useGitHubStore,
  type PRSearchResult,
} from "../contexts/github";
import {
  buildSearchQueries,
  buildSearchScopeQueries,
  getFilterConfig,
} from "../lib/feed-filters";
import {
  buildTextSearchQueries,
  extractRepoFromUrl,
  mergeSearchResults,
  parsePRQuery,
} from "../lib/pr-query";

const MIN_CHARS = 2;
const MAX_RESULTS = 8;
const DEBOUNCE_MS = 250;

// Header input: paste a PR URL to open it, or type text or a branch name to
// search the PRs covered by the feed's filters.
export function PRSearchInput({
  className,
  autoFocus,
}: {
  className?: string;
  autoFocus?: boolean;
} = {}) {
  const openPRReviewTab = useOpenPRReviewTab();
  const store = useGitHubStore();
  const { ready } = useGitHubReady();
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const [feedResults, setFeedResults] = useState<PRSearchResult[]>([]);
  const [moreResults, setMoreResults] = useState<PRSearchResult[]>([]);
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
    setFeedResults([]);
    setMoreResults([]);
    const scopeQueries = buildTextSearchQueries(
      buildSearchScopeQueries(getFilterConfig()),
      searchText
    );
    if (!searchText || !ready || scopeQueries.length === 0) {
      setLoading(false);
      return;
    }
    const feedQueries = buildTextSearchQueries(
      buildSearchQueries(getFilterConfig()),
      searchText
    );
    const controller = new AbortController();
    const run = (queries: string[]) =>
      Promise.all(
        queries.map((q) =>
          store.searchPRs(q, 1, MAX_RESULTS, controller.signal)
        )
      ).then((all) =>
        mergeSearchResults(
          all.map((r) => r.items as PRSearchResult[]),
          MAX_RESULTS
        )
      );
    const fail = (err: { status?: number }) => {
      if (controller.signal.aborted) return;
      setError(err?.status === 403 ? "Rate limited" : "Search failed");
    };
    setLoading(true);
    const timer = setTimeout(() => {
      // Stage 1: PRs already in the feed (narrow queries, return fastest)
      run(feedQueries)
        .then((items) => {
          if (!controller.signal.aborted) setFeedResults(items);
        })
        .catch(fail);
      // Stage 2: everything else in the feed's repos
      run(scopeQueries)
        .then((items) => {
          if (controller.signal.aborted) return;
          setMoreResults(items);
          setLoading(false);
        })
        .catch((err) => {
          fail(err);
          if (!controller.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [searchText, ready, store]);

  const results = useMemo(() => {
    const feedIds = new Set(feedResults.map((p) => p.id));
    return [...feedResults, ...moreResults.filter((p) => !feedIds.has(p.id))];
  }, [feedResults, moreResults]);

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
  const hasFeed = buildSearchScopeQueries(getFilterConfig()).length > 0;
  const feedCount = feedResults.length;

  return (
    <div
      ref={containerRef}
      className={cn("relative w-[180px] lg:w-[260px]", className)}
    >
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
            autoFocus={autoFocus}
            placeholder="Search PRs, paste URL or branch..."
            className="w-full h-9 sm:h-6 pl-7 sm:pl-6 pr-2 rounded-md border border-border/50 bg-foreground/5 text-base sm:text-[11px] placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring focus:border-transparent font-mono"
          />
          {loading ? (
            <Loader2 className="absolute left-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground/50 animate-spin" />
          ) : (
            <GitPullRequest className="absolute left-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground/50" />
          )}
        </div>
      </form>
      {showDropdown && (
        <div className="absolute right-0 top-full mt-1 w-full sm:w-[520px] max-h-[60dvh] overflow-y-auto rounded-md border border-border bg-card shadow-lg z-50 overflow-hidden">
          {!hasFeed ? (
            <Message>No repositories in your feed</Message>
          ) : error ? (
            <Message>{error}</Message>
          ) : results.length === 0 ? (
            <Message>{loading ? "Searching..." : "No matching PRs"}</Message>
          ) : (
            results.map((pr, i) => (
              <Fragment key={pr.id}>
                {i === feedCount && feedCount > 0 && (
                  <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-muted-foreground border-t border-border">
                    Other PRs in your repos
                  </div>
                )}
                <ResultRow
                  pr={pr}
                  active={i === active}
                  onHover={() => setActive(i)}
                  onSelect={() => openResult(pr)}
                />
              </Fragment>
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
