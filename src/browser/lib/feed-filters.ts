// Filter mode type
export type FilterMode =
  | "review-requested"
  | "reviewed"
  | "authored"
  | "authored-by"
  | "involves"
  | "all";

// Special constant for "All Repos" global filter
export const ALL_REPOS_KEY = "__all_repos__";

// Repository with its filter mode
export interface RepoFilter {
  name: string;
  mode: FilterMode;
  authoredBy?: string; // Username for "authored-by" filter mode
  enabled?: boolean; // Whether the filter is active (defaults to true)
}

// Filter configuration stored in localStorage
export interface FilterConfig {
  repos: RepoFilter[];
  state: "open" | "closed" | "all";
}

// Check if a filter is the special "All Repos" filter
export function isAllReposFilter(filter: RepoFilter): boolean {
  return filter.name === ALL_REPOS_KEY;
}

// ============================================================================
// Storage Helpers
// ============================================================================

const STORAGE_KEY = "pulldash_filter_config";

const DEFAULT_CONFIG: FilterConfig = {
  // Default to showing review requests across all repos
  repos: [{ name: ALL_REPOS_KEY, mode: "review-requested" }],
  state: "open",
};

export function getFilterConfig(): FilterConfig {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      // Migration: convert old string[] repos to RepoFilter[]
      if (
        parsed.repos &&
        parsed.repos.length > 0 &&
        typeof parsed.repos[0] === "string"
      ) {
        parsed.repos = parsed.repos.map((name: string) => ({
          name,
          mode: parsed.mode || "review-requested",
        }));
        delete parsed.mode;
      }
      // Migration: if user has empty repos, give them the new default (All Repos)
      if (parsed.repos && parsed.repos.length === 0) {
        parsed.repos = DEFAULT_CONFIG.repos;
      }
      return { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch {
    // ignore
  }
  return DEFAULT_CONFIG;
}

export function saveFilterConfig(config: FilterConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

// ============================================================================
// Query Builder
// ============================================================================

function getModeFilter(mode: FilterMode, authoredBy?: string): string {
  switch (mode) {
    case "review-requested":
      return "review-requested:@me";
    case "reviewed":
      return "reviewed-by:@me";
    case "authored":
      return "author:@me";
    case "authored-by":
      return authoredBy ? `author:${authoredBy}` : "";
    case "involves":
      return "involves:@me";
    default:
      return "";
  }
}

// Build queries grouped by mode (GitHub doesn't support per-repo qualifiers with OR)
// Multiple repo: qualifiers act as OR, but user filters apply to all repos
export function buildSearchQueries(config: FilterConfig): string[] {
  // Filter out disabled repos (enabled defaults to true if not specified)
  const enabledRepos = config.repos.filter((r) => r.enabled !== false);

  if (enabledRepos.length === 0) {
    return [];
  }

  const stateFilter =
    config.state === "open"
      ? "is:open"
      : config.state === "closed"
        ? "is:closed"
        : "";

  const queries: string[] = [];

  // Separate "All Repos" filters from specific repo filters
  const allReposFilters = enabledRepos.filter(isAllReposFilter);
  const specificRepos = enabledRepos.filter((r) => !isAllReposFilter(r));

  // Handle "All Repos" global filters (one query per mode)
  for (const filter of allReposFilters) {
    const parts = ["is:pr", "archived:false"];
    if (stateFilter) parts.push(stateFilter);
    const modeFilter = getModeFilter(filter.mode, filter.authoredBy);
    if (modeFilter) parts.push(modeFilter);
    // Note: "all" mode on All Repos would be too broad, so we skip it
    // Also skip "authored-by" without a username
    if (
      filter.mode !== "all" &&
      !(filter.mode === "authored-by" && !filter.authoredBy)
    ) {
      queries.push(parts.join(" "));
    }
  }

  // Group specific repos by mode+authoredBy (for authored-by, different authors need separate queries)
  if (specificRepos.length > 0) {
    // Use a composite key: mode + authoredBy for authored-by mode
    const byModeKey = new Map<
      string,
      { mode: FilterMode; authoredBy?: string; repos: string[] }
    >();
    for (const repo of specificRepos) {
      const key =
        repo.mode === "authored-by"
          ? `${repo.mode}:${repo.authoredBy || ""}`
          : repo.mode;
      const existing = byModeKey.get(key);
      if (existing) {
        existing.repos.push(repo.name);
      } else {
        byModeKey.set(key, {
          mode: repo.mode,
          authoredBy: repo.authoredBy,
          repos: [repo.name],
        });
      }
    }

    for (const [, { mode, authoredBy, repos }] of byModeKey) {
      // Skip authored-by without a username
      if (mode === "authored-by" && !authoredBy) continue;

      const parts = ["is:pr", "archived:false"];
      if (stateFilter) parts.push(stateFilter);
      // Multiple repo: qualifiers act as OR
      parts.push(...repos.map((r) => `repo:${r}`));
      const modeFilter = getModeFilter(mode, authoredBy);
      if (modeFilter) parts.push(modeFilter);
      queries.push(parts.join(" "));
    }
  }

  return queries;
}

// Queries for text search: every PR in the feed's specific repos regardless of
// mode (so PRs outside the user's review/authored filters are found), plus the
// "All Repos" filters as-is since they have no repo list to widen to.
export function buildSearchScopeQueries(config: FilterConfig): string[] {
  const enabled = config.repos.filter((r) => r.enabled !== false);
  const queries = buildSearchQueries({
    ...config,
    repos: enabled.filter(isAllReposFilter),
  });

  const names = [
    ...new Set(enabled.filter((r) => !isAllReposFilter(r)).map((r) => r.name)),
  ];
  if (names.length > 0) {
    const parts = ["is:pr", "archived:false"];
    if (config.state === "open") parts.push("is:open");
    if (config.state === "closed") parts.push("is:closed");
    parts.push(...names.map((n) => `repo:${n}`));
    queries.push(parts.join(" "));
  }
  return queries;
}
