import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useCallback,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { Octokit } from "@octokit/core";
import type { components } from "@octokit/openapi-types";
import { useAuth } from "./auth";
import {
  carryOverRecoveredPatches,
  recoverPatches,
} from "../lib/recover-patches";
import { diffService } from "../lib/diff";
import {
  COMPARE_FILE_LIMIT,
  rangeFromTrees,
  rebaseRangeFiles,
  treeChanges,
  type BlobRequest,
  type RangeFile,
  type Tree,
} from "../lib/rebase-range";
import { fetchAllPages } from "../lib/fetch-all-pages";
import { openPersistentStore } from "../lib/persistent-cache";
import { RequestCache } from "../lib/request-cache";
import {
  PR_FINGERPRINT_QUERY,
  fingerprintMatchesPR,
  parsePRFingerprint,
  type PRFingerprint,
  type PRFingerprintResponse,
} from "../lib/pr-fingerprint";
import { addConditionalRequests, hasStatus } from "../lib/conditional-requests";

// Re-export types
// Extended PullRequest with body_html from GitHub's HTML media type
export type PullRequest = components["schemas"]["pull-request"] & {
  body_html?: string;
};
export type PullRequestFile = components["schemas"]["diff-entry"];
// Extended ReviewComment with body_html from GitHub's HTML media type
export type ReviewComment =
  components["schemas"]["pull-request-review-comment"] & {
    body_html?: string;
  };
// Extended Review with body_html from GitHub's HTML media type
export type Review = components["schemas"]["pull-request-review"] & {
  body_html?: string;
};
export type CheckRun = components["schemas"]["check-run"];
export type CombinedStatus = components["schemas"]["combined-commit-status"];
// Extended IssueComment with body_html from GitHub's HTML media type
export type IssueComment = components["schemas"]["issue-comment"] & {
  body_html?: string;
};
export type PRCommit = components["schemas"]["commit"];
export type Collaborator = components["schemas"]["collaborator"];
export type Reaction = components["schemas"]["reaction"];
export type ReactionContent =
  | "+1"
  | "-1"
  | "laugh"
  | "hooray"
  | "confused"
  | "heart"
  | "rocket"
  | "eyes";
export type TimelineEvent = components["schemas"]["timeline-issue-events"];
export type UserProfile = components["schemas"]["public-user"];

// ============================================================================
// Types
// ============================================================================

export interface PRSearchResult {
  id: number;
  number: number;
  title: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  draft: boolean;
  state: string;
  repository_url: string;
  user: {
    login: string;
    avatar_url: string;
  } | null;
  labels: Array<{
    name: string;
    color: string;
  }>;
  pull_request?: {
    merged_at: string | null;
  };
  // Enrichment data
  changedFiles?: number;
  additions?: number;
  deletions?: number;
  lastCommitAt?: string | null;
  viewerLastReviewAt?: string | null;
  hasNewChanges?: boolean;
  // CI status
  ciStatus?: "pending" | "success" | "failure" | "none" | "action_required";
  ciSummary?: string; // e.g. "2/3 checks passed" or "Build failed"
  ciChecks?: Array<{
    name: string;
    state: "pending" | "success" | "failure";
  }>;
  // Review status
  reviewDecision?: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  latestReviews?: Array<{
    login: string;
    avatarUrl: string;
    state: "APPROVED" | "CHANGES_REQUESTED";
  }>;
}

export interface WorkflowRunAwaitingApproval {
  id: number;
  name: string;
  html_url: string;
}

export type MergeMethod = "merge" | "squash" | "rebase";

export interface AutoMergeState {
  pullRequestId: string;
  canEnable: boolean;
  canDisable: boolean;
  /** Set when auto-merge is currently scheduled. */
  request: { mergeMethod: MergeMethod; enabledBy: string | null } | null;
}

export interface CheckStatus {
  checks: "pending" | "success" | "failure" | "none" | "action_required";
  state: "open" | "closed" | "merged" | "draft";
  mergeable: boolean | null;
  workflowRunsAwaitingApproval?: WorkflowRunAwaitingApproval[];
}

export interface PREnrichment {
  changedFiles: number;
  additions: number;
  deletions: number;
  lastCommitAt: string | null;
  viewerLastReviewAt: string | null;
  hasNewChanges: boolean;
  ciStatus: "pending" | "success" | "failure" | "none" | "action_required";
  ciSummary: string;
  ciChecks: Array<{
    name: string;
    state: "pending" | "success" | "failure";
  }>;
  // Review status
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  latestReviews: Array<{
    login: string;
    avatarUrl: string;
    state: "APPROVED" | "CHANGES_REQUESTED";
  }>;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  resolvedBy: { login: string; avatarUrl: string } | null;
  // The review this thread belongs to (from first comment)
  pullRequestReview: {
    databaseId: number;
    author: { login: string; avatarUrl: string } | null;
  } | null;
  comments: {
    nodes: Array<{
      id: string;
      databaseId: number;
      body: string;
      /** Pre-rendered HTML with signed attachment URLs from GitHub's GraphQL API */
      bodyHTML?: string;
      path: string;
      line: number | null;
      originalLine: number | null;
      startLine: number | null;
      diffHunk: string | null;
      author: { login: string; avatarUrl: string } | null;
      createdAt: string;
      updatedAt: string;
      replyTo: { databaseId: number } | null;
    }>;
  };
}

export interface PendingReview {
  id: string;
  databaseId: number;
  viewerDidAuthor: boolean;
  comments: {
    nodes: Array<{
      id: string;
      databaseId: number;
      body: string;
      path: string;
      line: number;
      startLine: number | null;
    }>;
  };
}

// ============================================================================
// GraphQL Client
// ============================================================================

// GitHub has no endpoint for batching separate GraphQL documents, so queries
// go out immediately; combine work by aliasing fields (see getPREnrichment).
class GraphQLClient {
  constructor(
    private octokit: Octokit,
    private onMutation: () => void
  ) {}

  async query<T>(
    query: string,
    variables: Record<string, unknown> = {}
  ): Promise<T> {
    try {
      return await this.octokit.graphql<T>(query, variables);
    } finally {
      if (query.trimStart().startsWith("mutation")) this.onMutation();
    }
  }
}

// ============================================================================
// Cache Keys
// ============================================================================

type PRKey = (owner: string, repo: string, number: number) => string;
const prKey: PRKey = (owner, repo, number) => `pr:${owner}/${repo}/${number}`;
const prSubKey =
  (suffix: string): PRKey =>
  (owner, repo, number) =>
    `${prKey(owner, repo, number)}:${suffix}`;

/** Keys for durably cached data, for callers that render it via peekCache. */
export const cacheKeys = {
  pr: prKey,
  prFiles: prSubKey("files"),
  prComments: prSubKey("comments"),
  prReviews: prSubKey("reviews"),
  prConversation: prSubKey("conversation"),
  prTimeline: prSubKey("timeline"),
  prCommits: prSubKey("commits"),
  prThreads: prSubKey("threads"),
  prFingerprint: prSubKey("fingerprint"),
  checks: (owner: string, repo: string, sha: string) =>
    `checks:${owner}/${repo}/${sha}`,
  workflowRuns: (owner: string, repo: string, sha: string) =>
    `workflow-runs:${owner}/${repo}/${sha}`,
};

const isReviewThreadsKey = (key: string) => key.endsWith(":threads");

// Commit SHAs never change content, so files read at one are cached forever.
const isCommitSha = (ref: string) => /^[0-9a-f]{40}$/i.test(ref);
// Skip durably storing huge blobs; they'd crowd out everything else.
const MAX_PERSISTED_FILE_CHARS = 512 * 1024;

/** The cache used to live in localStorage; drop what's left of it. */
function removeLegacyLocalStorageCache() {
  try {
    const legacy: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith("gh_cache:")) legacy.push(key);
    }
    for (const key of legacy) localStorage.removeItem(key);
  } catch {
    // Ignore storage errors
  }
}

// ============================================================================
// State Types
// ============================================================================

interface PRListState {
  items: PRSearchResult[];
  totalCount: number;
  loading: boolean;
  // Showing cached items while a fresh copy loads
  refreshing: boolean;
  error: string | null;
  lastFetchedAt: number | null;
}

interface PRCheckState {
  status: CheckStatus | null;
  loading: boolean;
  lastFetchedAt: number | null;
}

export interface CurrentUserData {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
  html_url: string;
  bio: string | null;
  company: string | null;
  location: string | null;
}

interface GitHubState {
  ready: boolean;
  error: string | null;
  currentUser: CurrentUserData | null;
  prList: PRListState;
  prListQueries: string[];
  prListPage: number;
  prChecks: Map<string, PRCheckState>;
}

type Listener = () => void;

// ============================================================================
// GitHub Store - Combines API client + state management
// ============================================================================

function createGitHubStore() {
  let state: GitHubState = {
    ready: false,
    error: null,
    currentUser: null,
    prList: {
      items: [],
      totalCount: 0,
      loading: false,
      refreshing: false,
      error: null,
      lastFetchedAt: null,
    },
    prListQueries: [],
    prListPage: 1,
    prChecks: new Map(),
  };

  const listeners = new Set<Listener>();
  const persistent = openPersistentStore();
  const cache = new RequestCache(persistent);
  removeLegacyLocalStorageCache();
  // Review threads change through GraphQL mutations that don't name the PR.
  const invalidateReviewThreads = () => cache.invalidate(isReviewThreadsKey);
  let octokit: Octokit | null = null;
  let gql: GraphQLClient | null = null;
  let onUnauthorized: (() => void) | null = null;
  let prListAbortController: AbortController | null = null;
  let onRateLimited: (() => void) | null = null;

  function setOnUnauthorized(callback: () => void) {
    onUnauthorized = callback;
  }

  function setOnRateLimited(callback: () => void) {
    onRateLimited = callback;
  }

  // Helper to wrap octokit with error hooks
  function wrapOctokitWithHooks(octokitInstance: Octokit) {
    octokitInstance.hook.wrap("request", async (request, options) => {
      try {
        return await request(options);
      } catch (error) {
        if (error && typeof error === "object" && "status" in error) {
          if (error.status === 401) {
            console.warn(
              "[GitHub] Received 401 Unauthorized - token may be revoked"
            );
            onUnauthorized?.();
          } else if (
            error.status === 403 &&
            "response" in error &&
            error.response &&
            typeof error.response === "object" &&
            "headers" in error.response
          ) {
            // Check for rate limit
            const headers = (
              error.response as { headers: Record<string, string> }
            ).headers;
            const remaining = headers["x-ratelimit-remaining"];
            if (remaining === "0") {
              console.warn("[GitHub] Rate limit exceeded");
              onRateLimited?.();
            }
          }
        }
        throw error;
      }
    });
    addConditionalRequests(octokitInstance, persistent);
  }

  function getState() {
    return state;
  }

  function setState(
    partial: Partial<GitHubState> | ((s: GitHubState) => Partial<GitHubState>)
  ) {
    const updates = typeof partial === "function" ? partial(state) : partial;
    state = { ...state, ...updates };
    listeners.forEach((l) => l());
  }

  function subscribe(listener: Listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  function extractUserData(
    user: components["schemas"]["private-user"]
  ): CurrentUserData {
    return {
      id: user.id,
      login: user.login,
      name: user.name ?? null,
      email: user.email ?? null,
      avatar_url: user.avatar_url,
      html_url: user.html_url,
      bio: user.bio ?? null,
      company: user.company ?? null,
      location: user.location ?? null,
    };
  }

  function initialize(token: string) {
    octokit = new Octokit({ auth: token });
    wrapOctokitWithHooks(octokit);
    gql = new GraphQLClient(octokit, invalidateReviewThreads);

    setState({ ready: true, error: null });

    // Revalidate current user in background
    fetchCurrentUser();
  }

  function reset() {
    octokit = null;
    gql = null;
    cache.invalidate();
    setState({
      ready: false,
      error: null,
      currentUser: null,
      prList: {
        items: [],
        totalCount: 0,
        loading: false,
        refreshing: false,
        error: null,
        lastFetchedAt: null,
      },
      prListQueries: [],
      prListPage: 1,
      prChecks: new Map(),
    });
  }

  // ---------------------------------------------------------------------------
  // Current User (with SWR)
  // ---------------------------------------------------------------------------

  async function fetchCurrentUser() {
    if (!octokit) return;

    const cacheKey = "user:current";
    const FRESH_TTL = 300_000; // 5 minutes

    // Show the last known user immediately, revalidating if it's old
    const stale =
      await cache.peek<components["schemas"]["private-user"]>(cacheKey);
    if (stale) {
      setState({ currentUser: extractUserData(stale.data) });
      if (Date.now() - stale.timestamp <= FRESH_TTL) return;
    }

    // Check for pending request
    const pending =
      cache.getPending<components["schemas"]["private-user"]>(cacheKey);
    if (pending) {
      const user = await pending;
      setState({ currentUser: extractUserData(user) });
      return;
    }

    // Fetch fresh data (in background if we had stale data)
    const promise = octokit.request("GET /user").then((r) => {
      cache.set(cacheKey, r.data, true);
      return r.data;
    });
    cache.setPending(cacheKey, promise);

    try {
      const user = await promise;
      setState({
        currentUser: extractUserData(
          user as components["schemas"]["private-user"]
        ),
      });
    } catch {
      // Ignore - we may have stale data to show
    }
  }

  // ---------------------------------------------------------------------------
  // PR List
  // ---------------------------------------------------------------------------

  async function fetchPRList(
    queries: string[],
    page = 1,
    perPage = 30,
    options?: { backgroundRefresh?: boolean }
  ) {
    if (!octokit || !gql) return;

    const { backgroundRefresh = false } = options ?? {};

    // Abort any in-flight request
    prListAbortController?.abort();
    const abortController = new AbortController();
    prListAbortController = abortController;
    const { signal } = abortController;

    if (queries.length === 0) {
      setState({
        prList: {
          items: [],
          totalCount: 0,
          loading: false,
          refreshing: false,
          error: null,
          lastFetchedAt: Date.now(),
        },
        prListQueries: queries,
        prListPage: page,
      });
      return;
    }

    const sortedQueries = [...queries].sort();
    const cacheKey = `prlist:${sortedQueries.join("|")}:${page}:${perPage}`;
    const FRESH_TTL = 30_000; // 30 seconds

    // A different list must not keep showing the previous list's rows.
    const sameList =
      state.prListPage === page &&
      [...state.prListQueries].sort().join("|") === sortedQueries.join("|");
    if (!sameList) {
      setState({
        prList: {
          items: [],
          totalCount: 0,
          loading: true,
          refreshing: false,
          error: null,
          lastFetchedAt: null,
        },
        prListQueries: queries,
        prListPage: page,
      });
    }

    // Show the last copy of this list immediately, from memory or disk
    const stale = await cache.peek<{
      items: PRSearchResult[];
      totalCount: number;
    }>(cacheKey);
    if (signal.aborted) return;
    const isStale = !stale || Date.now() - stale.timestamp > FRESH_TTL;
    if (stale) {
      setState({
        prList: {
          ...stale.data,
          loading: false,
          refreshing: isStale,
          error: null,
          lastFetchedAt: Date.now(),
        },
        prListQueries: queries,
        prListPage: page,
      });
      if (!isStale) return;
    } else if (sameList) {
      setState((s) => ({
        prList: {
          ...s.prList,
          // Background refreshes keep the current rows without a spinner
          loading: backgroundRefresh ? false : s.prList.items.length === 0,
          refreshing: s.prList.items.length > 0,
          error: null,
        },
      }));
    }

    try {
      // Fetch PRs with caching, passing the abort signal
      const results = await Promise.all(
        queries.map((q) => searchPRs(q, page, perPage, signal))
      );

      // Check if aborted before processing results
      if (signal.aborted) return;

      // Combine and dedupe by PR id. Rows keep their previous enrichment
      // (CI, reviews) until the fresh GraphQL data lands.
      const previous = new Map(
        [...(stale?.data.items ?? []), ...state.prList.items].map((item) => [
          item.id,
          item,
        ])
      );
      const seen = new Set<number>();
      let combined: PRSearchResult[] = [];

      for (const data of results) {
        for (const pr of data.items || []) {
          if (!seen.has(pr.id)) {
            seen.add(pr.id);
            combined.push({ ...previous.get(pr.id), ...pr } as PRSearchResult);
          }
        }
      }

      // Sort by updated_at descending
      combined.sort(
        (a, b) =>
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
      );

      // Render search results now; enrichment is a second round trip
      setState({
        prList: {
          items: combined,
          totalCount: combined.length,
          loading: false,
          refreshing: true,
          error: null,
          lastFetchedAt: Date.now(),
        },
      });

      // Enrich with GraphQL data
      const prIdentifiers = combined
        .map((item) => {
          const match = item.repository_url?.match(/repos\/([^/]+)\/([^/]+)/);
          if (match && item.number) {
            return { owner: match[1], repo: match[2], number: item.number };
          }
          return null;
        })
        .filter(
          (x): x is { owner: string; repo: string; number: number } =>
            x !== null
        );

      if (prIdentifiers.length > 0) {
        try {
          const enrichmentMap = await getPREnrichment(prIdentifiers);

          // Check if aborted after enrichment
          if (signal.aborted) return;

          combined = combined.map((item) => {
            const match = item.repository_url?.match(/repos\/([^/]+)\/([^/]+)/);
            if (!match || !item.number) return item;
            const enrichment = enrichmentMap.get(
              `${match[1]}/${match[2]}/${item.number}`
            );
            return enrichment ? { ...item, ...enrichment } : item;
          });
        } catch (enrichmentError) {
          console.error("PR enrichment failed:", enrichmentError);
        }
      }

      // Final check before updating state
      if (signal.aborted) return;

      // Cache the result (persist for instant load next time)
      // Use combined.length instead of total to reflect deduplicated count
      cache.set(
        cacheKey,
        { items: combined, totalCount: combined.length },
        true
      );

      setState({
        prList: {
          items: combined,
          totalCount: combined.length,
          loading: false,
          refreshing: false,
          error: null,
          lastFetchedAt: Date.now(),
        },
      });
    } catch (e) {
      // Ignore abort errors - they're expected when switching filters
      if (e instanceof Error && e.name === "AbortError") return;

      // Only update error state if not aborted
      if (signal.aborted) return;

      setState((s) => ({
        prList: {
          ...s.prList,
          loading: false,
          refreshing: false,
          error: e instanceof Error ? e.message : "Failed to fetch PRs",
        },
      }));
    }
  }

  function refreshPRList() {
    const { prListQueries, prListPage } = state;
    if (prListQueries.length > 0) {
      fetchPRList(prListQueries, prListPage, 30, { backgroundRefresh: true });
    }
  }

  // ---------------------------------------------------------------------------
  // PR Checks
  // ---------------------------------------------------------------------------

  function getPRCheckKey(owner: string, repo: string, number: number) {
    return `${owner}/${repo}/${number}`;
  }

  async function fetchPRChecks(owner: string, repo: string, number: number) {
    if (!octokit) return;

    const key = getPRCheckKey(owner, repo, number);

    setState((s) => {
      const newChecks = new Map(s.prChecks);
      newChecks.set(key, {
        status: s.prChecks.get(key)?.status || null,
        loading: true,
        lastFetchedAt: s.prChecks.get(key)?.lastFetchedAt || null,
      });
      return { prChecks: newChecks };
    });

    try {
      const prData = await getPR(owner, repo, number);
      const [checksData, workflowRunsData] = await Promise.all([
        getPRChecksForSha(owner, repo, prData.head.sha),
        getWorkflowRunsForSha(owner, repo, prData.head.sha).catch(() => ({
          workflow_runs: [],
        })),
      ]);

      const checkRuns = checksData.checkRuns || [];
      const statuses = checksData.status?.statuses || [];

      // Check for workflow runs awaiting approval (fork PRs)
      const workflowRunsAwaitingApproval = workflowRunsData.workflow_runs
        .filter((run) => run.conclusion === "action_required")
        .map((run) => ({
          id: run.id,
          name: run.name || "Workflow",
          html_url: run.html_url,
        }));

      let checks: CheckStatus["checks"] = "none";

      // If there are workflow runs awaiting approval and no other checks, show action_required
      if (workflowRunsAwaitingApproval.length > 0) {
        // Check if there are any other actual check runs or statuses
        if (checkRuns.length === 0 && statuses.length === 0) {
          checks = "action_required";
        } else {
          // There are other checks, evaluate them first
          const allChecks = [
            ...checkRuns.map((c) =>
              c.status === "completed" ? c.conclusion : "pending"
            ),
            ...statuses.map((s) => s.state),
          ];

          if (allChecks.some((c) => c === "failure" || c === "error")) {
            checks = "failure";
          } else if (allChecks.some((c) => c === "pending" || c === null)) {
            checks = "pending";
          } else {
            // All checks passed but there are workflows awaiting approval
            checks = "action_required";
          }
        }
      } else if (checkRuns.length > 0 || statuses.length > 0) {
        const allChecks = [
          ...checkRuns.map((c) =>
            c.status === "completed" ? c.conclusion : "pending"
          ),
          ...statuses.map((s) => s.state),
        ];

        if (allChecks.some((c) => c === "failure" || c === "error")) {
          checks = "failure";
        } else if (allChecks.some((c) => c === "pending" || c === null)) {
          checks = "pending";
        } else {
          checks = "success";
        }
      }

      const prState: CheckStatus["state"] = prData.merged
        ? "merged"
        : prData.draft
          ? "draft"
          : prData.state === "open"
            ? "open"
            : "closed";

      setState((s) => {
        const newChecks = new Map(s.prChecks);
        newChecks.set(key, {
          status: {
            checks,
            state: prState,
            mergeable: prData.mergeable,
            workflowRunsAwaitingApproval:
              workflowRunsAwaitingApproval.length > 0
                ? workflowRunsAwaitingApproval
                : undefined,
          },
          loading: false,
          lastFetchedAt: Date.now(),
        });
        return { prChecks: newChecks };
      });
    } catch {
      setState((s) => {
        const newChecks = new Map(s.prChecks);
        newChecks.set(key, {
          status: s.prChecks.get(key)?.status || null,
          loading: false,
          lastFetchedAt: Date.now(),
        });
        return { prChecks: newChecks };
      });
    }
  }

  function refreshAllPRChecks() {
    for (const key of state.prChecks.keys()) {
      const [owner, repo, number] = key.split("/");
      if (owner && repo && number) {
        fetchPRChecks(owner, repo, parseInt(number, 10));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // API Methods (with caching and deduplication)
  // ---------------------------------------------------------------------------

  async function searchPRs(
    query: string,
    page = 1,
    perPage = 30,
    signal?: AbortSignal
  ) {
    if (!octokit) throw new Error("Not initialized");

    const cacheKey = `search:prs:${query}:${page}:${perPage}`;

    const cached =
      cache.get<
        Awaited<
          ReturnType<typeof octokit.request<"GET /search/issues">>
        >["data"]
      >(cacheKey);
    if (cached) return cached;

    const pending =
      cache.getPending<
        Awaited<
          ReturnType<typeof octokit.request<"GET /search/issues">>
        >["data"]
      >(cacheKey);
    if (pending) return pending;

    const promise = octokit
      .request("GET /search/issues", {
        q: query,
        sort: "updated",
        order: "desc",
        per_page: perPage,
        page,
        request: { signal },
      })
      .then((res) => {
        cache.set(cacheKey, res.data);
        return res.data;
      });

    cache.setPending(cacheKey, promise);
    return promise;
  }

  async function searchRepos(query: string) {
    if (!octokit) throw new Error("Not initialized");

    const cacheKey = `search:repos:${query}`;

    const cached =
      cache.get<
        Awaited<
          ReturnType<typeof octokit.request<"GET /search/repositories">>
        >["data"]
      >(cacheKey);
    if (cached) return cached;

    const pending =
      cache.getPending<
        Awaited<
          ReturnType<typeof octokit.request<"GET /search/repositories">>
        >["data"]
      >(cacheKey);
    if (pending) return pending;

    const promise = octokit
      .request("GET /search/repositories", {
        q: query,
        order: "desc",
        per_page: 10,
      })
      .then((res) => {
        cache.set(cacheKey, res.data);
        return res.data;
      });

    cache.setPending(cacheKey, promise);
    return promise;
  }

  async function searchUsers(query: string) {
    if (!octokit) throw new Error("Not initialized");

    const cacheKey = `search:users:${query}`;

    type UserSearchResult = Awaited<
      ReturnType<typeof octokit.request<"GET /search/users">>
    >["data"];

    const cached = cache.get<UserSearchResult>(cacheKey);
    if (cached) return cached;

    const pending = cache.getPending<UserSearchResult>(cacheKey);
    if (pending) return pending;

    const promise = octokit
      .request("GET /search/users", {
        q: query,
        per_page: 8,
      })
      .then((res) => {
        cache.set(cacheKey, res.data);
        return res.data;
      });

    cache.setPending(cacheKey, promise);
    return promise;
  }

  async function getPR(
    owner: string,
    repo: string,
    number: number
  ): Promise<PullRequest> {
    if (!octokit) throw new Error("Not initialized");

    const cacheKey = cacheKeys.pr(owner, repo, number);

    const cached = cache.get<PullRequest>(cacheKey);
    if (cached) return cached;

    const pending = cache.getPending<PullRequest>(cacheKey);
    if (pending) return pending;

    const promise = octokit
      .request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner,
        repo,
        pull_number: number,
        headers: {
          // Request full media type to get both body and body_html with signed attachment URLs
          accept: "application/vnd.github.full+json",
        },
      })
      .then((res) => {
        cache.set(cacheKey, res.data as PullRequest, true);
        return res.data as PullRequest;
      });

    cache.setPending(cacheKey, promise);
    return promise;
  }

  async function getPRFiles(
    owner: string,
    repo: string,
    number: number
  ): Promise<PullRequestFile[]> {
    if (!octokit) throw new Error("Not initialized");

    const cacheKey = cacheKeys.prFiles(owner, repo, number);

    const cached = cache.get<PullRequestFile[]>(cacheKey);
    if (cached) return cached;

    const pending = cache.getPending<PullRequestFile[]>(cacheKey);
    if (pending) return pending;

    const promise = (async () => {
      const previous = cache.peek<PullRequestFile[]>(cacheKey);
      const files = await fetchAllPages(async (page) => {
        const { data } = await octokit!.request(
          "GET /repos/{owner}/{repo}/pulls/{pull_number}/files",
          {
            owner,
            repo,
            pull_number: number,
            per_page: 100,
            page,
          }
        );
        return data;
      });
      // GitHub omits patches for large files; reuse ones we rebuilt before
      const result = carryOverRecoveredPatches(
        files,
        (await previous)?.data ?? []
      );
      cache.set(cacheKey, result, true);
      return result;
    })();

    cache.setPending(cacheKey, promise);
    return promise;
  }

  /**
   * Rebuild patches GitHub omitted (large diffs) from file contents at the
   * merge base and head. Runs after the PR renders; returns `files` itself
   * when nothing needed recovery.
   */
  async function recoverPRFilePatches(
    owner: string,
    repo: string,
    pr: PullRequest,
    files: PullRequestFile[]
  ): Promise<PullRequestFile[]> {
    if (!octokit) throw new Error("Not initialized");
    if (!files.some((file) => !file.patch && file.changes > 0)) return files;

    try {
      const { data } = await octokit.request(
        "GET /repos/{owner}/{repo}/compare/{basehead}",
        {
          owner,
          repo,
          basehead: `${pr.base.sha}...${pr.head.sha}`,
          per_page: 1,
        }
      );
      const recovered = await recoverPatches(
        files,
        data.merge_base_commit.sha,
        pr.head.sha,
        (path, ref) => getFileContent(owner, repo, path, ref, false),
        (oldContent, newContent) =>
          diffService.generatePatch(oldContent, newContent)
      );
      // Only store against the file list it was built from
      const cacheKey = cacheKeys.prFiles(owner, repo, pr.number);
      if (cache.getStale<PullRequestFile[]>(cacheKey)?.data === files) {
        cache.set(cacheKey, recovered, true);
      }
      return recovered;
    } catch (error) {
      console.error("Could not recover omitted pull request patches", error);
      return files;
    }
  }

  /**
   * Files changed between two commits of a PR (GitHub's compare endpoint).
   * Used for "changes since your last review". Returns null when the start
   * commit no longer exists (force-pushed away).
   *
   * With `baseSha` (the PR base), changes brought in by merging the base
   * branch between the two commits are left out (see rebase-range.ts).
   */
  async function getCompareFiles(
    owner: string,
    repo: string,
    startSha: string,
    headSha: string,
    baseSha?: string
  ): Promise<RangeFile[] | null> {
    if (!octokit) throw new Error("Not initialized");

    const cacheKey = `compare:${owner}/${repo}/${startSha}...${headSha}${
      baseSha ? `:rebased:${baseSha}` : ""
    }`;

    const cached = cache.get<RangeFile[]>(cacheKey);
    if (cached) return cached;

    const pending = cache.getPending<RangeFile[] | null>(cacheKey);
    if (pending) return pending;

    // Files are listed in full (up to 300) on the first page only.
    const compare = async (basehead: string) => {
      const { data } = await octokit!.request(
        "GET /repos/{owner}/{repo}/compare/{basehead}",
        { owner, repo, basehead, per_page: 1 }
      );
      return { files: data.files ?? [], mergeBase: data.merge_base_commit.sha };
    };

    // Null when a tree listing is itself truncated (over 100k entries).
    const rangeFromTreeListings = async (
      rangeFiles: PullRequestFile[],
      oldMergeBase: string,
      newMergeBase: string
    ): Promise<RangeFile[] | null> => {
      const trees = await Promise.all(
        [oldMergeBase, startSha, newMergeBase, headSha].map((sha) =>
          getTree(owner, repo, sha)
        )
      );
      if (trees.some((tree) => !tree)) return null;
      const [oldBase, start, newBase, end] = trees as Tree[];
      return rangeFromTrees({
        changes: treeChanges(oldBase, start, newBase, end),
        rangeFiles,
        startSha,
        endSha: headSha,
        oldMergeBase,
        newMergeBase,
        getBlobs: (requests) => getBlobs(owner, repo, requests),
        rebase: (baseOld, ours, baseNew, head) =>
          diffService.rebasePatch(baseOld, ours, baseNew, head),
      });
    };

    const promise = (async () => {
      // Where start and head branched from the base, fetched alongside the
      // range so a base merge costs no extra round trip to detect.
      const mergeBases = baseSha
        ? Promise.all([
            compare(`${baseSha}...${startSha}`),
            compare(`${baseSha}...${headSha}`),
          ])
        : null;
      mergeBases?.catch(() => {});

      let rangeFiles: PullRequestFile[];
      try {
        rangeFiles = (await compare(`${startSha}...${headSha}`)).files;
      } catch (error: unknown) {
        if (hasStatus(error, 404)) return null;
        throw error;
      }

      let files: RangeFile[] = rangeFiles;
      try {
        const [atStart, atEnd] = (await mergeBases) ?? [];
        const moved =
          !!atStart && !!atEnd && atStart.mergeBase !== atEnd.mergeBase;
        const oldMergeBase = moved ? atStart.mergeBase : startSha;
        const newMergeBase = moved ? atEnd.mergeBase : startSha;
        const base = moved
          ? await compare(`${oldMergeBase}...${newMergeBase}`)
          : null;
        // GitHub stops listing compare files at 300; past that, diff trees.
        const truncated = [rangeFiles, atStart?.files, atEnd?.files]
          .concat(moved ? [base?.files] : [])
          .some((list) => list && list.length >= COMPARE_FILE_LIMIT);
        if (truncated && (moved || rangeFiles.length >= COMPARE_FILE_LIMIT)) {
          const fromTrees = await rangeFromTreeListings(
            rangeFiles,
            oldMergeBase,
            newMergeBase
          );
          if (fromTrees) files = fromTrees;
        } else if (moved) {
          files = await rebaseRangeFiles({
            rangeFiles,
            prStartFiles: atStart.files,
            prEndFiles: atEnd.files,
            baseFiles: base!.files,
            startSha,
            endSha: headSha,
            oldMergeBase,
            newMergeBase,
            getContent: (path, ref) => getFileContent(owner, repo, path, ref),
            rebase: (baseOld, ours, baseNew, head) =>
              diffService.rebasePatch(baseOld, ours, baseNew, head),
          });
        }
      } catch (error) {
        console.error("Could not separate base branch changes", error);
      }

      const recovered = await recoverPatches(
        files,
        startSha,
        headSha,
        (path, ref) => getFileContent(owner, repo, path, ref, false),
        (oldContent, newContent) =>
          diffService.generatePatch(oldContent, newContent)
      );
      cache.set(cacheKey, recovered);
      return recovered;
    })();

    cache.setPending(cacheKey, promise);
    return promise;
  }

  /** Blob oids by path for a commit, or null when GitHub truncates it. */
  async function getTree(
    owner: string,
    repo: string,
    sha: string
  ): Promise<Tree | null> {
    if (!octokit) throw new Error("Not initialized");
    const cacheKey = `tree:${owner}/${repo}/${sha}`;
    const cached = cache.get<Tree>(cacheKey, Infinity);
    if (cached) return cached;
    const pending = cache.getPending<Tree | null>(cacheKey);
    if (pending) return pending;

    const promise = (async () => {
      const { data } = await octokit!.request(
        "GET /repos/{owner}/{repo}/git/trees/{tree_sha}",
        { owner, repo, tree_sha: sha, recursive: "1" }
      );
      if (data.truncated) return null;
      const tree: Tree = new Map();
      for (const entry of data.tree) {
        if (entry.type === "blob" && entry.path && entry.sha) {
          tree.set(entry.path, entry.sha);
        }
      }
      cache.set(cacheKey, tree);
      return tree;
    })();
    cache.setPending(cacheKey, promise);
    return promise;
  }

  /**
   * Blob text by oid, batched through GraphQL; null for binary blobs. Blobs
   * GraphQL truncates are fetched in full by path.
   */
  async function getBlobs(
    owner: string,
    repo: string,
    requests: BlobRequest[]
  ): Promise<Map<string, string | null>> {
    if (!gql) throw new Error("Not initialized");
    const result = new Map<string, string | null>();
    const byOid = new Map<string, BlobRequest>();
    for (const request of requests) {
      if (!/^[0-9a-f]{40,64}$/.test(request.oid)) continue;
      const cached = cache.get<{ text: string | null }>(
        `blob:${owner}/${repo}/${request.oid}`,
        Infinity
      );
      if (cached) result.set(request.oid, cached.text);
      else byOid.set(request.oid, request);
    }
    const pending = [...byOid.values()];
    const chunks: BlobRequest[][] = [];
    for (let i = 0; i < pending.length; i += 50) {
      chunks.push(pending.slice(i, i + 50));
    }

    type Blob = {
      text: string | null;
      isBinary: boolean;
      isTruncated: boolean;
    };
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(4, chunks.length) }, async () => {
        while (next < chunks.length) {
          const chunk = chunks[next++];
          const fields = chunk
            .map(
              (r, i) =>
                `b${i}: object(oid: "${r.oid}") { ... on Blob { text isBinary isTruncated } }`
            )
            .join("\n");
          const data = await gql!.query<{
            repository: Record<string, Blob | null>;
          }>(
            `query($owner: String!, $repo: String!) {
              repository(owner: $owner, name: $repo) { ${fields} }
            }`,
            { owner, repo }
          );
          await Promise.all(
            chunk.map(async (request, i) => {
              const blob = data.repository[`b${i}`];
              if (!blob) return;
              const text = blob.isBinary
                ? null
                : blob.isTruncated || blob.text === null
                  ? await getFileContent(
                      owner,
                      repo,
                      request.path,
                      request.ref,
                      false
                    )
                  : blob.text;
              // Wrapped so a binary blob's null isn't read as a cache miss
              cache.set(`blob:${owner}/${repo}/${request.oid}`, { text });
              result.set(request.oid, text);
            })
          );
        }
      })
    );
    return result;
  }

  async function getPRComments(
    owner: string,
    repo: string,
    number: number
  ): Promise<ReviewComment[]> {
    if (!octokit) throw new Error("Not initialized");

    const cacheKey = cacheKeys.prComments(owner, repo, number);

    const cached = cache.get<ReviewComment[]>(cacheKey);
    if (cached) return cached;

    const pending = cache.getPending<ReviewComment[]>(cacheKey);
    if (pending) return pending;

    const promise = (async () => {
      const comments: ReviewComment[] = [];
      let page = 1;

      while (true) {
        const { data } = await octokit!.request(
          "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
          {
            owner,
            repo,
            pull_number: number,
            per_page: 100,
            page,
            headers: {
              // Request full media type to get both body and body_html with signed attachment URLs
              accept: "application/vnd.github.full+json",
            },
          }
        );
        comments.push(...(data as ReviewComment[]));
        if (data.length < 100) break;
        page++;
      }

      cache.set(cacheKey, comments, true);
      return comments;
    })();

    cache.setPending(cacheKey, promise);
    return promise;
  }

  async function createPRComment(
    owner: string,
    repo: string,
    number: number,
    body: string,
    options?: {
      reply_to_id?: number;
      commit_id?: string;
      path?: string;
      line?: number;
      side?: "LEFT" | "RIGHT";
    }
  ): Promise<ReviewComment> {
    if (!octokit) throw new Error("Not initialized");

    let result: ReviewComment;

    if (options?.reply_to_id) {
      const { data } = await octokit.request(
        "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments/{comment_id}/replies",
        {
          owner,
          repo,
          pull_number: number,
          comment_id: options.reply_to_id,
          body,
        }
      );
      result = data;
    } else {
      const { data } = await octokit.request(
        "POST /repos/{owner}/{repo}/pulls/{pull_number}/comments",
        {
          owner,
          repo,
          pull_number: number,
          body,
          commit_id: options?.commit_id!,
          path: options?.path!,
          line: options?.line!,
          side: options?.side ?? "RIGHT",
        }
      );
      result = data;
    }

    cache.invalidate(cacheKeys.prComments(owner, repo, number));
    cache.invalidate(cacheKeys.prThreads(owner, repo, number));
    return result;
  }

  async function getPRReviews(
    owner: string,
    repo: string,
    number: number
  ): Promise<Review[]> {
    if (!octokit) throw new Error("Not initialized");

    const cacheKey = cacheKeys.prReviews(owner, repo, number);

    const cached = cache.get<Review[]>(cacheKey);
    if (cached) return cached;

    const pending = cache.getPending<Review[]>(cacheKey);
    if (pending) return pending;

    const promise = fetchAllPages(async (page) => {
      const { data } = await octokit!.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
        {
          owner,
          repo,
          pull_number: number,
          per_page: 100,
          page,
          headers: {
            // Request full media type to get both body and body_html with signed attachment URLs
            accept: "application/vnd.github.full+json",
          },
        }
      );
      return data as Review[];
    }).then((reviews) => {
      cache.set(cacheKey, reviews, true);
      return reviews;
    });

    cache.setPending(cacheKey, promise);
    return promise;
  }

  async function createPRReview(
    owner: string,
    repo: string,
    number: number,
    options: {
      commit_id: string;
      event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
      body?: string;
      comments?: Array<{
        path: string;
        line: number;
        body: string;
        side?: "LEFT" | "RIGHT";
        start_line?: number;
      }>;
    }
  ): Promise<Review> {
    if (!octokit) throw new Error("Not initialized");

    const { data } = await octokit.request(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      {
        owner,
        repo,
        pull_number: number,
        commit_id: options.commit_id,
        event: options.event,
        body: options.body ?? "",
        comments: options.comments ?? [],
      }
    );

    cache.invalidate(`pr:${owner}/${repo}/${number}`);
    return data;
  }

  async function submitPRReview(
    owner: string,
    repo: string,
    number: number,
    reviewId: number,
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
    body?: string
  ): Promise<Review> {
    if (!octokit) throw new Error("Not initialized");

    const { data } = await octokit.request(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/events",
      {
        owner,
        repo,
        pull_number: number,
        review_id: reviewId,
        event,
        body: body ?? "",
      }
    );

    cache.invalidate(`pr:${owner}/${repo}/${number}`);
    return data;
  }

  async function deletePRReview(
    owner: string,
    repo: string,
    number: number,
    reviewId: number
  ): Promise<void> {
    if (!octokit) throw new Error("Not initialized");

    await octokit.request(
      "DELETE /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}",
      {
        owner,
        repo,
        pull_number: number,
        review_id: reviewId,
      }
    );
    cache.invalidate(`pr:${owner}/${repo}/${number}`);
  }

  async function getPRChecksForSha(owner: string, repo: string, sha: string) {
    if (!octokit) throw new Error("Not initialized");

    const cacheKey = cacheKeys.checks(owner, repo, sha);

    type ChecksResult = { checkRuns: CheckRun[]; status: CombinedStatus };

    const cached = cache.get<ChecksResult>(cacheKey, 15_000);
    if (cached) return cached;

    const pending = cache.getPending<ChecksResult>(cacheKey);
    if (pending) return pending;

    const promise = Promise.all([
      octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
        owner,
        repo,
        ref: sha,
      }),
      octokit.request("GET /repos/{owner}/{repo}/commits/{ref}/status", {
        owner,
        repo,
        ref: sha,
      }),
    ]).then(([checkRunsRes, statusRes]) => {
      const result = {
        checkRuns: checkRunsRes.data.check_runs,
        status: statusRes.data,
      };
      cache.set(cacheKey, result, true);
      return result;
    });

    cache.setPending(cacheKey, promise);
    return promise;
  }

  async function getWorkflowRunsForSha(
    owner: string,
    repo: string,
    sha: string
  ) {
    if (!octokit) throw new Error("Not initialized");

    const cacheKey = cacheKeys.workflowRuns(owner, repo, sha);

    type WorkflowRunsResult = {
      workflow_runs: Array<{
        id: number;
        name: string;
        status: string;
        conclusion: string | null;
        html_url: string;
        head_sha: string;
      }>;
    };

    const cached = cache.get<WorkflowRunsResult>(cacheKey, 15_000);
    if (cached) return cached;

    const pending = cache.getPending<WorkflowRunsResult>(cacheKey);
    if (pending) return pending;

    const promise = octokit
      .request("GET /repos/{owner}/{repo}/actions/runs", {
        owner,
        repo,
        head_sha: sha,
        per_page: 50,
      })
      .then((res) => {
        const result = {
          workflow_runs: res.data.workflow_runs,
        };
        cache.set(cacheKey, result, true);
        return result;
      });

    cache.setPending(cacheKey, promise);
    return promise;
  }

  async function approveWorkflowRun(
    owner: string,
    repo: string,
    runId: number
  ) {
    if (!octokit) throw new Error("Not initialized");

    await octokit.request(
      "POST /repos/{owner}/{repo}/actions/runs/{run_id}/approve",
      {
        owner,
        repo,
        run_id: runId,
      }
    );

    // Invalidate workflow runs cache for this repo
    cache.invalidate(`workflow-runs:${owner}/${repo}`);
  }

  async function mergePR(
    owner: string,
    repo: string,
    number: number,
    options?: {
      merge_method?: "merge" | "squash" | "rebase";
      commit_title?: string;
      commit_message?: string;
    }
  ) {
    if (!octokit) throw new Error("Not initialized");

    const { data } = await octokit.request(
      "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
      {
        owner,
        repo,
        pull_number: number,
        merge_method: options?.merge_method ?? "squash",
        commit_title: options?.commit_title,
        commit_message: options?.commit_message,
      }
    );

    cache.invalidate(`pr:${owner}/${repo}/${number}`);
    return data;
  }

  async function getAutoMergeState(
    owner: string,
    repo: string,
    number: number
  ): Promise<AutoMergeState> {
    if (!gql) throw new Error("Not initialized");

    const data = await gql.query<{
      repository: {
        pullRequest: {
          id: string;
          viewerCanEnableAutoMerge: boolean;
          viewerCanDisableAutoMerge: boolean;
          autoMergeRequest: {
            mergeMethod: "MERGE" | "SQUASH" | "REBASE";
            enabledBy: { login: string } | null;
          } | null;
        };
      };
    }>(
      `query ($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            id
            viewerCanEnableAutoMerge
            viewerCanDisableAutoMerge
            autoMergeRequest {
              mergeMethod
              enabledBy { login }
            }
          }
        }
      }`,
      { owner, repo, number }
    );

    const pr = data.repository.pullRequest;
    const request = pr.autoMergeRequest;
    return {
      pullRequestId: pr.id,
      canEnable: pr.viewerCanEnableAutoMerge,
      canDisable: pr.viewerCanDisableAutoMerge,
      request: request && {
        mergeMethod: request.mergeMethod.toLowerCase() as MergeMethod,
        enabledBy: request.enabledBy?.login ?? null,
      },
    };
  }

  async function enableAutoMerge(
    pullRequestId: string,
    mergeMethod: MergeMethod
  ): Promise<void> {
    if (!gql) throw new Error("Not initialized");
    await gql.query(
      `mutation ($input: EnablePullRequestAutoMergeInput!) { enablePullRequestAutoMerge(input: $input) { clientMutationId } }`,
      { input: { pullRequestId, mergeMethod: mergeMethod.toUpperCase() } }
    );
  }

  async function disableAutoMerge(pullRequestId: string): Promise<void> {
    if (!gql) throw new Error("Not initialized");
    await gql.query(
      `mutation ($input: DisablePullRequestAutoMergeInput!) { disablePullRequestAutoMerge(input: $input) { clientMutationId } }`,
      { input: { pullRequestId } }
    );
  }

  async function getPRCommits(owner: string, repo: string, number: number) {
    if (!octokit) throw new Error("Not initialized");

    const cacheKey = cacheKeys.prCommits(owner, repo, number);

    const cached = cache.get<components["schemas"]["commit"][]>(cacheKey);
    if (cached) return cached;

    const pending =
      cache.getPending<components["schemas"]["commit"][]>(cacheKey);
    if (pending) return pending;

    const promise = fetchAllPages(async (page) => {
      const { data } = await octokit!.request(
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits",
        {
          owner,
          repo,
          pull_number: number,
          per_page: 100,
          page,
        }
      );
      return data;
    }).then((commits) => {
      cache.set(cacheKey, commits, true);
      return commits;
    });

    cache.setPending(cacheKey, promise);
    return promise;
  }

  async function requestReviewers(
    owner: string,
    repo: string,
    number: number,
    reviewers: string[]
  ) {
    if (!octokit) throw new Error("Not initialized");

    const { data } = await octokit.request(
      "POST /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
      {
        owner,
        repo,
        pull_number: number,
        reviewers,
      }
    );

    cache.invalidate(`pr:${owner}/${repo}/${number}`);
    return data;
  }

  async function removeReviewers(
    owner: string,
    repo: string,
    number: number,
    reviewers: string[]
  ) {
    if (!octokit) throw new Error("Not initialized");

    await octokit.request(
      "DELETE /repos/{owner}/{repo}/pulls/{pull_number}/requested_reviewers",
      {
        owner,
        repo,
        pull_number: number,
        reviewers,
      }
    );

    cache.invalidate(`pr:${owner}/${repo}/${number}`);
  }

  async function getRepoCollaborators(owner: string, repo: string) {
    if (!octokit) throw new Error("Not initialized");

    const cacheKey = `repo:${owner}/${repo}:collaborators`;

    const cached = cache.get<components["schemas"]["collaborator"][]>(
      cacheKey,
      300_000
    );
    if (cached) return cached;

    const pending =
      cache.getPending<components["schemas"]["collaborator"][]>(cacheKey);
    if (pending) return pending;

    const promise = octokit
      .request("GET /repos/{owner}/{repo}/collaborators", {
        owner,
        repo,
        per_page: 100,
      })
      .then((res) => {
        cache.set(cacheKey, res.data);
        return res.data;
      });

    cache.setPending(cacheKey, promise);
    return promise;
  }

  async function addAssignees(
    owner: string,
    repo: string,
    issueNumber: number,
    assignees: string[]
  ) {
    if (!octokit) throw new Error("Not initialized");

    const { data } = await octokit.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/assignees",
      {
        owner,
        repo,
        issue_number: issueNumber,
        assignees,
      }
    );

    cache.invalidate(`pr:${owner}/${repo}/${issueNumber}`);
    return data;
  }

  async function removeAssignees(
    owner: string,
    repo: string,
    issueNumber: number,
    assignees: string[]
  ) {
    if (!octokit) throw new Error("Not initialized");

    await octokit.request(
      "DELETE /repos/{owner}/{repo}/issues/{issue_number}/assignees",
      {
        owner,
        repo,
        issue_number: issueNumber,
        assignees,
      }
    );

    cache.invalidate(`pr:${owner}/${repo}/${issueNumber}`);
  }

  async function getRepoLabels(owner: string, repo: string) {
    if (!octokit) throw new Error("Not initialized");

    const cacheKey = `repo:${owner}/${repo}:labels`;

    const cached = cache.get<
      Array<{ name: string; color: string; description: string | null }>
    >(cacheKey, 300_000);
    if (cached) return cached;

    const pending =
      cache.getPending<
        Array<{ name: string; color: string; description: string | null }>
      >(cacheKey);
    if (pending) return pending;

    const promise = (async () => {
      // Manually paginate to get all labels
      const allLabels: Array<{
        name: string;
        color: string;
        description: string | null;
      }> = [];
      let page = 1;
      while (true) {
        const { data: labels } = await octokit.request(
          "GET /repos/{owner}/{repo}/labels",
          {
            owner,
            repo,
            per_page: 100,
            page,
          }
        );
        for (const l of labels) {
          allLabels.push({
            name: l.name,
            color: l.color,
            description: l.description ?? null,
          });
        }
        if (labels.length < 100) break;
        page++;
      }
      cache.set(cacheKey, allLabels);
      cache.clearPending(cacheKey);
      return allLabels;
    })();

    cache.setPending(cacheKey, promise);
    return promise;
  }

  async function addLabels(
    owner: string,
    repo: string,
    issueNumber: number,
    labels: string[]
  ) {
    if (!octokit) throw new Error("Not initialized");

    const { data } = await octokit.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/labels",
      {
        owner,
        repo,
        issue_number: issueNumber,
        labels,
      }
    );

    cache.invalidate(`pr:${owner}/${repo}/${issueNumber}`);
    return data;
  }

  async function removeLabel(
    owner: string,
    repo: string,
    issueNumber: number,
    labelName: string
  ) {
    if (!octokit) throw new Error("Not initialized");

    await octokit.request(
      "DELETE /repos/{owner}/{repo}/issues/{issue_number}/labels/{name}",
      {
        owner,
        repo,
        issue_number: issueNumber,
        name: labelName,
      }
    );

    cache.invalidate(`pr:${owner}/${repo}/${issueNumber}`);
  }

  async function convertToDraft(owner: string, repo: string, number: number) {
    if (!gql) throw new Error("Not initialized");

    const prData = await gql.query<{
      repository: { pullRequest: { id: string } };
    }>(
      `query ($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { id } } }`,
      { owner, repo, number }
    );

    await gql.query(
      `mutation ($input: ConvertPullRequestToDraftInput!) { convertPullRequestToDraft(input: $input) { pullRequest { id } } }`,
      { input: { pullRequestId: prData.repository.pullRequest.id } }
    );

    cache.invalidate(`pr:${owner}/${repo}/${number}`);
  }

  async function markReadyForReview(
    owner: string,
    repo: string,
    number: number
  ) {
    if (!gql) throw new Error("Not initialized");

    const prData = await gql.query<{
      repository: { pullRequest: { id: string } };
    }>(
      `query ($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { id } } }`,
      { owner, repo, number }
    );

    await gql.query(
      `mutation ($input: MarkPullRequestReadyForReviewInput!) { markPullRequestReadyForReview(input: $input) { pullRequest { id } } }`,
      { input: { pullRequestId: prData.repository.pullRequest.id } }
    );

    cache.invalidate(`pr:${owner}/${repo}/${number}`);
  }

  async function updateBranch(owner: string, repo: string, number: number) {
    if (!octokit) throw new Error("Not initialized");

    const { data } = await octokit.request(
      "PUT /repos/{owner}/{repo}/pulls/{pull_number}/update-branch",
      {
        owner,
        repo,
        pull_number: number,
      }
    );

    cache.invalidate(`pr:${owner}/${repo}/${number}`);
    return data;
  }

  // Reaction types: +1, -1, laugh, hooray, confused, heart, rocket, eyes
  type ReactionContent =
    | "+1"
    | "-1"
    | "laugh"
    | "hooray"
    | "confused"
    | "heart"
    | "rocket"
    | "eyes";

  async function getIssueReactions(
    owner: string,
    repo: string,
    issueNumber: number
  ) {
    if (!octokit) throw new Error("Not initialized");

    const cacheKey = `reactions:issue:${owner}/${repo}/${issueNumber}`;

    const cached = cache.get<components["schemas"]["reaction"][]>(
      cacheKey,
      30_000
    );
    if (cached) return cached;

    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}/reactions",
      {
        owner,
        repo,
        issue_number: issueNumber,
        per_page: 100,
      }
    );

    cache.set(cacheKey, data);
    return data;
  }

  async function addIssueReaction(
    owner: string,
    repo: string,
    issueNumber: number,
    content: ReactionContent
  ) {
    if (!octokit) throw new Error("Not initialized");

    const { data } = await octokit.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/reactions",
      {
        owner,
        repo,
        issue_number: issueNumber,
        content,
      }
    );

    cache.invalidate(`reactions:issue:${owner}/${repo}/${issueNumber}`);
    return data;
  }

  async function deleteIssueReaction(
    owner: string,
    repo: string,
    issueNumber: number,
    reactionId: number
  ) {
    if (!octokit) throw new Error("Not initialized");

    await octokit.request(
      "DELETE /repos/{owner}/{repo}/issues/{issue_number}/reactions/{reaction_id}",
      {
        owner,
        repo,
        issue_number: issueNumber,
        reaction_id: reactionId,
      }
    );

    cache.invalidate(`reactions:issue:${owner}/${repo}/${issueNumber}`);
  }

  async function getCommentReactions(
    owner: string,
    repo: string,
    commentId: number
  ) {
    if (!octokit) throw new Error("Not initialized");

    const cacheKey = `reactions:comment:${owner}/${repo}/${commentId}`;

    const cached = cache.get<components["schemas"]["reaction"][]>(
      cacheKey,
      30_000
    );
    if (cached) return cached;

    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions",
      {
        owner,
        repo,
        comment_id: commentId,
        per_page: 100,
      }
    );

    cache.set(cacheKey, data);
    return data;
  }

  async function addCommentReaction(
    owner: string,
    repo: string,
    commentId: number,
    content: ReactionContent
  ) {
    if (!octokit) throw new Error("Not initialized");

    const { data } = await octokit.request(
      "POST /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions",
      {
        owner,
        repo,
        comment_id: commentId,
        content,
      }
    );

    cache.invalidate(`reactions:comment:${owner}/${repo}/${commentId}`);
    return data;
  }

  async function deleteCommentReaction(
    owner: string,
    repo: string,
    commentId: number,
    reactionId: number
  ) {
    if (!octokit) throw new Error("Not initialized");

    await octokit.request(
      "DELETE /repos/{owner}/{repo}/issues/comments/{comment_id}/reactions/{reaction_id}",
      {
        owner,
        repo,
        comment_id: commentId,
        reaction_id: reactionId,
      }
    );

    cache.invalidate(`reactions:comment:${owner}/${repo}/${commentId}`);
  }

  // Pull Request Review Comment Reactions (different from issue comments)
  async function getReviewCommentReactions(
    owner: string,
    repo: string,
    commentId: number
  ) {
    if (!octokit) throw new Error("Not initialized");

    const cacheKey = `reactions:review-comment:${owner}/${repo}/${commentId}`;

    const cached = cache.get<components["schemas"]["reaction"][]>(
      cacheKey,
      30_000
    );
    if (cached) return cached;

    const { data } = await octokit.request(
      "GET /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions",
      {
        owner,
        repo,
        comment_id: commentId,
        per_page: 100,
      }
    );

    cache.set(cacheKey, data);
    return data;
  }

  async function addReviewCommentReaction(
    owner: string,
    repo: string,
    commentId: number,
    content: ReactionContent
  ) {
    if (!octokit) throw new Error("Not initialized");

    const { data } = await octokit.request(
      "POST /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions",
      {
        owner,
        repo,
        comment_id: commentId,
        content,
      }
    );

    cache.invalidate(`reactions:review-comment:${owner}/${repo}/${commentId}`);
    return data;
  }

  async function deleteReviewCommentReaction(
    owner: string,
    repo: string,
    commentId: number,
    reactionId: number
  ) {
    if (!octokit) throw new Error("Not initialized");

    await octokit.request(
      "DELETE /repos/{owner}/{repo}/pulls/comments/{comment_id}/reactions/{reaction_id}",
      {
        owner,
        repo,
        comment_id: commentId,
        reaction_id: reactionId,
      }
    );

    cache.invalidate(`reactions:review-comment:${owner}/${repo}/${commentId}`);
  }

  async function closePR(owner: string, repo: string, number: number) {
    if (!octokit) throw new Error("Not initialized");

    const { data } = await octokit.request(
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner,
        repo,
        pull_number: number,
        state: "closed",
      }
    );

    cache.invalidate(`pr:${owner}/${repo}/${number}`);
    return data;
  }

  async function reopenPR(owner: string, repo: string, number: number) {
    if (!octokit) throw new Error("Not initialized");

    const { data } = await octokit.request(
      "PATCH /repos/{owner}/{repo}/pulls/{pull_number}",
      {
        owner,
        repo,
        pull_number: number,
        state: "open",
      }
    );

    cache.invalidate(`pr:${owner}/${repo}/${number}`);
    return data;
  }

  async function deleteBranch(owner: string, repo: string, branch: string) {
    if (!octokit) throw new Error("Not initialized");

    await octokit.request("DELETE /repos/{owner}/{repo}/git/refs/{ref}", {
      owner,
      repo,
      ref: `heads/${branch}`,
    });
  }

  async function restoreBranch(
    owner: string,
    repo: string,
    branch: string,
    sha: string
  ) {
    if (!octokit) throw new Error("Not initialized");

    await octokit.request("POST /repos/{owner}/{repo}/git/refs", {
      owner,
      repo,
      ref: `refs/heads/${branch}`,
      sha,
    });
  }

  async function getPRConversation(
    owner: string,
    repo: string,
    number: number
  ): Promise<IssueComment[]> {
    if (!octokit) throw new Error("Not initialized");

    const cacheKey = cacheKeys.prConversation(owner, repo, number);

    const cached = cache.get<IssueComment[]>(cacheKey);
    if (cached) return cached;

    const pending = cache.getPending<IssueComment[]>(cacheKey);
    if (pending) return pending;

    const promise = fetchAllPages(async (page) => {
      const { data } = await octokit!.request(
        "GET /repos/{owner}/{repo}/issues/{issue_number}/comments",
        {
          owner,
          repo,
          issue_number: number,
          per_page: 100,
          page,
          headers: {
            // Request full media type to get both body and body_html with signed attachment URLs
            accept: "application/vnd.github.full+json",
          },
        }
      );
      return data as IssueComment[];
    }).then((comments) => {
      cache.set(cacheKey, comments, true);
      return comments;
    });

    cache.setPending(cacheKey, promise);
    return promise;
  }

  async function createPRConversationComment(
    owner: string,
    repo: string,
    number: number,
    body: string
  ): Promise<IssueComment> {
    if (!octokit) throw new Error("Not initialized");

    const { data } = await octokit.request(
      "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      {
        owner,
        repo,
        issue_number: number,
        body,
      }
    );
    cache.invalidate(`pr:${owner}/${repo}/${number}:conversation`);
    return data;
  }

  async function getPRTimeline(
    owner: string,
    repo: string,
    number: number
  ): Promise<TimelineEvent[]> {
    if (!octokit) throw new Error("Not initialized");

    const cacheKey = cacheKeys.prTimeline(owner, repo, number);

    const cached = cache.get<TimelineEvent[]>(cacheKey);
    if (cached) return cached;

    const pending = cache.getPending<TimelineEvent[]>(cacheKey);
    if (pending) return pending;

    const promise = fetchAllPages(async (page) => {
      const { data } = await octokit!.request(
        "GET /repos/{owner}/{repo}/issues/{issue_number}/timeline",
        {
          owner,
          repo,
          issue_number: number,
          per_page: 100,
          page,
        }
      );
      return data as TimelineEvent[];
    }).then((timeline) => {
      cache.set(cacheKey, timeline, true);
      return timeline;
    });

    cache.setPending(cacheKey, promise);
    return promise;
  }

  async function getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref: string,
    allowMissing = true
  ): Promise<string> {
    try {
      return await loadFileContent(owner, repo, path, ref);
    } catch (error: unknown) {
      if (allowMissing && hasStatus(error, 404)) return "";
      throw error;
    }
  }

  async function loadFileContent(
    owner: string,
    repo: string,
    path: string,
    ref: string
  ): Promise<string> {
    if (!octokit) throw new Error("Not initialized");

    const cacheKey = `file:${owner}/${repo}/${ref}/${path}`;
    const immutable = isCommitSha(ref);

    const cached = cache.get<string>(cacheKey, immutable ? Infinity : 300_000);
    if (cached !== null) return cached;

    const pending = cache.getPending<string>(cacheKey);
    if (pending) return pending;

    const promise = (async () => {
      if (immutable) {
        const stored = await cache.peek<string>(cacheKey);
        if (stored) return stored.data;
      }
      const response = await octokit!.request(
        "GET /repos/{owner}/{repo}/contents/{path}",
        {
          owner,
          repo,
          path,
          ref,
          headers: { Accept: "application/vnd.github.raw+json" },
        }
      );
      const content = response.data as unknown as string;
      cache.set(
        cacheKey,
        content,
        immutable && content.length <= MAX_PERSISTED_FILE_CHARS
      );
      return content;
    })();

    cache.setPending(cacheKey, promise);
    return promise;
  }

  // ---------------------------------------------------------------------------
  // GraphQL Methods
  // ---------------------------------------------------------------------------

  async function graphql<T>(
    query: string,
    variables?: Record<string, unknown>
  ): Promise<T> {
    if (!gql) throw new Error("Not initialized");
    return gql.query<T>(query, variables);
  }

  async function getPREnrichment(
    prs: Array<{ owner: string; repo: string; number: number }>
  ): Promise<Map<string, PREnrichment>> {
    if (!gql || prs.length === 0) return new Map();

    const prQueries = prs
      .map(
        (pr, idx) => `
      pr${idx}: repository(owner: "${pr.owner}", name: "${pr.repo}") {
        pullRequest(number: ${pr.number}) {
          number
          changedFiles
          additions
          deletions
          reviewDecision
          latestOpinionatedReviews(first: 10) {
            nodes {
              author {
                login
                avatarUrl
              }
              state
            }
          }
          commits(last: 1) {
            nodes {
              commit {
                committedDate
                statusCheckRollup {
                  state
                  contexts(first: 50) {
                    nodes {
                      __typename
                      ... on CheckRun {
                        name
                        conclusion
                        status
                      }
                      ... on StatusContext {
                        context
                        state
                      }
                    }
                  }
                }
              }
            }
          }
          viewerLatestReview {
            submittedAt
          }
        }
      }
    `
      )
      .join("\n");

    type CheckContext =
      | {
          __typename: "CheckRun";
          name: string;
          conclusion: string | null;
          status: string;
        }
      | {
          __typename: "StatusContext";
          context: string;
          state: string;
        };

    const data = await gql.query<
      Record<
        string,
        {
          pullRequest: {
            number: number;
            changedFiles: number;
            additions: number;
            deletions: number;
            reviewDecision:
              | "APPROVED"
              | "CHANGES_REQUESTED"
              | "REVIEW_REQUIRED"
              | null;
            latestOpinionatedReviews: {
              nodes: Array<{
                author: { login: string; avatarUrl: string } | null;
                state: "APPROVED" | "CHANGES_REQUESTED";
              }>;
            };
            commits: {
              nodes: Array<{
                commit: {
                  committedDate: string;
                  statusCheckRollup: {
                    state:
                      | "EXPECTED"
                      | "ERROR"
                      | "FAILURE"
                      | "PENDING"
                      | "SUCCESS";
                    contexts: {
                      nodes: CheckContext[];
                    };
                  } | null;
                };
              }>;
            };
            viewerLatestReview: { submittedAt: string } | null;
          } | null;
        }
      >
    >(`query { ${prQueries} }`);

    const enrichmentMap = new Map<string, PREnrichment>();

    prs.forEach((pr, idx) => {
      const result = data[`pr${idx}`]?.pullRequest;
      if (result) {
        const lastCommit = result.commits.nodes[0]?.commit;
        const lastCommitAt = lastCommit?.committedDate || null;
        const viewerLastReviewAt =
          result.viewerLatestReview?.submittedAt || null;
        let hasNewChanges = false;
        if (viewerLastReviewAt && lastCommitAt) {
          hasNewChanges = new Date(lastCommitAt) > new Date(viewerLastReviewAt);
        }

        // Map GraphQL status to our CI status
        const statusState = lastCommit?.statusCheckRollup?.state;
        let ciStatus: PREnrichment["ciStatus"] = "none";
        if (statusState) {
          if (statusState === "SUCCESS") {
            ciStatus = "success";
          } else if (statusState === "FAILURE" || statusState === "ERROR") {
            ciStatus = "failure";
          } else if (statusState === "PENDING" || statusState === "EXPECTED") {
            ciStatus = "pending";
          }
        }

        // Parse check contexts for detailed info
        const contexts = lastCommit?.statusCheckRollup?.contexts?.nodes || [];
        const ciChecks: PREnrichment["ciChecks"] = contexts.map((ctx) => {
          if (ctx.__typename === "CheckRun") {
            let state: "pending" | "success" | "failure" = "pending";
            if (ctx.status === "COMPLETED") {
              state = ctx.conclusion === "SUCCESS" ? "success" : "failure";
            }
            return { name: ctx.name, state };
          } else {
            // StatusContext
            const state =
              ctx.state === "SUCCESS"
                ? "success"
                : ctx.state === "FAILURE" || ctx.state === "ERROR"
                  ? "failure"
                  : "pending";
            return { name: ctx.context, state };
          }
        });

        // Build summary
        let ciSummary = "";
        if (ciChecks.length > 0) {
          const passed = ciChecks.filter((c) => c.state === "success").length;
          const failed = ciChecks.filter((c) => c.state === "failure").length;
          const pending = ciChecks.filter((c) => c.state === "pending").length;

          if (failed > 0) {
            const failedCheck = ciChecks.find((c) => c.state === "failure");
            ciSummary = failedCheck ? failedCheck.name : `${failed} failed`;
          } else if (pending > 0) {
            const pendingCheck = ciChecks.find((c) => c.state === "pending");
            ciSummary = pendingCheck ? pendingCheck.name : `${pending} running`;
          } else {
            ciSummary = `${passed}/${ciChecks.length} passed`;
          }
        }

        // Parse latest reviews - deduplicate by user (keep latest)
        const reviewsByUser = new Map<
          string,
          {
            login: string;
            avatarUrl: string;
            state: "APPROVED" | "CHANGES_REQUESTED";
          }
        >();
        for (const review of result.latestOpinionatedReviews?.nodes || []) {
          if (review.author) {
            reviewsByUser.set(review.author.login, {
              login: review.author.login,
              avatarUrl: review.author.avatarUrl,
              state: review.state,
            });
          }
        }
        const latestReviews = Array.from(reviewsByUser.values());

        enrichmentMap.set(`${pr.owner}/${pr.repo}/${pr.number}`, {
          changedFiles: result.changedFiles,
          additions: result.additions,
          deletions: result.deletions,
          lastCommitAt,
          viewerLastReviewAt,
          hasNewChanges,
          ciStatus,
          ciSummary,
          ciChecks,
          reviewDecision: result.reviewDecision,
          latestReviews,
        });
      }
    });

    return enrichmentMap;
  }

  interface ReviewThreadsResult {
    threads: ReviewThread[];
    viewerPermission: string | null;
    viewerCanMergeAsAdmin: boolean;
  }

  async function getReviewThreads(
    owner: string,
    repo: string,
    number: number
  ): Promise<ReviewThreadsResult> {
    if (!gql) throw new Error("Not initialized");

    const cacheKey = cacheKeys.prThreads(owner, repo, number);

    const cached = cache.get<ReviewThreadsResult>(cacheKey);
    if (cached) return cached;

    const pending = cache.getPending<ReviewThreadsResult>(cacheKey);
    if (pending) return pending;

    const promise = fetchReviewThreads(owner, repo, number).then((result) => {
      cache.set(cacheKey, result, true);
      return result;
    });

    cache.setPending(cacheKey, promise);
    return promise;
  }

  async function fetchReviewThreads(
    owner: string,
    repo: string,
    number: number
  ): Promise<ReviewThreadsResult> {
    if (!gql) throw new Error("Not initialized");

    // Raw GraphQL response type (comments include pullRequestReview)
    interface RawReviewThread {
      id: string;
      isResolved: boolean;
      resolvedBy: { login: string; avatarUrl: string } | null;
      comments: {
        nodes: Array<{
          id: string;
          databaseId: number;
          body: string;
          bodyHTML: string;
          path: string;
          line: number | null;
          originalLine: number | null;
          startLine: number | null;
          diffHunk: string | null;
          author: { login: string; avatarUrl: string } | null;
          createdAt: string;
          updatedAt: string;
          replyTo: { databaseId: number } | null;
          pullRequestReview: {
            databaseId: number;
            author: { login: string; avatarUrl: string } | null;
          } | null;
        }>;
      };
    }

    const query = `
      query ($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          viewerPermission
          pullRequest(number: $number) {
            viewerCanMergeAsAdmin
            reviewThreads(first: 100, after: $cursor) {
              pageInfo { hasNextPage endCursor }
              nodes {
                id
                isResolved
                resolvedBy { login avatarUrl }
                comments(first: 100) {
                  nodes {
                    id
                    databaseId
                    body
                    bodyHTML
                    path
                    line
                    originalLine
                    startLine
                    diffHunk
                    author { login avatarUrl }
                    createdAt
                    updatedAt
                    replyTo { databaseId }
                    pullRequestReview {
                      databaseId
                      author { login avatarUrl }
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const allThreads: RawReviewThread[] = [];
    let cursor: string | null = null;
    let viewerPermission: string | null = null;
    let viewerCanMergeAsAdmin = false;

    while (true) {
      const data: {
        repository: {
          viewerPermission: string | null;
          pullRequest: {
            viewerCanMergeAsAdmin: boolean;
            reviewThreads: {
              nodes: RawReviewThread[];
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
            };
          };
        };
      } = await gql.query(query, { owner, repo, number, cursor });

      viewerPermission = data.repository.viewerPermission;
      viewerCanMergeAsAdmin = data.repository.pullRequest.viewerCanMergeAsAdmin;
      allThreads.push(...data.repository.pullRequest.reviewThreads.nodes);
      const pageInfo = data.repository.pullRequest.reviewThreads.pageInfo;
      if (!pageInfo.hasNextPage || !pageInfo.endCursor) break;
      cursor = pageInfo.endCursor;
    }

    // Extract pullRequestReview from first comment into thread object
    const threads = allThreads.map((thread) => {
      const firstComment = thread.comments.nodes[0];
      return {
        ...thread,
        pullRequestReview: firstComment?.pullRequestReview ?? null,
      };
    });

    return {
      threads,
      viewerPermission,
      viewerCanMergeAsAdmin,
    };
  }

  async function resolveThread(threadId: string): Promise<void> {
    if (!gql) throw new Error("Not initialized");
    await gql.query(
      `mutation ($input: ResolveReviewThreadInput!) { resolveReviewThread(input: $input) { thread { id } } }`,
      { input: { threadId } }
    );
  }

  async function unresolveThread(threadId: string): Promise<void> {
    if (!gql) throw new Error("Not initialized");
    await gql.query(
      `mutation ($input: UnresolveReviewThreadInput!) { unresolveReviewThread(input: $input) { thread { id } } }`,
      { input: { threadId } }
    );
  }

  async function getPendingReview(
    owner: string,
    repo: string,
    number: number
  ): Promise<PendingReview | null> {
    if (!gql) throw new Error("Not initialized");

    const data = await gql.query<{
      repository: {
        pullRequest: {
          reviews: { nodes: PendingReview[] };
        };
      };
    }>(
      `
      query ($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            reviews(first: 10, states: [PENDING]) {
              nodes {
                id
                databaseId
                viewerDidAuthor
                comments(first: 100) {
                    nodes { id databaseId body path line startLine }
                }
              }
            }
          }
        }
      }
    `,
      { owner, repo, number }
    );

    return (
      data.repository.pullRequest.reviews.nodes.find(
        (r) => r.viewerDidAuthor
      ) || null
    );
  }

  async function addPendingComment(
    owner: string,
    repo: string,
    number: number,
    options: {
      path: string;
      line: number;
      body: string;
      startLine?: number;
      side?: "LEFT" | "RIGHT";
    }
  ): Promise<{
    reviewId: string;
    commentId: string;
    commentDatabaseId: number;
  }> {
    if (!gql) throw new Error("Not initialized");

    const prData = await gql.query<{
      repository: { pullRequest: { id: string } };
    }>(
      `query ($owner: String!, $repo: String!, $number: Int!) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { id } } }`,
      { owner, repo, number }
    );

    const input: Record<string, unknown> = {
      pullRequestId: prData.repository.pullRequest.id,
      path: options.path,
      line: options.line,
      body: options.body,
    };

    if (options.side) {
      input.side = options.side;
    }

    if (options.startLine && options.startLine !== options.line) {
      input.startLine = options.startLine;
      if (options.side) input.startSide = options.side;
    }

    const data = await gql.query<{
      addPullRequestReviewComment: {
        comment: {
          id: string;
          databaseId: number;
          pullRequestReview: { id: string };
        };
      };
    }>(
      `mutation ($input: AddPullRequestReviewCommentInput!) { addPullRequestReviewComment(input: $input) { comment { id databaseId pullRequestReview { id } } } }`,
      { input }
    );

    return {
      reviewId: data.addPullRequestReviewComment.comment.pullRequestReview.id,
      commentId: data.addPullRequestReviewComment.comment.id,
      commentDatabaseId: data.addPullRequestReviewComment.comment.databaseId,
    };
  }

  async function deletePendingComment(commentId: string): Promise<void> {
    if (!gql) throw new Error("Not initialized");
    await gql.query(
      `mutation ($input: DeletePullRequestReviewCommentInput!) { deletePullRequestReviewComment(input: $input) { pullRequestReview { id } } }`,
      { input: { id: commentId } }
    );
  }

  async function updatePendingComment(
    commentId: string,
    body: string
  ): Promise<void> {
    if (!gql) throw new Error("Not initialized");
    await gql.query(
      `mutation ($input: UpdatePullRequestReviewCommentInput!) { updatePullRequestReviewComment(input: $input) { pullRequestReviewComment { id } } }`,
      { input: { pullRequestReviewCommentId: commentId, body } }
    );
  }

  async function submitPendingReview(
    reviewId: string,
    event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
    body?: string
  ): Promise<number | null> {
    if (!gql) throw new Error("Not initialized");
    const data = await gql.query<{
      submitPullRequestReview: {
        pullRequestReview: { databaseId: number | null } | null;
      };
    }>(
      `mutation ($input: SubmitPullRequestReviewInput!) { submitPullRequestReview(input: $input) { pullRequestReview { id databaseId } } }`,
      { input: { pullRequestReviewId: reviewId, event, body: body ?? "" } }
    );
    return data.submitPullRequestReview.pullRequestReview?.databaseId ?? null;
  }

  async function updateComment(
    owner: string,
    repo: string,
    commentId: number,
    body: string
  ): Promise<ReviewComment> {
    if (!octokit) throw new Error("Not initialized");
    const { data } = await octokit.request(
      "PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}",
      {
        owner,
        repo,
        comment_id: commentId,
        body,
      }
    );
    return data;
  }

  async function deleteComment(
    owner: string,
    repo: string,
    commentId: number
  ): Promise<void> {
    if (!octokit) throw new Error("Not initialized");
    await octokit.request(
      "DELETE /repos/{owner}/{repo}/pulls/comments/{comment_id}",
      {
        owner,
        repo,
        comment_id: commentId,
      }
    );
  }

  async function getUserProfile(login: string): Promise<UserProfile> {
    if (!octokit) throw new Error("Not initialized");

    const cacheKey = `user:${login}`;
    const cached = cache.get<UserProfile>(cacheKey);
    if (cached) return cached;

    const pending = cache.getPending<UserProfile>(cacheKey);
    if (pending) return pending;

    const promise = octokit
      .request("GET /users/{username}", { username: login })
      .then((res) => {
        cache.set(cacheKey, res.data);
        return res.data as UserProfile;
      });

    cache.setPending(cacheKey, promise);
    return promise;
  }

  function invalidateCache(pattern?: string | ((key: string) => boolean)) {
    cache.invalidate(pattern);
  }

  /** Last known value for a key from `cacheKeys`, however old. */
  async function peekCache<T>(key: string): Promise<T | null> {
    return (await cache.peek<T>(key))?.data ?? null;
  }

  /** Live summary of a PR from one small GraphQL query, briefly cached. */
  async function getPRFingerprint(
    owner: string,
    repo: string,
    number: number
  ): Promise<PRFingerprint | null> {
    if (!gql) throw new Error("Not initialized");

    const cacheKey = cacheKeys.prFingerprint(owner, repo, number);

    const cached = cache.get<PRFingerprint>(cacheKey, 5_000);
    if (cached) return cached;

    const pending = cache.getPending<PRFingerprint | null>(cacheKey);
    if (pending) return pending;

    const promise = gql
      .query<PRFingerprintResponse>(PR_FINGERPRINT_QUERY, {
        owner,
        repo,
        number,
      })
      .then((data) => {
        const fingerprint = parsePRFingerprint(data);
        if (fingerprint) cache.set(cacheKey, fingerprint);
        return fingerprint;
      });

    cache.setPending(cacheKey, promise);
    return promise;
  }

  /**
   * Whether the durably cached copy of a PR (and so its file list) still
   * matches GitHub and can be shown before fresh data arrives.
   */
  async function isCachedPRCurrent(
    owner: string,
    repo: string,
    number: number
  ): Promise<boolean> {
    const key = cacheKeys.pr(owner, repo, number);
    // Fetched moments ago (e.g. prefetched on hover)
    if (cache.get<PullRequest>(key)) return true;
    const [cached, live] = await Promise.all([
      cache.peek<PullRequest>(key),
      getPRFingerprint(owner, repo, number).catch(() => null),
    ]);
    return !!cached && !!live && fingerprintMatchesPR(live, cached.data);
  }

  /** Warm the requests a PR page blocks on, e.g. when hovering a list row. */
  function prefetchPR(owner: string, repo: string, number: number) {
    if (!octokit) return;
    const ignore = () => {};
    getPR(owner, repo, number).catch(ignore);
    getPRFiles(owner, repo, number).catch(ignore);
    getPRComments(owner, repo, number).catch(ignore);
  }

  return {
    // State
    getState,
    subscribe,
    initialize,
    reset,
    setOnUnauthorized,
    setOnRateLimited,
    // State actions
    fetchPRList,
    refreshPRList,
    fetchPRChecks,
    refreshAllPRChecks,
    getPRCheckKey,
    // API methods
    searchPRs,
    searchRepos,
    searchUsers,
    getPR,
    getPRFiles,
    recoverPRFilePatches,
    prefetchPR,
    getCompareFiles,
    getPRComments,
    createPRComment,
    getPRReviews,
    createPRReview,
    submitPRReview,
    deletePRReview,
    getPRChecks: getPRChecksForSha,
    getWorkflowRuns: getWorkflowRunsForSha,
    approveWorkflowRun,
    mergePR,
    getAutoMergeState,
    enableAutoMerge,
    disableAutoMerge,
    getPRCommits,
    getPRConversation,
    createPRConversationComment,
    getPRTimeline,
    getFileContent,
    requestReviewers,
    removeReviewers,
    getRepoCollaborators,
    addAssignees,
    removeAssignees,
    getRepoLabels,
    addLabels,
    removeLabel,
    convertToDraft,
    markReadyForReview,
    updateBranch,
    closePR,
    reopenPR,
    deleteBranch,
    restoreBranch,
    // Reactions
    getIssueReactions,
    addIssueReaction,
    deleteIssueReaction,
    getCommentReactions,
    addCommentReaction,
    deleteCommentReaction,
    // Review comment reactions
    getReviewCommentReactions,
    addReviewCommentReaction,
    deleteReviewCommentReaction,
    // GraphQL
    graphql,
    getPREnrichment,
    getReviewThreads,
    resolveThread,
    unresolveThread,
    getPendingReview,
    addPendingComment,
    deletePendingComment,
    updatePendingComment,
    submitPendingReview,
    updateComment,
    deleteComment,
    getUserProfile,
    invalidateCache,
    peekCache,
    getPRFingerprint,
    isCachedPRCurrent,
  };
}

// ============================================================================
// Context
// ============================================================================

export type GitHubStore = ReturnType<typeof createGitHubStore>;

const GitHubContext = createContext<GitHubStore | null>(null);

// ============================================================================
// Provider
// ============================================================================

export function GitHubProvider({ children }: { children: ReactNode }) {
  const { token, isAuthenticated, logout, setRateLimited } = useAuth();
  const storeRef = useRef<GitHubStore | null>(null);

  if (!storeRef.current) {
    storeRef.current = createGitHubStore();
  }

  const store = storeRef.current;

  // Set up unauthorized handler to logout when token is revoked
  useEffect(() => {
    store.setOnUnauthorized(logout);
  }, [store, logout]);

  // Set up rate limit handler
  useEffect(() => {
    store.setOnRateLimited(() => setRateLimited(true));
  }, [store, setRateLimited]);

  // Initialize/reset when token changes
  useEffect(() => {
    if (isAuthenticated && token) {
      store.initialize(token);
    } else {
      store.reset();
    }
  }, [store, token, isAuthenticated]);

  // Auto-refresh PR list every 60 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      if (store.getState().ready) {
        store.refreshPRList();
      }
    }, 60_000);
    return () => clearInterval(interval);
  }, [store]);

  // Auto-refresh PR checks every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      if (store.getState().ready) {
        store.refreshAllPRChecks();
      }
    }, 30_000);
    return () => clearInterval(interval);
  }, [store]);

  return (
    <GitHubContext.Provider value={store}>{children}</GitHubContext.Provider>
  );
}

// ============================================================================
// Hooks
// ============================================================================

export function useGitHubStore() {
  const store = useContext(GitHubContext);
  if (!store) {
    throw new Error("useGitHubStore must be used within GitHubProvider");
  }
  return store;
}

export function useGitHubSelector<T>(selector: (state: GitHubState) => T): T {
  const store = useGitHubStore();
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState())
  );
}

// Convenience hooks
export function useGitHubReady() {
  const ready = useGitHubSelector((s) => s.ready);
  const error = useGitHubSelector((s) => s.error);
  return { ready, error };
}

export function useCurrentUser(): CurrentUserData | null {
  return useGitHubSelector((s) => s.currentUser);
}

export function usePRList() {
  return useGitHubSelector((s) => s.prList);
}

export function usePRListActions() {
  const store = useGitHubStore();
  return {
    fetchPRList: store.fetchPRList,
    refreshPRList: store.refreshPRList,
  };
}

export function usePRChecks(owner: string, repo: string, number: number) {
  const store = useGitHubStore();
  const ready = useGitHubSelector((s) => s.ready);
  const key = store.getPRCheckKey(owner, repo, number);
  const checkState = useGitHubSelector((s) => s.prChecks.get(key));

  useEffect(() => {
    if (ready && !checkState?.lastFetchedAt) {
      store.fetchPRChecks(owner, repo, number);
    }
  }, [ready, store, owner, repo, number, checkState?.lastFetchedAt]);

  return {
    status: checkState?.status || null,
    loading: checkState?.loading || false,
    refresh: () => store.fetchPRChecks(owner, repo, number),
  };
}

export function useRefreshAll() {
  const store = useGitHubStore();
  return useCallback(() => {
    store.refreshPRList();
    store.refreshAllPRChecks();
  }, [store]);
}

/**
 * Hook that throws if GitHub is not ready.
 * Use in components that require GitHub to be available.
 */
export function useGitHub(): GitHubStore {
  const store = useGitHubStore();
  const { ready, error } = useGitHubReady();

  if (error) {
    throw new Error(error);
  }

  if (!ready) {
    throw new Error("GitHub client not ready");
  }

  return store;
}

// Legacy compatibility - type alias
export type GitHubClient = GitHubStore;
