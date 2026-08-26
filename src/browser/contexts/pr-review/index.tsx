import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type {
  PullRequest,
  PullRequestFile,
  ReviewComment,
  PendingReviewComment,
} from "@/api/types";
import {
  MentionSuggestionsProvider,
  type MentionUser,
} from "@/browser/ui/markdown";
import { isTestFile } from "@/browser/lib/test-file";
import {
  cancelSemanticJob,
  fetchCachedSemanticReview,
  fetchSemanticProviders,
  startSemanticAnalysis as apiStartSemanticAnalysis,
  streamSemanticJob,
  type ProviderInfo,
} from "@/browser/lib/semantic-client";
import type {
  SemanticCohort,
  SemanticLayer,
  SemanticRange,
  SemanticReview,
} from "@/semantic/schema";
import {
  type GitHubStore,
  type Review,
  type IssueComment,
  type CheckRun,
  type CombinedStatus,
  type PRCommit,
  type TimelineEvent,
  type ReviewThread,
} from "@/browser/contexts/github";

// ============================================================================
// File Sorting (match file tree order)
// ============================================================================

/**
 * Sort files to match the file tree display order:
 * - Files are grouped by directory
 * - At each level, folders come before files
 * - Items are sorted alphabetically within each group
 */
export function sortFilesLikeTree<T extends { filename: string }>(
  files: T[]
): T[] {
  return [...files].sort((a, b) => {
    const aParts = a.filename.split("/");
    const bParts = b.filename.split("/");

    // Compare path segments
    const minLen = Math.min(aParts.length, bParts.length);

    for (let i = 0; i < minLen; i++) {
      const aIsLast = i === aParts.length - 1;
      const bIsLast = i === bParts.length - 1;

      // If one is a file and other is folder at this level, folder comes first
      if (aIsLast !== bIsLast) {
        return aIsLast ? 1 : -1; // folder (not last) before file (last)
      }

      // Both are same type at this level, compare names
      const cmp = aParts[i].localeCompare(bParts[i]);
      if (cmp !== 0) return cmp;
    }

    // Paths are equal up to minLen, shorter path (folder) comes first
    return aParts.length - bParts.length;
  });
}

// ============================================================================
// Types
// ============================================================================

export interface LocalPendingComment extends PendingReviewComment {
  id: string;
  // GraphQL node ID for the comment (for deletion)
  nodeId?: string;
  // Database ID (for REST API compatibility)
  databaseId?: number;
}

interface LineSegment {
  value: string;
  html: string;
  type: "insert" | "delete" | "normal";
}

export interface DiffLine {
  type: "insert" | "delete" | "normal";
  oldLineNumber?: number;
  newLineNumber?: number;
  content: LineSegment[];
}

export interface DiffHunk {
  type: "hunk";
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface DiffSkipBlock {
  type: "skip";
  count: number;
  content: string;
}

export interface ParsedDiff {
  hunks: (DiffHunk | DiffSkipBlock)[];
  /** Default context around each gap, keyed by skip index (the index one
   * past the last skip block is the end-of-file gap). */
  gapContext?: Record<number, ExpandedSkipBlock>;
  /** Total line count of the new file, when known. */
  totalNewLines?: number;
}

export interface CommentingOnLine {
  line: number;
  startLine?: number;
}

// ============================================================================
// Store State
// ============================================================================

// Pre-computed navigable item for O(1) navigation lookup
export interface NavigableItem {
  type: "line" | "skip";
  lineNum?: number;
  side?: "old" | "new";
  skipIndex?: number;
  rowIndex: number;
}

export type DiffViewMode = "unified" | "split";

// Checks data structure
export interface ChecksData {
  checkRuns: CheckRun[];
  status: CombinedStatus;
}

// Workflow run awaiting approval
export interface WorkflowRunAwaitingApproval {
  id: number;
  name: string;
  html_url: string;
}

// Merge method type
export type MergeMethod = "merge" | "squash" | "rebase";

export interface ExpandedSkipBlock {
  top: DiffLine[];
  bottom: DiffLine[];
}

interface PRReviewState {
  // Core data
  pr: PullRequest;
  files: PullRequestFile[];
  owner: string;
  repo: string;
  currentUser: string | null;
  // Viewer permissions (from GraphQL) - affects what actions are available
  // ADMIN, MAINTAIN, WRITE can approve/request_changes
  // TRIAGE, READ can only comment
  viewerPermission: string | null;
  viewerCanMergeAsAdmin: boolean;

  // PR data (fetched after initial load)
  reviews: Review[];
  reviewThreads: ReviewThread[];
  timeline: TimelineEvent[];
  conversation: IssueComment[];
  commits: PRCommit[];
  checks: ChecksData | null;
  checksLastUpdated: Date | null;
  workflowRunsAwaitingApproval: WorkflowRunAwaitingApproval[];
  branchDeleted: boolean;

  // Loading states
  loading: boolean;
  loadingChecks: boolean;

  // Merge state
  merging: boolean;
  mergeMethod: MergeMethod;
  mergeError: string | null;

  // PR action states
  closingPR: boolean;
  reopeningPR: boolean;
  deletingBranch: boolean;
  restoringBranch: boolean;
  convertingToDraft: boolean;
  markingReady: boolean;
  approvingWorkflows: boolean;

  // Diff view mode (unified or split) - global user preference
  diffViewMode: DiffViewMode;

  // File navigation
  selectedFile: string | null;
  selectedFiles: Set<string>;
  showOverview: boolean;
  // Overview scroll target (GitHub-style hash: pullrequestreview-{id}, issuecomment-{id}, etc.)
  overviewScrollTarget: string | null;

  // Viewed files
  viewedFiles: Set<string>;
  hideViewed: boolean;
  hideTestFiles: boolean;

  // Diffs
  loadedDiffs: Record<string, ParsedDiff>;
  loadingFiles: Set<string>;
  // Map of "filename:skipIndex" -> lines revealed so far from each edge of
  // the gap (GitHub-style incremental expansion). `top` grows downward from
  // the hunk above; `bottom` grows upward from the hunk below.
  expandedSkipBlocks: Record<string, ExpandedSkipBlock>;
  expandingSkipBlocks: Set<string>;
  // Total line count of each file at the head commit, learned when file
  // content is fetched for gap expansion. Sizes the end-of-file gap.
  fileLineCounts: Record<string, number>;
  /** Files whose entire diff was expanded via the header button. */
  fullyExpandedFiles: Set<string>;
  // Pre-computed navigation arrays per file (Fix 2)
  navigableItems: Record<string, NavigableItem[]>;
  // Pre-computed comment range lookup per file (Fix 3)
  commentRangeLookup: Record<string, Set<number>>;

  // Line selection
  focusedLine: number | null;
  /**
   * When true, the focused line is scrolled to but not visually
   * highlighted (used by change-jump navigation). Any other focus
   * change resets it - see set().
   */
  suppressFocusHighlight: boolean;
  focusedLineSide: "old" | "new" | null; // 'old' for delete lines, 'new' for insert/context
  selectionAnchor: number | null;
  selectionAnchorSide: "old" | "new" | null;
  focusedSkipBlockIndex: number | null; // Index of focused skip block for keyboard navigation
  commentingOnLine: CommentingOnLine | null;
  gotoLineMode: boolean;
  gotoLineInput: string;
  gotoLineSide: "old" | "new"; // Which side to target in goto mode

  // Comments
  comments: ReviewComment[];
  pendingComments: LocalPendingComment[];
  focusedCommentId: number | null;
  editingCommentId: number | null;
  replyingToCommentId: number | null;

  // Pending comment focus/edit (separate from regular comments since IDs are strings)
  focusedPendingCommentId: string | null;
  editingPendingCommentId: string | null;

  // Comment collapse: global default (persisted) + per-thread in-memory overrides.
  // Effective collapsed = override ?? (allCommentsCollapsed || threadIsResolved)
  allCommentsCollapsed: boolean;
  collapsedThreadOverrides: Map<string, boolean>;

  // Semantic review (local-agent-powered; hidden when no providers)
  semanticProviders: ProviderInfo[] | null; // null = not yet loaded
  semanticStatus: "idle" | "running" | "done" | "error";
  semanticReview: SemanticReview | null;
  semanticWarnings: string[];
  semanticProgress: string[];
  semanticError: string | null;
  viewMode: "files" | "semantic";
  reviewedLayers: Set<string>; // "cohortId/layerId", persisted per PR
  selectedLayerId: string | null; // "cohortId/layerId"

  // Review
  pendingReviewId: number | null;
  reviewBody: string;
  showReviewPanel: boolean;
  submittingReview: boolean;
}

// ============================================================================
// External Store
// ============================================================================

type Listener = () => void;
type Selector<T> = (state: PRReviewState) => T;

// Global storage key for diff view mode (user preference, not per-PR)
const DIFF_VIEW_MODE_KEY = "pulldash_diff_view_mode";

function getStoredDiffViewMode(): DiffViewMode {
  try {
    const stored = localStorage.getItem(DIFF_VIEW_MODE_KEY);
    if (stored === "split" || stored === "unified") {
      return stored;
    }
  } catch {}
  return "unified"; // Default to unified view
}

function setStoredDiffViewMode(mode: DiffViewMode): void {
  try {
    localStorage.setItem(DIFF_VIEW_MODE_KEY, mode);
  } catch {}
}

// Global storage key for hiding test files (user preference, not per-PR)
const HIDE_TEST_FILES_KEY = "pulldash_hide_test_files";

function getStoredHideTestFiles(): boolean {
  try {
    return localStorage.getItem(HIDE_TEST_FILES_KEY) === "true";
  } catch {}
  return false;
}

function setStoredHideTestFiles(hide: boolean): void {
  try {
    localStorage.setItem(HIDE_TEST_FILES_KEY, String(hide));
  } catch {}
}

// Global storage key for collapsing all inline comments (user preference)
const COLLAPSE_ALL_COMMENTS_KEY = "pulldash_collapse_all_comments";

function getStoredCollapseAllComments(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_ALL_COMMENTS_KEY) === "true";
  } catch {}
  return false;
}

function setStoredCollapseAllComments(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSE_ALL_COMMENTS_KEY, String(collapsed));
  } catch {}
}

/**
 * Stable key for a comment thread: the review thread id when available,
 * otherwise the id of the first (root) comment in the thread.
 */
export function commentThreadKey(
  comments: { id: number; pull_request_review_thread_id?: string | null }[]
): string {
  const first = comments[0];
  if (!first) return "";
  return first.pull_request_review_thread_id ?? `c${first.id}`;
}

/** Effective collapsed state for a thread given store state. */
export function isThreadCollapsed(
  state: Pick<
    PRReviewState,
    "allCommentsCollapsed" | "collapsedThreadOverrides"
  >,
  key: string,
  isResolved: boolean
): boolean {
  const override = state.collapsedThreadOverrides.get(key);
  if (override !== undefined) return override;
  return state.allCommentsCollapsed || isResolved;
}

export class PRReviewStore {
  private state: PRReviewState;
  private listeners = new Set<Listener>();
  private storageKey: string;
  private github: GitHubStore;
  // Track recently approved workflow IDs to filter out stale API responses
  private recentlyApprovedWorkflowIds = new Set<number>();
  // Semantic analysis job tracking (SSE subscription lifecycle)
  private semanticJobId: string | null = null;
  private semanticUnsubscribe: (() => void) | null = null;

  constructor(
    github: GitHubStore,
    initialState: {
      pr: PullRequest;
      files: PullRequestFile[];
      comments: ReviewComment[];
      owner: string;
      repo: string;
      viewerPermission: string | null;
    }
  ) {
    this.github = github;
    this.storageKey = `pr-${initialState.owner}-${initialState.repo}-${initialState.pr.number}`;

    // Load viewed files from localStorage
    let viewedFiles = new Set<string>();
    let pendingComments: LocalPendingComment[] = [];
    let reviewBody = "";
    const diffViewMode = getStoredDiffViewMode();

    try {
      const stored = localStorage.getItem(`${this.storageKey}-viewed`);
      if (stored) {
        viewedFiles = new Set(JSON.parse(stored));
      }
    } catch {}

    // Load pending comments from localStorage
    try {
      const stored = localStorage.getItem(`${this.storageKey}-pending`);
      if (stored) {
        pendingComments = JSON.parse(stored);
      }
    } catch {}

    // Load review body from localStorage
    try {
      const stored = localStorage.getItem(`${this.storageKey}-body`);
      if (stored) {
        reviewBody = stored;
      }
    } catch {}

    // Load reviewed semantic layers from localStorage
    let reviewedLayers = new Set<string>();
    try {
      const stored = localStorage.getItem(`${this.storageKey}-semantic-layers`);
      if (stored) {
        reviewedLayers = new Set(JSON.parse(stored));
      }
    } catch {}

    // Sort files to match file tree order (folders first, then alphabetically)
    const sortedFiles = sortFilesLikeTree(initialState.files);

    this.state = {
      ...initialState,
      files: sortedFiles,
      viewerCanMergeAsAdmin: false,

      // PR data (loaded separately)
      reviews: [],
      reviewThreads: [],
      timeline: [],
      conversation: [],
      commits: [],
      checks: null,
      checksLastUpdated: null,
      workflowRunsAwaitingApproval: [],
      branchDeleted: false,

      // Loading states
      loading: true,
      loadingChecks: false,

      // Merge state
      merging: false,
      mergeMethod: "squash",
      mergeError: null,

      // PR action states
      closingPR: false,
      reopeningPR: false,
      deletingBranch: false,
      restoringBranch: false,
      convertingToDraft: false,
      markingReady: false,
      approvingWorkflows: false,

      // UI state
      selectedFile: null,
      selectedFiles: new Set(),
      showOverview: true,
      overviewScrollTarget: null,
      viewedFiles,
      hideViewed: true,
      hideTestFiles: getStoredHideTestFiles(),
      diffViewMode,
      loadedDiffs: {},
      loadingFiles: new Set(),
      expandedSkipBlocks: {},
      expandingSkipBlocks: new Set(),
      fileLineCounts: {},
      fullyExpandedFiles: new Set(),
      navigableItems: {},
      commentRangeLookup: {},
      focusedLine: null,
      suppressFocusHighlight: false,
      focusedLineSide: null,
      selectionAnchor: null,
      selectionAnchorSide: null,
      focusedSkipBlockIndex: null,
      commentingOnLine: null,
      gotoLineMode: false,
      gotoLineInput: "",
      gotoLineSide: "new",
      focusedCommentId: null,
      editingCommentId: null,
      replyingToCommentId: null,
      focusedPendingCommentId: null,
      editingPendingCommentId: null,
      allCommentsCollapsed: getStoredCollapseAllComments(),
      collapsedThreadOverrides: new Map(),
      semanticProviders: null,
      semanticStatus: "idle",
      semanticReview: null,
      semanticWarnings: [],
      semanticProgress: [],
      semanticError: null,
      viewMode: "files",
      reviewedLayers,
      selectedLayerId: null,
      pendingReviewId: null,
      pendingComments,
      reviewBody,
      showReviewPanel: false,
      submittingReview: false,
      currentUser: null,
    };
  }

  setCurrentUser = (username: string) => {
    this.set({ currentUser: username });
  };

  setViewerPermission = (permission: string | null) => {
    this.set({ viewerPermission: permission });
  };

  // ---------------------------------------------------------------------------
  // Subscription
  // ---------------------------------------------------------------------------

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): PRReviewState => this.state;

  private emit() {
    this.listeners.forEach((l) => l());
  }

  private set(partial: Partial<PRReviewState>) {
    // Any focus movement re-enables the focus highlight unless the
    // caller (change-jump navigation) explicitly suppresses it.
    if ("focusedLine" in partial && !("suppressFocusHighlight" in partial)) {
      partial = { ...partial, suppressFocusHighlight: false };
    }
    this.state = { ...this.state, ...partial };
    this.emit();
  }

  // ---------------------------------------------------------------------------
  // File Navigation Actions
  // ---------------------------------------------------------------------------

  selectOverview = (scrollTarget?: string) => {
    // If already on overview and just updating scroll target
    if (this.state.showOverview && scrollTarget) {
      this.set({ overviewScrollTarget: scrollTarget });
      return;
    }
    if (this.state.showOverview && !scrollTarget) return;
    this.set({
      showOverview: true,
      overviewScrollTarget: scrollTarget ?? null,
      selectedFile: null,
      selectedFiles: new Set(),
      focusedLine: null,
      focusedLineSide: null,
      selectionAnchor: null,
      selectionAnchorSide: null,
      commentingOnLine: null,
      gotoLineMode: false,
      gotoLineInput: "",
      focusedCommentId: null,
      editingCommentId: null,
      replyingToCommentId: null,
      focusedPendingCommentId: null,
      editingPendingCommentId: null,
    });
  };

  clearOverviewScrollTarget = () => {
    if (this.state.overviewScrollTarget) {
      this.set({ overviewScrollTarget: null });
    }
  };

  selectFile = (filename: string) => {
    // In semantic mode any path that lands on a file (tree click, file-header
    // arrows, j/k, hash navigation) must keep the semantic UI pointed at a
    // layer that actually covers the file. When the current layer already
    // covers it - notably the layer -> file jump in selectSemanticLayer -
    // this resolves to the existing selection, so no loop or clobbering.
    const layerKey = this.semanticLayerKeyForFile(filename);
    if (this.state.selectedFile === filename && !this.state.showOverview) {
      if (layerKey && layerKey !== this.state.selectedLayerId) {
        this.set({ selectedLayerId: layerKey });
      }
      return;
    }
    // Track for shift+click range selection
    this.lastSelectedFile = filename;
    this.set({
      selectedFile: filename,
      ...(layerKey ? { selectedLayerId: layerKey } : {}),
      selectedFiles: new Set(),
      showOverview: false,
      // Reset line selection when changing files
      focusedLine: null,
      focusedLineSide: null,
      selectionAnchor: null,
      selectionAnchorSide: null,
      commentingOnLine: null,
      gotoLineMode: false,
      gotoLineInput: "",
      focusedCommentId: null,
      editingCommentId: null,
      replyingToCommentId: null,
      focusedPendingCommentId: null,
      editingPendingCommentId: null,
    });
  };

  toggleFileSelection = (filename: string, isShiftClick: boolean) => {
    const { files, selectedFiles } = this.state;

    if (isShiftClick && this.lastSelectedFile) {
      const allFilenames = files.map((f) => f.filename);
      const lastIdx = allFilenames.indexOf(this.lastSelectedFile);
      const currentIdx = allFilenames.indexOf(filename);

      if (lastIdx !== -1 && currentIdx !== -1) {
        const start = Math.min(lastIdx, currentIdx);
        const end = Math.max(lastIdx, currentIdx);
        const rangeFiles = allFilenames.slice(start, end + 1);
        const next = new Set(selectedFiles);
        for (const f of rangeFiles) next.add(f);
        this.set({ selectedFiles: next });
      }
    } else {
      const next = new Set(selectedFiles);
      if (next.has(filename)) {
        next.delete(filename);
      } else {
        next.add(filename);
      }
      this.lastSelectedFile = filename;
      this.set({ selectedFiles: next });
    }
  };

  private lastSelectedFile: string | null = null;

  navigateToFile = (direction: "next" | "prev") => {
    const { files, selectedFile } = this.state;
    const currentIdx = selectedFile
      ? files.findIndex((f) => f.filename === selectedFile)
      : -1;

    const newIdx =
      direction === "next"
        ? Math.min(currentIdx + 1, files.length - 1)
        : Math.max(currentIdx - 1, 0);

    if (newIdx !== currentIdx && files[newIdx]) {
      this.selectFile(files[newIdx].filename);
    }
  };

  // Whether a file is hidden from the tree and skipped during navigation.
  private isFileHidden = (filename: string): boolean =>
    this.state.hideTestFiles && isTestFile(filename);

  navigateToNextUnviewedFile = () => {
    const { files, selectedFile, viewedFiles } = this.state;
    const currentIdx = selectedFile
      ? files.findIndex((f) => f.filename === selectedFile)
      : -1;

    // Search forward then wrap
    for (let i = 0; i < files.length; i++) {
      const idx = (currentIdx + 1 + i) % files.length;
      if (this.isFileHidden(files[idx].filename)) continue;
      if (!viewedFiles.has(files[idx].filename)) {
        this.selectFile(files[idx].filename);
        return;
      }
    }
  };

  navigateToPrevUnviewedFile = () => {
    const { files, selectedFile, viewedFiles } = this.state;
    const currentIdx = selectedFile
      ? files.findIndex((f) => f.filename === selectedFile)
      : files.length;

    // Search backward then wrap
    for (let i = 0; i < files.length; i++) {
      const idx = (currentIdx - 1 - i + files.length) % files.length;
      if (this.isFileHidden(files[idx].filename)) continue;
      if (!viewedFiles.has(files[idx].filename)) {
        this.selectFile(files[idx].filename);
        return;
      }
    }
  };

  clearFileSelection = () => {
    this.set({ selectedFiles: new Set() });
  };

  // ---------------------------------------------------------------------------
  // Viewed Files Actions
  // ---------------------------------------------------------------------------

  private persistViewedFiles(viewedFiles: Set<string>) {
    try {
      localStorage.setItem(
        `${this.storageKey}-viewed`,
        JSON.stringify([...viewedFiles])
      );
    } catch {}
  }

  private persistPendingComments(pendingComments: LocalPendingComment[]) {
    try {
      localStorage.setItem(
        `${this.storageKey}-pending`,
        JSON.stringify(pendingComments)
      );
    } catch {}
  }

  private persistReviewBody(body: string) {
    try {
      if (body) {
        localStorage.setItem(`${this.storageKey}-body`, body);
      } else {
        localStorage.removeItem(`${this.storageKey}-body`);
      }
    } catch {}
  }

  private clearPendingState() {
    try {
      localStorage.removeItem(`${this.storageKey}-pending`);
      localStorage.removeItem(`${this.storageKey}-body`);
    } catch {}
  }

  toggleViewed = (filename: string) => {
    const next = new Set(this.state.viewedFiles);
    const wasViewed = next.has(filename);
    if (wasViewed) {
      next.delete(filename);
    } else {
      next.add(filename);
    }
    this.persistViewedFiles(next);
    this.set({ viewedFiles: next });

    // When marking a file as viewed, navigate to the next file
    if (!wasViewed && filename === this.state.selectedFile) {
      this.navigateToFile("next");
    }
  };

  toggleViewedMultiple = (filenames: string[]) => {
    const next = new Set(this.state.viewedFiles);
    const allViewed = filenames.every((f) => next.has(f));

    for (const filename of filenames) {
      if (allViewed) {
        next.delete(filename);
      } else {
        next.add(filename);
      }
    }
    this.persistViewedFiles(next);
    this.set({ viewedFiles: next, selectedFiles: new Set() });
  };

  markFolderViewed = (
    _folderPath: string,
    filenames: string[],
    markAsViewed: boolean
  ) => {
    const next = new Set(this.state.viewedFiles);
    for (const filename of filenames) {
      if (markAsViewed) {
        next.add(filename);
      } else {
        next.delete(filename);
      }
    }
    this.persistViewedFiles(next);
    this.set({ viewedFiles: next });
  };

  toggleHideViewed = () => {
    this.set({ hideViewed: !this.state.hideViewed });
  };

  toggleHideTestFiles = () => {
    const hideTestFiles = !this.state.hideTestFiles;
    setStoredHideTestFiles(hideTestFiles);
    // If the currently selected file just became hidden, deselect it so the
    // reviewer isn't left on a file that no longer exists in the tree.
    const { selectedFile } = this.state;
    this.set({ hideTestFiles });
    if (hideTestFiles && selectedFile && isTestFile(selectedFile)) {
      this.selectOverview();
    }
  };

  // ---------------------------------------------------------------------------
  // Comment Collapse Actions
  // ---------------------------------------------------------------------------

  /** Collapse or expand every comment thread at once, dropping per-thread overrides. */
  setAllCommentsCollapsed = (collapsed: boolean) => {
    setStoredCollapseAllComments(collapsed);
    this.set({
      allCommentsCollapsed: collapsed,
      collapsedThreadOverrides: new Map(),
    });
  };

  toggleAllCommentsCollapsed = () => {
    this.setAllCommentsCollapsed(!this.state.allCommentsCollapsed);
  };

  /** Toggle a single thread, recording an override when it differs from the default. */
  setThreadCollapsed = (
    key: string,
    collapsed: boolean,
    isResolved = false
  ) => {
    const next = new Map(this.state.collapsedThreadOverrides);
    const defaultCollapsed = this.state.allCommentsCollapsed || isResolved;
    if (collapsed === defaultCollapsed) {
      if (!next.has(key)) return;
      next.delete(key);
    } else {
      if (next.get(key) === collapsed) return;
      next.set(key, collapsed);
    }
    this.set({ collapsedThreadOverrides: next });
  };

  toggleThreadCollapsed = (key: string, isResolved = false) => {
    this.setThreadCollapsed(
      key,
      !isThreadCollapsed(this.state, key, isResolved),
      isResolved
    );
  };

  isThreadCollapsed = (key: string, isResolved = false) =>
    isThreadCollapsed(this.state, key, isResolved);

  // ---------------------------------------------------------------------------
  // Diff View Mode Actions
  // ---------------------------------------------------------------------------

  setDiffViewMode = (mode: DiffViewMode) => {
    if (this.state.diffViewMode === mode) return;
    setStoredDiffViewMode(mode);
    this.set({ diffViewMode: mode });
  };

  toggleDiffViewMode = () => {
    const newMode = this.state.diffViewMode === "unified" ? "split" : "unified";
    this.setDiffViewMode(newMode);
  };

  // ---------------------------------------------------------------------------
  // Semantic Review Actions
  // ---------------------------------------------------------------------------

  /**
   * Load available providers and any cached review for this PR's head SHA.
   * Called once on mount; no-op on repeat calls. When no providers exist
   * (hosted deployment, no local agents) the UI hides the feature.
   */
  initSemanticReview = async () => {
    if (this.state.semanticProviders !== null) return;
    const { owner, repo, pr } = this.state;
    const [providers, cached] = await Promise.all([
      fetchSemanticProviders(),
      fetchCachedSemanticReview(owner, repo, pr.number, pr.head.sha),
    ]);
    this.set({
      semanticProviders: providers,
      ...(cached
        ? { semanticReview: cached, semanticStatus: "done" as const }
        : {}),
    });
  };

  startSemanticAnalysis = async (providerId: string) => {
    if (this.state.semanticStatus === "running") return;
    const { owner, repo, pr, files } = this.state;
    this.set({
      semanticStatus: "running",
      semanticProgress: [],
      semanticError: null,
    });

    try {
      const jobId = await apiStartSemanticAnalysis(providerId, {
        owner,
        repo,
        number: pr.number,
        headSha: pr.head.sha,
        title: pr.title,
        body: pr.body ?? "",
        files: files.map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          patch: f.patch,
        })),
      });
      this.semanticJobId = jobId;
      this.semanticUnsubscribe = streamSemanticJob(jobId, {
        onProgress: (message) => {
          this.set({
            semanticProgress: [...this.state.semanticProgress, message],
          });
        },
        onDone: ({ review, warnings }) => {
          this.semanticJobId = null;
          this.semanticUnsubscribe = null;
          this.set({
            semanticStatus: "done",
            semanticReview: review,
            semanticWarnings: warnings ?? [],
          });
        },
        onError: (error) => {
          this.semanticJobId = null;
          this.semanticUnsubscribe = null;
          this.set({ semanticStatus: "error", semanticError: error });
        },
      });
    } catch (err) {
      this.set({
        semanticStatus: "error",
        semanticError: (err as Error).message,
      });
    }
  };

  cancelSemanticAnalysis = () => {
    const jobId = this.semanticJobId;
    this.semanticUnsubscribe?.();
    this.semanticUnsubscribe = null;
    this.semanticJobId = null;
    if (jobId) void cancelSemanticJob(jobId);
    // Keep any previous review; just stop the in-flight run.
    this.set({
      semanticStatus: this.state.semanticReview ? "done" : "idle",
      semanticProgress: [],
    });
  };

  /** Tear down any live SSE subscription (called when the PR page unmounts). */
  disposeSemantic = () => {
    this.semanticUnsubscribe?.();
    this.semanticUnsubscribe = null;
    this.semanticJobId = null;
  };

  setViewMode = (mode: "files" | "semantic") => {
    if (this.state.viewMode === mode) return;
    if (mode === "semantic" && !this.state.semanticReview) return;
    this.set({ viewMode: mode });
    // Entering semantic mode with no selection: open the first layer.
    if (mode === "semantic" && !this.state.selectedLayerId) {
      const keys = this.semanticLayerKeys();
      if (keys.length > 0) this.selectSemanticLayer(keys[0]);
    }
  };

  /** Ordered "cohortId/layerId" keys across the whole review. */
  private semanticLayerKeys(): string[] {
    const review = this.state.semanticReview;
    if (!review) return [];
    return review.cohorts.flatMap((c) =>
      c.layers.map((l) => `${c.id}/${l.id}`)
    );
  }

  getSemanticLayer = (
    layerKey: string
  ): { cohort: SemanticCohort; layer: SemanticLayer } | null => {
    const review = this.state.semanticReview;
    if (!review) return null;
    const slash = layerKey.indexOf("/");
    const cohort = review.cohorts.find(
      (c) => c.id === layerKey.slice(0, slash)
    );
    const layer = cohort?.layers.find(
      (l) => l.id === layerKey.slice(slash + 1)
    );
    return cohort && layer ? { cohort, layer } : null;
  };

  /**
   * First layer (in cohort/layer order) whose ranges touch `filename`, or the
   * currently selected layer when it already covers the file. Returns null
   * outside semantic mode or when no layer covers the file, meaning "leave the
   * current layer selection alone".
   */
  private semanticLayerKeyForFile = (filename: string): string | null => {
    if (this.state.viewMode !== "semantic") return null;
    const review = this.state.semanticReview;
    if (!review) return null;
    let first: string | null = null;
    for (const cohort of review.cohorts) {
      for (const layer of cohort.layers) {
        if (!layer.ranges.some((r) => r.file === filename)) continue;
        const key = `${cohort.id}/${layer.id}`;
        if (key === this.state.selectedLayerId) return key;
        first ??= key;
      }
    }
    return first;
  };

  selectSemanticLayer = (layerKey: string) => {
    const found = this.getSemanticLayer(layerKey);
    if (!found) return;
    this.set({ selectedLayerId: layerKey });
    const range = found.layer.ranges[0];
    if (range) this.jumpToSemanticRange(range);
  };

  /** Open the range's file and focus its first line (diff auto-scrolls). */
  jumpToSemanticRange = (range: SemanticRange) => {
    if (!this.state.files.some((f) => f.filename === range.file)) return;
    this.selectFile(range.file);
    this.set({
      focusedLine: range.startLine,
      focusedLineSide: range.side === "old" ? "old" : "new",
    });
  };

  /**
   * Prev/next file in semantic mode: step through the current layer's
   * files in range order, then overflow into the adjacent layer.
   */
  navigateSemanticFile = (direction: "next" | "prev") => {
    const { selectedLayerId, selectedFile, files } = this.state;
    const found = selectedLayerId
      ? this.getSemanticLayer(selectedLayerId)
      : null;
    if (!found) {
      this.navigateSemanticLayer(direction);
      return;
    }

    // Unique files of this layer, in the order its ranges visit them
    const layerFiles: string[] = [];
    for (const range of found.layer.ranges) {
      if (
        !layerFiles.includes(range.file) &&
        files.some((f) => f.filename === range.file)
      ) {
        layerFiles.push(range.file);
      }
    }

    const idx = selectedFile ? layerFiles.indexOf(selectedFile) : -1;
    const targetIdx =
      direction === "next" ? (idx === -1 ? 0 : idx + 1) : idx - 1;

    if (idx !== -1 || direction === "next") {
      const targetFile = layerFiles[targetIdx];
      if (targetFile) {
        const range = found.layer.ranges.find((r) => r.file === targetFile);
        if (range) {
          this.jumpToSemanticRange(range);
          return;
        }
      }
    }
    // Past either end of the layer's files - move to the adjacent layer
    this.navigateSemanticLayer(direction);
  };

  /** j/k in semantic mode: move between layers (wraps around). */
  navigateSemanticLayer = (direction: "next" | "prev") => {
    const keys = this.semanticLayerKeys();
    if (keys.length === 0) return;
    const idx = this.state.selectedLayerId
      ? keys.indexOf(this.state.selectedLayerId)
      : -1;
    const next =
      idx === -1
        ? direction === "next"
          ? 0
          : keys.length - 1
        : (idx + (direction === "next" ? 1 : -1) + keys.length) % keys.length;
    this.selectSemanticLayer(keys[next]);
  };

  toggleLayerReviewed = (layerKey: string) => {
    const next = new Set(this.state.reviewedLayers);
    if (next.has(layerKey)) {
      next.delete(layerKey);
    } else {
      next.add(layerKey);
    }
    try {
      localStorage.setItem(
        `${this.storageKey}-semantic-layers`,
        JSON.stringify([...next])
      );
    } catch {}
    this.set({ reviewedLayers: next });
    this.syncViewedFromLayers(next);
  };

  /**
   * A file whose every range sits inside reviewed layers is marked viewed in
   * the normal file view. One-way: un-reviewing a layer never un-views a file.
   */
  private syncViewedFromLayers(reviewedLayers: Set<string>) {
    const review = this.state.semanticReview;
    if (!review) return;
    const layersByFile = new Map<string, Set<string>>();
    for (const cohort of review.cohorts) {
      for (const layer of cohort.layers) {
        const key = `${cohort.id}/${layer.id}`;
        for (const range of layer.ranges) {
          let set = layersByFile.get(range.file);
          if (!set) {
            set = new Set();
            layersByFile.set(range.file, set);
          }
          set.add(key);
        }
      }
    }
    const viewed = new Set(this.state.viewedFiles);
    let changed = false;
    for (const [file, keys] of layersByFile) {
      if (viewed.has(file)) continue;
      let all = true;
      for (const key of keys) {
        if (!reviewedLayers.has(key)) {
          all = false;
          break;
        }
      }
      if (all) {
        viewed.add(file);
        changed = true;
      }
    }
    if (changed) {
      this.persistViewedFiles(viewed);
      this.set({ viewedFiles: viewed });
    }
  }

  // ---------------------------------------------------------------------------
  // Diff Loading Actions
  // ---------------------------------------------------------------------------

  setDiffLoading = (filename: string, loading: boolean) => {
    const next = new Set(this.state.loadingFiles);
    if (loading) {
      next.add(filename);
    } else {
      next.delete(filename);
    }
    this.set({ loadingFiles: next });
  };

  setLoadedDiff = (filename: string, diff: ParsedDiff) => {
    // Pre-compute navigable items for O(1) navigation (Fix 2)
    const navigableItems: NavigableItem[] = [];
    let rowIndex = 0;
    let skipIndex = 0;

    for (const hunk of diff.hunks) {
      if (hunk.type === "skip") {
        navigableItems.push({
          type: "skip",
          skipIndex: skipIndex++,
          rowIndex: rowIndex++,
        });
      } else if (hunk.type === "hunk") {
        for (const line of hunk.lines) {
          if (line.type === "delete" && line.oldLineNumber) {
            navigableItems.push({
              type: "line",
              lineNum: line.oldLineNumber,
              side: "old",
              rowIndex: rowIndex++,
            });
          } else if (line.newLineNumber) {
            navigableItems.push({
              type: "line",
              lineNum: line.newLineNumber,
              side: "new",
              rowIndex: rowIndex++,
            });
          }
        }
      }
    }

    // Seed the default context revealed around each gap, and the file's
    // real length (sizes the end-of-file gap). Never overwrite lines the
    // user has already expanded further.
    let expandedSkipBlocks = this.state.expandedSkipBlocks;
    if (diff.gapContext) {
      for (const [idx, segments] of Object.entries(diff.gapContext)) {
        const key = this.getSkipBlockKey(filename, Number(idx));
        if (!expandedSkipBlocks[key]) {
          if (expandedSkipBlocks === this.state.expandedSkipBlocks) {
            expandedSkipBlocks = { ...expandedSkipBlocks };
          }
          expandedSkipBlocks[key] = segments;
        }
      }
    }
    const fileLineCounts =
      diff.totalNewLines !== undefined &&
      this.state.fileLineCounts[filename] !== diff.totalNewLines
        ? { ...this.state.fileLineCounts, [filename]: diff.totalNewLines }
        : this.state.fileLineCounts;

    this.set({
      loadedDiffs: { ...this.state.loadedDiffs, [filename]: diff },
      navigableItems: {
        ...this.state.navigableItems,
        [filename]: navigableItems,
      },
      expandedSkipBlocks,
      fileLineCounts,
    });
  };

  // ---------------------------------------------------------------------------
  // Skip Block Expansion Actions
  // ---------------------------------------------------------------------------

  getSkipBlockKey = (filename: string, skipIndex: number): string => {
    return `${filename}:${skipIndex}`;
  };

  setFileLineCount = (filename: string, count: number) => {
    if (this.state.fileLineCounts[filename] === count) return;
    this.set({
      fileLineCounts: { ...this.state.fileLineCounts, [filename]: count },
    });
  };

  setSkipBlockExpanding = (key: string, expanding: boolean) => {
    const next = new Set(this.state.expandingSkipBlocks);
    if (expanding) {
      next.add(key);
    } else {
      next.delete(key);
    }
    this.set({ expandingSkipBlocks: next });
  };

  /** Reveal more of a skip block from one edge of the remaining gap. */
  appendExpandedSkipBlock = (
    key: string,
    edge: "top" | "bottom",
    lines: DiffLine[]
  ) => {
    const prev = this.state.expandedSkipBlocks[key] ?? { top: [], bottom: [] };
    const next: ExpandedSkipBlock =
      edge === "top"
        ? { top: [...prev.top, ...lines], bottom: prev.bottom }
        : { top: prev.top, bottom: [...lines, ...prev.bottom] };
    this.set({
      expandedSkipBlocks: { ...this.state.expandedSkipBlocks, [key]: next },
    });
  };

  isSkipBlockExpanded = (filename: string, skipIndex: number): boolean => {
    const key = this.getSkipBlockKey(filename, skipIndex);
    return key in this.state.expandedSkipBlocks;
  };

  isSkipBlockExpanding = (filename: string, skipIndex: number): boolean => {
    const key = this.getSkipBlockKey(filename, skipIndex);
    return this.state.expandingSkipBlocks.has(key);
  };

  /** Mark a file as fully expanded (header expand-all button). */
  setFileFullyExpanded = (filename: string) => {
    if (this.state.fullyExpandedFiles.has(filename)) return;
    const next = new Set(this.state.fullyExpandedFiles);
    next.add(filename);
    this.set({ fullyExpandedFiles: next });
  };

  /**
   * Collapse a file's expanded gaps back to the default state: only the
   * seeded context around each change remains visible.
   */
  collapseFileSkipBlocks = (filename: string) => {
    const prefix = `${filename}:`;
    const expandedSkipBlocks: Record<string, ExpandedSkipBlock> = {};
    for (const [key, value] of Object.entries(this.state.expandedSkipBlocks)) {
      if (!key.startsWith(prefix)) expandedSkipBlocks[key] = value;
    }
    const gapContext = this.state.loadedDiffs[filename]?.gapContext;
    if (gapContext) {
      for (const [idx, segments] of Object.entries(gapContext)) {
        expandedSkipBlocks[this.getSkipBlockKey(filename, Number(idx))] =
          segments;
      }
    }
    const fullyExpandedFiles = new Set(this.state.fullyExpandedFiles);
    fullyExpandedFiles.delete(filename);
    this.set({ expandedSkipBlocks, fullyExpandedFiles });
  };

  // ---------------------------------------------------------------------------
  // Line Selection Actions
  // ---------------------------------------------------------------------------

  setFocusedLine = (
    line: number | null,
    side: "old" | "new" | null = "new"
  ) => {
    this.set({
      focusedLine: line,
      focusedLineSide: line !== null ? side : null,
      focusedSkipBlockIndex: null, // Clear skip block focus when focusing a line
    });
  };

  setSelectionAnchor = (
    anchor: number | null,
    side: "old" | "new" | null = null
  ) => {
    this.set({
      selectionAnchor: anchor,
      selectionAnchorSide: anchor !== null ? side : null,
    });
  };

  setFocusedSkipBlock = (index: number | null) => {
    this.set({
      focusedSkipBlockIndex: index,
      focusedLine: null, // Clear line focus when focusing a skip block
      focusedLineSide: null,
      selectionAnchor: null,
      selectionAnchorSide: null,
    });
  };

  // Switch between left (old) and right (new) sides in split view
  // This uses the same split-pair logic as the UI to navigate like a grid
  navigateSide = (direction: "left" | "right") => {
    const {
      focusedLine,
      focusedLineSide,
      selectedFile,
      loadedDiffs,
      diffViewMode,
      expandedSkipBlocks,
    } = this.state;

    // Only works in split view when a line is focused
    if (diffViewMode !== "split") return;
    if (focusedLine === null || focusedLineSide === null) return;

    const targetSide = direction === "left" ? "old" : "new";
    if (focusedLineSide === targetSide) return; // Already on target side

    const diff = selectedFile ? loadedDiffs[selectedFile] : null;
    if (!diff?.hunks) return;

    // Collect all lines from hunks, substituting expanded skip blocks
    const allLines: DiffLine[] = [];
    let skipIndex = 0;
    for (const hunk of diff.hunks) {
      if (hunk.type === "skip") {
        const key = `${selectedFile}:${skipIndex}`;
        const expanded = expandedSkipBlocks[key];
        if (expanded) {
          allLines.push(...expanded.top, ...expanded.bottom);
        }
        skipIndex++;
      } else if (hunk.type === "hunk") {
        allLines.push(...hunk.lines);
      }
    }

    // Convert to split pairs (same logic as convertToSplitPairs in pr-review.tsx)
    type SplitPair = {
      left: DiffLine | null;
      right: DiffLine | null;
    };
    const pairs: SplitPair[] = [];
    let i = 0;

    while (i < allLines.length) {
      const line = allLines[i];

      if (line.type === "normal") {
        // Context line - show on both sides
        pairs.push({ left: line, right: line });
        i++;
      } else if (line.type === "delete") {
        // Collect consecutive deletes
        const deletes: DiffLine[] = [];
        while (i < allLines.length && allLines[i].type === "delete") {
          deletes.push(allLines[i]);
          i++;
        }

        // Collect consecutive inserts that follow
        const inserts: DiffLine[] = [];
        while (i < allLines.length && allLines[i].type === "insert") {
          inserts.push(allLines[i]);
          i++;
        }

        // Pair them up
        const maxLen = Math.max(deletes.length, inserts.length);
        for (let j = 0; j < maxLen; j++) {
          pairs.push({
            left: deletes[j] || null,
            right: inserts[j] || null,
          });
        }
      } else if (line.type === "insert") {
        // Standalone insert (no preceding delete)
        pairs.push({ left: null, right: line });
        i++;
      }
    }

    // Find the pair containing our currently focused line
    for (const pair of pairs) {
      const matchesLeft =
        focusedLineSide === "old" && pair.left?.oldLineNumber === focusedLine;
      const matchesRight =
        focusedLineSide === "new" && pair.right?.newLineNumber === focusedLine;

      if (matchesLeft || matchesRight) {
        // Found the pair - switch to the other side if it exists
        if (direction === "left" && pair.left) {
          const targetLineNum = pair.left.oldLineNumber;
          if (targetLineNum !== undefined) {
            this.setFocusedLine(targetLineNum, "old");
            this.setSelectionAnchor(null, null);
          }
        } else if (direction === "right" && pair.right) {
          const targetLineNum = pair.right.newLineNumber;
          if (targetLineNum !== undefined) {
            this.setFocusedLine(targetLineNum, "new");
            this.setSelectionAnchor(null, null);
          }
        }
        return;
      }
    }
  };

  /**
   * One-shot scroll alignment for the next focus-driven scroll. Change
   * navigation sets "center" so the jumped-to line lands mid-viewport;
   * regular line navigation leaves it "auto" (scroll only if needed).
   */
  private nextScrollAlign: "auto" | "center" = "auto";

  consumeScrollAlign = (): "auto" | "center" => {
    const align = this.nextScrollAlign;
    this.nextScrollAlign = "auto";
    return align;
  };

  /**
   * Jump focus to the first line of the previous/next change block
   * (contiguous run of added/removed lines) in the current file's diff.
   */
  navigateToChange = (direction: "prev" | "next") => {
    const { selectedFile, loadedDiffs, focusedLine, focusedLineSide } =
      this.state;
    if (!selectedFile) return;
    const diff = loadedDiffs[selectedFile];
    if (!diff?.hunks) return;

    type BlockStart = { lineNum: number; side: "old" | "new"; ord: number };
    const blockStarts: BlockStart[] = [];
    let focusedOrd = -1;
    let ord = 0;
    let inChange = false;

    for (const hunk of diff.hunks) {
      if (hunk.type !== "hunk") {
        inChange = false;
        continue;
      }
      for (const line of hunk.lines) {
        const isChange = line.type === "insert" || line.type === "delete";
        const side: "old" | "new" = line.type === "delete" ? "old" : "new";
        const lineNum =
          side === "old" ? line.oldLineNumber : line.newLineNumber;
        if (isChange && !inChange && lineNum) {
          blockStarts.push({ lineNum, side, ord });
        }
        inChange = isChange;
        if (
          focusedLine !== null &&
          lineNum === focusedLine &&
          (focusedLineSide ?? "new") === side
        ) {
          focusedOrd = ord;
        }
        ord++;
      }
    }
    if (blockStarts.length === 0) return;

    let target: BlockStart | undefined;
    if (direction === "next") {
      target =
        focusedOrd === -1
          ? blockStarts[0]
          : blockStarts.find((b) => b.ord > focusedOrd);
    } else {
      target =
        focusedOrd === -1
          ? blockStarts[blockStarts.length - 1]
          : [...blockStarts].reverse().find((b) => b.ord < focusedOrd);
    }
    if (!target) return;

    this.nextScrollAlign = "center";
    this.set({
      suppressFocusHighlight: true,
      focusedLine: target.lineNum,
      focusedLineSide: target.side,
      focusedSkipBlockIndex: null,
      focusedCommentId: null,
      focusedPendingCommentId: null,
      selectionAnchor: null,
      selectionAnchorSide: null,
    });
  };

  navigateLine = (
    direction: "up" | "down",
    withShift: boolean,
    jumpCount: number = 1
  ) => {
    const {
      focusedLine,
      focusedLineSide,
      selectionAnchor,
      selectionAnchorSide,
      selectedFile,
      loadedDiffs,
      expandedSkipBlocks,
      navigableItems: precomputedItems,
      comments,
      pendingComments,
      focusedCommentId,
      focusedPendingCommentId,
      focusedSkipBlockIndex,
    } = this.state;

    if (!selectedFile) return;
    const diff = loadedDiffs[selectedFile];
    if (!diff?.hunks) return;

    // Use pre-computed navigable items (Fix 2)
    // But we need to account for expanded skip blocks dynamically
    type NavLine = { type: "line"; lineNum: number; side: "old" | "new" };
    type NavSkip = { type: "skip"; skipIndex: number };
    type NavItem = NavLine | NavSkip;

    // Check if we can use pre-computed items (no expanded skip blocks)
    const hasExpandedSkipBlocks = Object.keys(expandedSkipBlocks).some((key) =>
      key.startsWith(`${selectedFile}:`)
    );

    let navigableItems: NavItem[];

    if (!hasExpandedSkipBlocks && precomputedItems[selectedFile]) {
      // Fast path: use pre-computed items
      navigableItems = precomputedItems[selectedFile].map(
        (item: NavigableItem) => {
          if (item.type === "skip") {
            return { type: "skip" as const, skipIndex: item.skipIndex! };
          }
          return {
            type: "line" as const,
            lineNum: item.lineNum!,
            side: item.side!,
          };
        }
      );
    } else {
      // Slow path: rebuild with expanded skip blocks
      navigableItems = [];
      let skipIndex = 0;

      for (const hunk of diff.hunks) {
        if (hunk.type === "skip") {
          const currentSkipIndex = skipIndex++;
          // Check if this skip block is expanded
          const key = `${selectedFile}:${currentSkipIndex}`;
          const expanded = expandedSkipBlocks[key];
          const top = expanded?.top ?? [];
          const bottom = expanded?.bottom ?? [];
          const remaining = hunk.count - top.length - bottom.length;

          const pushLines = (lines: DiffLine[]) => {
            for (const line of lines) {
              if (line.type === "delete" && line.oldLineNumber) {
                navigableItems.push({
                  type: "line",
                  lineNum: line.oldLineNumber,
                  side: "old",
                });
              } else if (line.newLineNumber) {
                navigableItems.push({
                  type: "line",
                  lineNum: line.newLineNumber,
                  side: "new",
                });
              }
            }
          };

          pushLines(top);
          if (remaining > 0) {
            // Part of the gap is still collapsed - keep it navigable
            navigableItems.push({ type: "skip", skipIndex: currentSkipIndex });
          }
          pushLines(bottom);
        } else if (hunk.type === "hunk") {
          for (const line of hunk.lines) {
            if (line.type === "delete" && line.oldLineNumber) {
              navigableItems.push({
                type: "line",
                lineNum: line.oldLineNumber,
                side: "old",
              });
            } else if (line.newLineNumber) {
              navigableItems.push({
                type: "line",
                lineNum: line.newLineNumber,
                side: "new",
              });
            }
          }
        }
      }
    }
    if (navigableItems.length === 0) return;

    // Build line-only list for backwards compatibility with comment lookups
    const navigableLines = navigableItems.filter(
      (n): n is NavLine => n.type === "line"
    );
    const commentableLines = navigableLines.map((n) => n.lineNum);

    // Helper to get all comments for a line (sorted for thread navigation)
    const getLineComments = (line: number) => {
      const lineComments = comments.filter(
        (c) =>
          c.path === selectedFile &&
          (c.line === line || c.original_line === line)
      );
      // Sort: root comments first, then replies by ID
      return lineComments.sort((a, b) => {
        if (!a.in_reply_to_id && b.in_reply_to_id) return -1;
        if (a.in_reply_to_id && !b.in_reply_to_id) return 1;
        return a.id - b.id;
      });
    };

    // Helper to get pending comments for a line
    const getLinePendingComments = (line: number) => {
      return pendingComments.filter(
        (c) => c.path === selectedFile && c.line === line
      );
    };

    // Handle navigation when focused on a skip block
    if (focusedSkipBlockIndex !== null) {
      const currentIdx = navigableItems.findIndex(
        (n) => n.type === "skip" && n.skipIndex === focusedSkipBlockIndex
      );

      if (currentIdx !== -1) {
        let nextIdx: number;
        if (direction === "down") {
          nextIdx = Math.min(currentIdx + 1, navigableItems.length - 1);
        } else {
          nextIdx = Math.max(currentIdx - 1, 0);
        }

        const nextItem = navigableItems[nextIdx];
        if (nextItem.type === "skip") {
          this.set({ focusedSkipBlockIndex: nextItem.skipIndex });
        } else {
          this.set({
            focusedLine: nextItem.lineNum,
            focusedLineSide: nextItem.side,
            focusedSkipBlockIndex: null,
            selectionAnchor: null,
            selectionAnchorSide: null,
          });
        }
      }
      return;
    }

    // Handle navigation when focused on a pending comment
    if (focusedPendingCommentId) {
      const focusedPending = pendingComments.find(
        (c) => c.id === focusedPendingCommentId
      );
      if (!focusedPending) {
        this.set({ focusedPendingCommentId: null });
        return;
      }

      const pendingLine = focusedPending.line;
      const linePending = getLinePendingComments(pendingLine);
      const pendingIdx = linePending.findIndex(
        (c) => c.id === focusedPendingCommentId
      );

      if (direction === "down") {
        // Try to go to next pending comment on this line
        if (pendingIdx < linePending.length - 1) {
          this.set({ focusedPendingCommentId: linePending[pendingIdx + 1].id });
          return;
        }
        // No more pending comments, try regular comments on this line
        const lineComments = getLineComments(pendingLine);
        if (lineComments.length > 0) {
          this.set({
            focusedPendingCommentId: null,
            focusedCommentId: lineComments[0].id,
          });
          return;
        }
        // No regular comments, move to next line
        const lineIdx = commentableLines.indexOf(pendingLine);
        if (lineIdx < commentableLines.length - 1) {
          const nextNav = navigableLines[lineIdx + 1];
          this.set({
            focusedLine: nextNav.lineNum,
            focusedLineSide: nextNav.side,
            focusedPendingCommentId: null,
            focusedCommentId: null,
            selectionAnchor: null,
            selectionAnchorSide: null,
          });
        }
        return;
      } else {
        // Going up - try to go to previous pending comment
        if (pendingIdx > 0) {
          this.set({ focusedPendingCommentId: linePending[pendingIdx - 1].id });
          return;
        }
        // No more pending comments above, go back to line (default to 'new' side)
        this.set({
          focusedLine: pendingLine,
          focusedLineSide: "new",
          focusedPendingCommentId: null,
          selectionAnchor: null,
          selectionAnchorSide: null,
        });
        return;
      }
    }

    // Handle navigation when focused on a regular comment
    if (focusedCommentId) {
      const focusedComment = comments.find((c) => c.id === focusedCommentId);
      if (!focusedComment) {
        this.set({ focusedCommentId: null });
        return;
      }

      const commentLine = focusedComment.line ?? focusedComment.original_line;
      const lineComments = commentLine ? getLineComments(commentLine) : [];
      const commentIdx = lineComments.findIndex(
        (c) => c.id === focusedCommentId
      );

      if (direction === "down") {
        // Try to go to next comment in thread
        if (commentIdx < lineComments.length - 1) {
          this.set({ focusedCommentId: lineComments[commentIdx + 1].id });
          return;
        }
        // No more comments, move to next line
        if (commentLine) {
          const lineIdx = commentableLines.indexOf(commentLine);
          if (lineIdx < commentableLines.length - 1) {
            const nextNav = navigableLines[lineIdx + 1];
            this.set({
              focusedLine: nextNav.lineNum,
              focusedLineSide: nextNav.side,
              focusedCommentId: null,
              selectionAnchor: null,
              selectionAnchorSide: null,
            });
          }
        }
        return;
      } else {
        // Going up - try to go to previous comment in thread
        if (commentIdx > 0) {
          this.set({ focusedCommentId: lineComments[commentIdx - 1].id });
          return;
        }
        // No more regular comments above, check for pending comments
        if (commentLine) {
          const linePending = getLinePendingComments(commentLine);
          if (linePending.length > 0) {
            this.set({
              focusedCommentId: null,
              focusedPendingCommentId: linePending[linePending.length - 1].id,
            });
            return;
          }
          // No pending comments, go back to line (default to 'new' side)
          this.set({
            focusedLine: commentLine,
            focusedLineSide: "new",
            focusedCommentId: null,
            selectionAnchor: null,
            selectionAnchorSide: null,
          });
        }
        return;
      }
    }

    // Handle down navigation when on a line - check for pending comments first, then regular comments
    if (direction === "down" && focusedLine) {
      // First check pending comments
      const linePending = getLinePendingComments(focusedLine);
      if (linePending.length > 0) {
        this.set({
          focusedPendingCommentId: linePending[0].id,
          focusedLine: null,
          selectionAnchor: null,
        });
        return;
      }

      // Then check regular comments
      const lineComments = getLineComments(focusedLine);
      if (lineComments.length > 0) {
        this.set({
          focusedCommentId: lineComments[0].id,
          focusedLine: null,
          selectionAnchor: null,
        });
        return;
      }
    }

    // In split view, navigate through visual rows while staying on the same side
    const { diffViewMode } = this.state;
    if (diffViewMode === "split" && focusedLine !== null && focusedLineSide) {
      // Collect all lines for split pair computation
      const allLines: DiffLine[] = [];
      let skipIdx = 0;
      const skipBlockIndices: { pairIdx: number; skipIndex: number }[] = [];

      for (const hunk of diff.hunks) {
        if (hunk.type === "skip") {
          const key = `${selectedFile}:${skipIdx}`;
          const expanded = expandedSkipBlocks[key];
          const top = expanded?.top ?? [];
          const bottom = expanded?.bottom ?? [];
          allLines.push(...top);
          if (top.length + bottom.length < hunk.count) {
            // Mark where the still-collapsed gap would appear in pairs
            skipBlockIndices.push({
              pairIdx: allLines.length, // Will be adjusted after pair conversion
              skipIndex: skipIdx,
            });
          }
          allLines.push(...bottom);
          skipIdx++;
        } else if (hunk.type === "hunk") {
          allLines.push(...hunk.lines);
        }
      }

      // Convert to split pairs
      type SplitPair = {
        type: "pair";
        left: DiffLine | null;
        right: DiffLine | null;
      };
      type SplitSkip = { type: "skip"; skipIndex: number };
      type SplitItem = SplitPair | SplitSkip;

      const pairs: SplitItem[] = [];
      let i = 0;

      // Insert skip blocks at correct positions
      const getSkipAtLineIdx = (idx: number) =>
        skipBlockIndices.find((s) => s.pairIdx === idx);

      while (i < allLines.length) {
        // Check if there's a skip block before this line
        const skipHere = getSkipAtLineIdx(i);
        if (skipHere) {
          pairs.push({ type: "skip", skipIndex: skipHere.skipIndex });
          // Remove from tracking
          skipBlockIndices.splice(skipBlockIndices.indexOf(skipHere), 1);
        }

        const line = allLines[i];

        if (line.type === "normal") {
          pairs.push({ type: "pair", left: line, right: line });
          i++;
        } else if (line.type === "delete") {
          const deletes: DiffLine[] = [];
          while (i < allLines.length && allLines[i].type === "delete") {
            deletes.push(allLines[i]);
            i++;
          }
          const inserts: DiffLine[] = [];
          while (i < allLines.length && allLines[i].type === "insert") {
            inserts.push(allLines[i]);
            i++;
          }
          const maxLen = Math.max(deletes.length, inserts.length);
          for (let j = 0; j < maxLen; j++) {
            pairs.push({
              type: "pair",
              left: deletes[j] || null,
              right: inserts[j] || null,
            });
          }
        } else if (line.type === "insert") {
          pairs.push({ type: "pair", left: null, right: line });
          i++;
        }
      }

      // Add any remaining skip blocks at the end
      for (const skip of skipBlockIndices) {
        pairs.push({ type: "skip", skipIndex: skip.skipIndex });
      }

      // Find current pair index
      const currentPairIdx = pairs.findIndex((item) => {
        if (item.type === "skip") return false;
        if (focusedLineSide === "old") {
          return item.left?.oldLineNumber === focusedLine;
        } else {
          return item.right?.newLineNumber === focusedLine;
        }
      });

      if (currentPairIdx !== -1) {
        let nextPairIdx: number;
        if (direction === "down") {
          nextPairIdx = Math.min(currentPairIdx + jumpCount, pairs.length - 1);
        } else {
          nextPairIdx = Math.max(currentPairIdx - jumpCount, 0);
        }

        const nextPair = pairs[nextPairIdx];

        // If next is a skip block, focus it
        if (nextPair.type === "skip") {
          this.set({
            focusedSkipBlockIndex: nextPair.skipIndex,
            focusedLine: null,
            focusedLineSide: null,
            selectionAnchor: null,
            selectionAnchorSide: null,
            focusedCommentId: null,
            focusedPendingCommentId: null,
          });
          return;
        }

        // Try to stay on the same side
        let nextLine: number | undefined;
        let nextSide = focusedLineSide;

        if (focusedLineSide === "old" && nextPair.left) {
          nextLine = nextPair.left.oldLineNumber;
        } else if (focusedLineSide === "new" && nextPair.right) {
          nextLine = nextPair.right.newLineNumber;
        } else if (nextPair.left) {
          // Fallback to left side if preferred side not available
          nextLine = nextPair.left.oldLineNumber;
          nextSide = "old";
        } else if (nextPair.right) {
          // Fallback to right side
          nextLine = nextPair.right.newLineNumber;
          nextSide = "new";
        }

        if (nextLine !== undefined) {
          // Handle up navigation - check for comments
          if (
            direction === "up" &&
            (nextLine !== focusedLine || nextSide !== focusedLineSide)
          ) {
            const targetLineComments = getLineComments(nextLine);
            if (targetLineComments.length > 0) {
              this.set({
                focusedCommentId:
                  targetLineComments[targetLineComments.length - 1].id,
                focusedLine: null,
                focusedLineSide: null,
                focusedSkipBlockIndex: null,
                selectionAnchor: null,
                selectionAnchorSide: null,
              });
              return;
            }
            const targetLinePending = getLinePendingComments(nextLine);
            if (targetLinePending.length > 0) {
              this.set({
                focusedPendingCommentId:
                  targetLinePending[targetLinePending.length - 1].id,
                focusedLine: null,
                focusedLineSide: null,
                focusedSkipBlockIndex: null,
                selectionAnchor: null,
                selectionAnchorSide: null,
              });
              return;
            }
          }

          if (withShift) {
            this.set({
              focusedLine: nextLine,
              focusedLineSide: nextSide,
              selectionAnchor: selectionAnchor ?? focusedLine ?? nextLine,
              selectionAnchorSide:
                selectionAnchorSide ?? focusedLineSide ?? nextSide,
              focusedSkipBlockIndex: null,
              focusedCommentId: null,
              focusedPendingCommentId: null,
            });
          } else {
            this.set({
              focusedLine: nextLine,
              focusedLineSide: nextSide,
              selectionAnchor: null,
              selectionAnchorSide: null,
              focusedSkipBlockIndex: null,
              focusedCommentId: null,
              focusedPendingCommentId: null,
            });
          }
          return;
        }
      }
    }

    // Normal line/skip navigation (unified view or fallback)
    const currentIdx =
      focusedLine !== null
        ? navigableItems.findIndex(
            (n) =>
              n.type === "line" &&
              n.lineNum === focusedLine &&
              n.side === (focusedLineSide ?? "new")
          )
        : -1;

    let nextIdx: number;
    if (direction === "down") {
      nextIdx =
        currentIdx === -1
          ? 0
          : Math.min(currentIdx + jumpCount, navigableItems.length - 1);
    } else {
      nextIdx =
        currentIdx === -1
          ? navigableItems.length - 1
          : Math.max(currentIdx - jumpCount, 0);
    }

    const nextItem = navigableItems[nextIdx];

    // If next item is a skip block, focus it
    if (nextItem.type === "skip") {
      this.set({
        focusedSkipBlockIndex: nextItem.skipIndex,
        focusedLine: null,
        focusedLineSide: null,
        selectionAnchor: null,
        selectionAnchorSide: null,
        focusedCommentId: null,
        focusedPendingCommentId: null,
      });
      return;
    }

    const nextLine = nextItem.lineNum;
    const nextSide = nextItem.side;

    // Handle up navigation - check if the target line has comments to enter (from the bottom)
    if (
      direction === "up" &&
      focusedLine &&
      (nextLine !== focusedLine || nextSide !== focusedLineSide)
    ) {
      // First check regular comments on target line (enter from the bottom/last comment)
      const targetLineComments = getLineComments(nextLine);
      if (targetLineComments.length > 0) {
        this.set({
          focusedCommentId:
            targetLineComments[targetLineComments.length - 1].id,
          focusedLine: null,
          focusedLineSide: null,
          focusedSkipBlockIndex: null,
          selectionAnchor: null,
          selectionAnchorSide: null,
        });
        return;
      }

      // Then check pending comments on target line (enter from the bottom/last comment)
      const targetLinePending = getLinePendingComments(nextLine);
      if (targetLinePending.length > 0) {
        this.set({
          focusedPendingCommentId:
            targetLinePending[targetLinePending.length - 1].id,
          focusedLine: null,
          focusedLineSide: null,
          focusedSkipBlockIndex: null,
          selectionAnchor: null,
          selectionAnchorSide: null,
        });
        return;
      }
    }

    if (withShift) {
      this.set({
        focusedLine: nextLine,
        focusedLineSide: nextSide,
        selectionAnchor: selectionAnchor ?? focusedLine ?? nextLine,
        selectionAnchorSide: selectionAnchorSide ?? focusedLineSide ?? nextSide,
        focusedSkipBlockIndex: null,
        focusedCommentId: null,
        focusedPendingCommentId: null,
      });
    } else {
      this.set({
        focusedLine: nextLine,
        focusedLineSide: nextSide,
        selectionAnchor: null,
        selectionAnchorSide: null,
        focusedSkipBlockIndex: null,
        focusedCommentId: null,
        focusedPendingCommentId: null,
      });
    }
  };

  startCommenting = (line: number, startLine?: number) => {
    this.set({ commentingOnLine: { line, startLine } });
  };

  startCommentingOnFocusedLine = () => {
    const { focusedLine, selectionAnchor } = this.state;
    if (!focusedLine) return;

    const startLine = selectionAnchor
      ? Math.min(focusedLine, selectionAnchor)
      : undefined;
    const endLine = selectionAnchor
      ? Math.max(focusedLine, selectionAnchor)
      : focusedLine;

    this.set({
      commentingOnLine: {
        line: endLine,
        startLine: startLine !== endLine ? startLine : undefined,
      },
    });
  };

  cancelCommenting = () => {
    this.set({ commentingOnLine: null });
  };

  enterGotoMode = () => {
    this.set({ gotoLineMode: true, gotoLineInput: "" });
  };

  exitGotoMode = () => {
    this.set({ gotoLineMode: false, gotoLineInput: "", gotoLineSide: "new" });
  };

  toggleGotoLineSide = () => {
    this.set({
      gotoLineSide: this.state.gotoLineSide === "new" ? "old" : "new",
    });
  };

  appendGotoInput = (char: string) => {
    this.set({ gotoLineInput: this.state.gotoLineInput + char });
  };

  backspaceGotoInput = () => {
    this.set({ gotoLineInput: this.state.gotoLineInput.slice(0, -1) });
  };

  executeGotoLine = () => {
    const {
      gotoLineInput,
      gotoLineSide,
      selectedFile,
      loadedDiffs,
      diffViewMode,
    } = this.state;
    const targetLine = parseInt(gotoLineInput, 10);
    if (isNaN(targetLine)) {
      this.exitGotoMode();
      return;
    }

    const diff = selectedFile ? loadedDiffs[selectedFile] : null;
    if (!diff?.hunks) {
      this.exitGotoMode();
      return;
    }

    // Build navigable lines with the line number to use for focusing
    // In unified view: delete lines → "old" side, insert/context → "new" side
    // In split view: respect the user's column choice since both sides are visible
    type NavLine = {
      searchNum: number; // The number in the column the user selected
      focusNum: number; // The line number to use for focusing
      focusSide: "old" | "new"; // The side to use for focusing
    };
    const navigableLines: NavLine[] = [];

    for (const hunk of diff.hunks) {
      if (hunk.type === "hunk") {
        for (const line of hunk.lines) {
          if (gotoLineSide === "old") {
            // User wants to jump to a line number in the "old" column (left side in split)
            if (line.oldLineNumber !== undefined) {
              if (line.type === "delete") {
                // Delete lines: focus with old side and oldLineNumber
                navigableLines.push({
                  searchNum: line.oldLineNumber,
                  focusNum: line.oldLineNumber,
                  focusSide: "old",
                });
              } else if (diffViewMode === "split") {
                // Split view: context lines can be focused on either side
                // User chose "old" so focus on the left side with oldLineNumber
                navigableLines.push({
                  searchNum: line.oldLineNumber,
                  focusNum: line.oldLineNumber,
                  focusSide: "old",
                });
              } else {
                // Unified view: context lines are focused with new side
                navigableLines.push({
                  searchNum: line.oldLineNumber,
                  focusNum: line.newLineNumber!,
                  focusSide: "new",
                });
              }
            }
          } else {
            // User wants to jump to a line number in the "new" column (right side in split)
            if (line.newLineNumber !== undefined) {
              navigableLines.push({
                searchNum: line.newLineNumber,
                focusNum: line.newLineNumber,
                focusSide: line.type === "delete" ? "old" : "new",
              });
            }
          }
        }
      }
    }

    if (navigableLines.length > 0) {
      const closest = navigableLines.reduce((best, current) =>
        Math.abs(current.searchNum - targetLine) <
        Math.abs(best.searchNum - targetLine)
          ? current
          : best
      );
      this.set({
        focusedLine: closest.focusNum,
        focusedLineSide: closest.focusSide,
        selectionAnchor: null,
        selectionAnchorSide: null,
        gotoLineMode: false,
        gotoLineInput: "",
        gotoLineSide: "new", // Reset to default
      });
    } else {
      this.exitGotoMode();
    }
  };

  clearLineSelection = () => {
    this.set({
      focusedLine: null,
      focusedLineSide: null,
      selectionAnchor: null,
      selectionAnchorSide: null,
      focusedSkipBlockIndex: null,
      commentingOnLine: null,
      gotoLineMode: false,
      gotoLineInput: "",
    });
  };

  // ---------------------------------------------------------------------------
  // Comment Actions
  // ---------------------------------------------------------------------------

  // Recompute comment range lookup for O(1) line lookup (Fix 3)
  private recomputeCommentRangeLookup = () => {
    const lookup: Record<string, Set<number>> = {};
    const { comments, pendingComments } = this.state;

    // Process regular comments
    for (const comment of comments) {
      if (!comment.path) continue;
      if (!lookup[comment.path]) lookup[comment.path] = new Set();

      if (comment.start_line && comment.line) {
        for (let i = comment.start_line; i <= comment.line; i++) {
          lookup[comment.path].add(i);
        }
      }
    }

    // Process pending comments
    for (const comment of pendingComments) {
      if (!comment.path) continue;
      if (!lookup[comment.path]) lookup[comment.path] = new Set();

      if (comment.start_line && comment.line) {
        for (let i = comment.start_line; i <= comment.line; i++) {
          lookup[comment.path].add(i);
        }
      }
    }

    this.set({ commentRangeLookup: lookup });
  };

  setComments = (comments: ReviewComment[]) => {
    this.set({ comments });
    this.recomputeCommentRangeLookup();
  };

  setReviews = (reviews: Review[]) => {
    this.set({ reviews });
  };

  setTimeline = (timeline: TimelineEvent[]) => {
    this.set({ timeline });
  };

  setPr = (pr: PullRequest) => {
    this.set({ pr });
  };

  setFocusedCommentId = (id: number | null) => {
    this.set({ focusedCommentId: id });
  };

  startEditing = (commentId: number) => {
    this.set({ editingCommentId: commentId });
  };

  cancelEditing = () => {
    this.set({ editingCommentId: null });
  };

  startReplying = (commentId: number) => {
    this.set({ replyingToCommentId: commentId });
  };

  cancelReplying = () => {
    this.set({ replyingToCommentId: null });
  };

  // ---------------------------------------------------------------------------
  // Pending Comment Focus/Edit Actions
  // ---------------------------------------------------------------------------

  setFocusedPendingCommentId = (id: string | null) => {
    this.set({ focusedPendingCommentId: id, focusedCommentId: null });
  };

  startEditingPendingComment = (id: string) => {
    this.set({ editingPendingCommentId: id });
  };

  cancelEditingPendingComment = () => {
    this.set({ editingPendingCommentId: null });
  };

  updatePendingCommentBody = (id: string, body: string) => {
    const pendingComments = this.state.pendingComments.map((c) =>
      c.id === id ? { ...c, body } : c
    );
    this.persistPendingComments(pendingComments);
    this.set({ pendingComments, editingPendingCommentId: null });
  };

  addPendingComment = (comment: LocalPendingComment) => {
    const pendingComments = [...this.state.pendingComments, comment];
    this.persistPendingComments(pendingComments);
    this.set({
      pendingComments,
      commentingOnLine: null,
      focusedLine: null,
      focusedLineSide: null,
      selectionAnchor: null,
      selectionAnchorSide: null,
      focusedPendingCommentId: comment.id,
      focusedCommentId: null,
    });
    this.recomputeCommentRangeLookup();
  };

  removePendingComment = (id: string) => {
    // Find the comment to get its line before deleting
    const comment = this.state.pendingComments.find((c) => c.id === id);
    const commentLine = comment?.line;

    const pendingComments = this.state.pendingComments.filter(
      (c) => c.id !== id
    );
    this.persistPendingComments(pendingComments);
    this.set({
      pendingComments,
      focusedPendingCommentId: null,
      // Focus the line the comment was on so user can continue with keyboard
      focusedLine: commentLine ?? null,
      focusedLineSide: commentLine ? "new" : null,
    });
    this.recomputeCommentRangeLookup();
  };

  updatePendingCommentWithGitHubIds = (
    localId: string,
    reviewNodeId: string,
    commentNodeId: string,
    commentDatabaseId: number
  ) => {
    const pendingComments = this.state.pendingComments.map((c) =>
      c.id === localId
        ? { ...c, nodeId: commentNodeId, databaseId: commentDatabaseId }
        : c
    );
    // Also store the review node ID
    this.pendingReviewNodeId = reviewNodeId;
    this.persistPendingComments(pendingComments);
    this.set({ pendingComments });
  };

  // Store the pending review node ID for submission
  private pendingReviewNodeId: string | null = null;

  getPendingReviewNodeId = () => this.pendingReviewNodeId;
  setPendingReviewNodeId = (id: string | null) => {
    this.pendingReviewNodeId = id;
  };

  updateComment = (commentId: number, updatedComment: ReviewComment) => {
    this.set({
      comments: this.state.comments.map((c) =>
        c.id === commentId ? updatedComment : c
      ),
      editingCommentId: null,
    });
  };

  deleteComment = (commentId: number) => {
    // Find the comment to get its line before deleting
    const comment = this.state.comments.find((c) => c.id === commentId);
    const commentLine = comment?.line ?? comment?.original_line;

    this.set({
      comments: this.state.comments.filter((c) => c.id !== commentId),
      focusedCommentId: null,
      // Focus the line the comment was on so user can continue with keyboard
      focusedLine: commentLine ?? null,
      focusedLineSide: commentLine ? "new" : null,
    });
  };

  addReply = (reply: ReviewComment) => {
    this.set({
      comments: [...this.state.comments, reply],
      replyingToCommentId: null,
    });
  };

  // ---------------------------------------------------------------------------
  // Review Actions
  // ---------------------------------------------------------------------------

  setPendingReviewId = (id: number | null) => {
    this.set({ pendingReviewId: id });
  };

  setPendingComments = (comments: LocalPendingComment[]) => {
    this.set({ pendingComments: comments });
  };

  setReviewBody = (body: string) => {
    this.persistReviewBody(body);
    this.set({ reviewBody: body });
  };

  openReviewPanel = () => {
    this.set({ showReviewPanel: true });
  };

  closeReviewPanel = () => {
    this.set({ showReviewPanel: false });
  };

  setSubmittingReview = (submitting: boolean) => {
    this.set({ submittingReview: submitting });
  };

  clearReviewState = () => {
    this.clearPendingState();
    this.set({
      pendingComments: [],
      pendingReviewId: null,
      reviewBody: "",
      showReviewPanel: false,
      submittingReview: false,
    });
  };

  // ---------------------------------------------------------------------------
  // Clear All
  // ---------------------------------------------------------------------------

  clearAllSelections = () => {
    const { focusedCommentId, focusedPendingCommentId } = this.state;
    if (focusedCommentId) {
      this.set({ focusedCommentId: null });
    } else if (focusedPendingCommentId) {
      this.set({ focusedPendingCommentId: null });
    } else {
      this.set({
        focusedLine: null,
        focusedLineSide: null,
        selectionAnchor: null,
        selectionAnchorSide: null,
        selectedFiles: new Set(),
      });
    }
  };

  // ---------------------------------------------------------------------------
  // URL Hash Navigation
  // ---------------------------------------------------------------------------

  /**
   * Get the current navigation state as a URL hash string.
   * Format: #file=<path>&L<line> or #file=<path>&L<start>-<end> or #file=<path>&C<commentId>
   * Also supports GitHub-style: #pullrequestreview-{id} or #issuecomment-{id}
   */
  getHashFromState = (): string => {
    const {
      selectedFile,
      focusedLine,
      selectionAnchor,
      focusedCommentId,
      focusedPendingCommentId,
      showOverview,
      overviewScrollTarget,
    } = this.state;

    // If we're on overview with a scroll target, use GitHub-style hash
    if (showOverview && overviewScrollTarget) {
      return overviewScrollTarget;
    }

    if (!selectedFile) return "";

    const params = new URLSearchParams();
    params.set("file", selectedFile);

    // Comment takes priority over line selection
    if (focusedCommentId) {
      params.set("comment", String(focusedCommentId));
    } else if (focusedPendingCommentId) {
      params.set("pending", focusedPendingCommentId);
    } else if (focusedLine) {
      if (selectionAnchor && selectionAnchor !== focusedLine) {
        const start = Math.min(focusedLine, selectionAnchor);
        const end = Math.max(focusedLine, selectionAnchor);
        params.set("L", `${start}-${end}`);
      } else {
        params.set("L", String(focusedLine));
      }
    }

    return params.toString();
  };

  /**
   * Navigate to a state from a URL hash string.
   * Returns true if navigation was performed.
   * Supports GitHub-style hashes: #pullrequestreview-{id}, #issuecomment-{id}, #discussion_r{id}
   * Empty hash navigates to the overview screen.
   */
  navigateFromHash = (hash: string): boolean => {
    // Remove leading # if present
    const hashStr = hash.startsWith("#") ? hash.slice(1) : hash;

    // Empty hash means navigate to overview
    if (!hashStr) {
      this.selectOverview();
      return true;
    }

    // Check for GitHub-style overview hashes first
    const reviewMatch = hashStr.match(/^pullrequestreview-(\d+)$/);
    const commentMatch = hashStr.match(/^issuecomment-(\d+)$/);
    const discussionMatch = hashStr.match(/^discussion_r(\d+)$/);

    if (reviewMatch || commentMatch || discussionMatch) {
      // Navigate to overview with scroll target
      this.selectOverview(hashStr);
      return true;
    }

    const params = new URLSearchParams(hashStr);
    const file = params.get("file");
    const lineParam = params.get("L");
    const commentParam = params.get("comment");
    const pendingParam = params.get("pending");

    if (!file) return false;

    // Check if file exists
    const fileExists = this.state.files.some((f) => f.filename === file);
    if (!fileExists) return false;

    // Select the file
    if (this.state.selectedFile !== file) {
      this.selectFile(file);
    }

    // Handle comment focus
    if (commentParam) {
      const commentId = parseInt(commentParam, 10);
      if (!isNaN(commentId)) {
        // We need to wait for the file's diff to load before focusing comments
        // The hash navigation hook will handle the timing
        this.set({ focusedCommentId: commentId });
        return true;
      }
    }

    // Handle pending comment focus
    if (pendingParam) {
      this.set({ focusedPendingCommentId: pendingParam });
      return true;
    }

    // Handle line focus (default to 'new' side since we don't know the diff structure yet)
    if (lineParam) {
      const rangeMatch = lineParam.match(/^(\d+)-(\d+)$/);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1], 10);
        const end = parseInt(rangeMatch[2], 10);
        this.set({
          focusedLine: end,
          focusedLineSide: "new",
          selectionAnchor: start,
          selectionAnchorSide: "new",
          focusedSkipBlockIndex: null,
          focusedCommentId: null,
          focusedPendingCommentId: null,
        });
      } else {
        const line = parseInt(lineParam, 10);
        if (!isNaN(line)) {
          this.set({
            focusedLine: line,
            focusedLineSide: "new",
            selectionAnchor: null,
            selectionAnchorSide: null,
            focusedSkipBlockIndex: null,
            focusedCommentId: null,
            focusedPendingCommentId: null,
          });
        }
      }
      return true;
    }

    return true;
  };

  // ---------------------------------------------------------------------------
  // Data Loading
  // ---------------------------------------------------------------------------

  /**
   * Load all PR data (reviews, timeline, checks, etc.)
   * Called after the store is created to populate data.
   */
  loadPRData = async (): Promise<void> => {
    const { owner, repo, pr } = this.state;

    try {
      const [
        reviewsData,
        checksData,
        workflowRunsData,
        conversationData,
        commitsData,
        timelineData,
        reviewThreadsResult,
      ] = await Promise.all([
        this.github
          .getPRReviews(owner, repo, pr.number)
          .catch(() => [] as Review[]),
        this.github.getPRChecks(owner, repo, pr.head.sha).catch(() => null),
        this.github.getWorkflowRuns(owner, repo, pr.head.sha).catch(() => ({
          workflow_runs: [] as Array<{
            id: number;
            name: string;
            conclusion: string | null;
            html_url: string;
          }>,
        })),
        this.github
          .getPRConversation(owner, repo, pr.number)
          .catch(() => [] as IssueComment[]),
        this.github
          .getPRCommits(owner, repo, pr.number)
          .catch(() => [] as PRCommit[]),
        this.github
          .getPRTimeline(owner, repo, pr.number)
          .catch(() => [] as TimelineEvent[]),
        this.github.getReviewThreads(owner, repo, pr.number).catch(() => ({
          threads: [] as ReviewThread[],
          viewerPermission: null,
          viewerCanMergeAsAdmin: false,
        })),
      ]);

      // Find workflow runs awaiting approval (fork PRs)
      const awaitingApproval = workflowRunsData.workflow_runs
        .filter(
          (run) =>
            run.conclusion === "action_required" &&
            !this.recentlyApprovedWorkflowIds.has(run.id)
        )
        .map((run) => ({
          id: run.id,
          name: run.name || "Workflow",
          html_url: run.html_url,
        }));

      // Check if branch was already deleted from timeline
      const deleteCount = timelineData.filter(
        (event) => (event as { event?: string }).event === "head_ref_deleted"
      ).length;
      const restoreCount = timelineData.filter(
        (event) => (event as { event?: string }).event === "head_ref_restored"
      ).length;

      this.set({
        reviews: reviewsData,
        checks: checksData,
        checksLastUpdated: new Date(),
        workflowRunsAwaitingApproval: awaitingApproval,
        conversation: conversationData,
        commits: commitsData,
        timeline: timelineData,
        reviewThreads: reviewThreadsResult.threads,
        viewerPermission:
          reviewThreadsResult.viewerPermission ?? this.state.viewerPermission,
        viewerCanMergeAsAdmin: reviewThreadsResult.viewerCanMergeAsAdmin,
        branchDeleted: deleteCount > restoreCount,
        loading: false,
      });
    } catch (error) {
      console.error("Failed to load PR data:", error);
      this.set({ loading: false });
    }
  };

  /**
   * Refresh just the checks data
   */
  refreshChecks = async (): Promise<void> => {
    const { owner, repo, pr } = this.state;

    this.set({ loadingChecks: true });

    try {
      const [checksData, workflowRunsData] = await Promise.all([
        this.github.getPRChecks(owner, repo, pr.head.sha).catch(() => null),
        this.github.getWorkflowRuns(owner, repo, pr.head.sha).catch(() => ({
          workflow_runs: [] as Array<{
            id: number;
            name: string;
            conclusion: string | null;
            html_url: string;
          }>,
        })),
      ]);

      // Find workflow runs awaiting approval, filtering recently approved
      const awaitingApproval = workflowRunsData.workflow_runs
        .filter(
          (run) =>
            run.conclusion === "action_required" &&
            !this.recentlyApprovedWorkflowIds.has(run.id)
        )
        .map((run) => ({
          id: run.id,
          name: run.name || "Workflow",
          html_url: run.html_url,
        }));

      this.set({
        checks: checksData,
        checksLastUpdated: new Date(),
        workflowRunsAwaitingApproval: awaitingApproval,
        loadingChecks: false,
      });
    } catch (error) {
      console.error("Failed to refresh checks:", error);
      this.set({ loadingChecks: false });
    }
  };

  // ---------------------------------------------------------------------------
  // PR Mutations
  // ---------------------------------------------------------------------------

  setMergeMethod = (method: MergeMethod) => {
    this.set({ mergeMethod: method });
  };

  /**
   * Merge the PR. Handles the full flow:
   * - API call
   * - Cache invalidation
   * - State update
   */
  mergePR = async (): Promise<boolean> => {
    const { owner, repo, pr, mergeMethod } = this.state;

    this.set({ merging: true, mergeError: null });

    try {
      await this.github.mergePR(owner, repo, pr.number, {
        merge_method: mergeMethod,
      });

      // Invalidate timeline cache and refetch
      this.github.invalidateCache(`pr:${owner}/${repo}/${pr.number}:timeline`);

      // Refetch PR and timeline to get updated state
      const [updatedPR, updatedTimeline] = await Promise.all([
        this.github.getPR(owner, repo, pr.number),
        this.github
          .getPRTimeline(owner, repo, pr.number)
          .catch(() => [] as TimelineEvent[]),
      ]);

      this.set({
        pr: updatedPR,
        timeline: updatedTimeline,
        merging: false,
      });

      return true;
    } catch (e) {
      this.set({
        mergeError: e instanceof Error ? e.message : "Failed to merge",
        merging: false,
      });
      return false;
    }
  };

  /**
   * Close the PR
   */
  closePR = async (): Promise<boolean> => {
    const { owner, repo, pr } = this.state;

    this.set({ closingPR: true });

    try {
      // 1. Request GitHub to close PR
      await this.github.closePR(owner, repo, pr.number);

      // 2. Invalidate all PR-related caches FIRST
      this.invalidatePRCaches(owner, repo, pr.number);

      // 3. Update with LATEST state
      this.set({
        pr: { ...this.state.pr, state: "closed" as const },
        closingPR: false,
      });

      // 4. Refetch timeline in background (close creates event)
      this.github
        .getPRTimeline(owner, repo, pr.number)
        .then((timeline) => this.set({ timeline }))
        .catch(() => {});

      return true;
    } catch (e) {
      console.error("Failed to close PR:", e);
      this.set({ closingPR: false });
      return false;
    }
  };

  /**
   * Reopen the PR
   */
  reopenPR = async (): Promise<boolean> => {
    const { owner, repo, pr } = this.state;

    this.set({ reopeningPR: true });

    try {
      // 1. Request GitHub to reopen PR
      await this.github.reopenPR(owner, repo, pr.number);

      // 2. Invalidate all PR-related caches FIRST
      this.invalidatePRCaches(owner, repo, pr.number);

      // 3. Update with LATEST state
      this.set({
        pr: { ...this.state.pr, state: "open" as const },
        reopeningPR: false,
      });

      // 4. Refetch timeline in background (reopen creates event)
      this.github
        .getPRTimeline(owner, repo, pr.number)
        .then((timeline) => this.set({ timeline }))
        .catch(() => {});

      return true;
    } catch (e) {
      console.error("Failed to reopen PR:", e);
      this.set({ reopeningPR: false });
      return false;
    }
  };

  /**
   * Delete the head branch
   */
  deleteBranch = async (): Promise<boolean> => {
    const { owner, repo, pr } = this.state;

    this.set({ deletingBranch: true });

    try {
      await this.github.deleteBranch(owner, repo, pr.head.ref);

      // Refetch timeline to show delete event
      const updatedTimeline = await this.github
        .getPRTimeline(owner, repo, pr.number)
        .catch(() => [] as TimelineEvent[]);

      this.set({
        branchDeleted: true,
        timeline: updatedTimeline,
        deletingBranch: false,
      });

      return true;
    } catch (e) {
      console.error("Failed to delete branch:", e);
      this.set({ deletingBranch: false });
      return false;
    }
  };

  /**
   * Restore a deleted branch
   */
  restoreBranch = async (): Promise<boolean> => {
    const { owner, repo, pr } = this.state;

    this.set({ restoringBranch: true });

    try {
      await this.github.restoreBranch(owner, repo, pr.head.ref, pr.head.sha);

      // Refetch timeline to show restore event
      const updatedTimeline = await this.github
        .getPRTimeline(owner, repo, pr.number)
        .catch(() => [] as TimelineEvent[]);

      this.set({
        branchDeleted: false,
        timeline: updatedTimeline,
        restoringBranch: false,
      });

      return true;
    } catch (e) {
      console.error("Failed to restore branch:", e);
      this.set({ restoringBranch: false });
      return false;
    }
  };

  /**
   * Invalidate all caches for a PR (main PR + all related data)
   */
  private invalidatePRCaches(owner: string, repo: string, prNumber: number) {
    // Invalidate all PR-related caches (using pattern matching)
    this.github.invalidateCache(`pr:${owner}/${repo}/${prNumber}`);
  }

  /**
   * Convert PR to draft
   */
  convertToDraft = async (): Promise<boolean> => {
    const { owner, repo, pr } = this.state;

    this.set({ convertingToDraft: true });

    try {
      // 1. Request GitHub to convert to draft
      await this.github.convertToDraft(owner, repo, pr.number);

      // 2. Invalidate all PR-related caches FIRST
      this.invalidatePRCaches(owner, repo, pr.number);

      // 3. Update with LATEST state
      this.set({
        pr: { ...this.state.pr, draft: true },
        convertingToDraft: false,
      });

      // 4. Refetch timeline in background (draft conversion creates event)
      this.github
        .getPRTimeline(owner, repo, pr.number)
        .then((timeline) => this.set({ timeline }))
        .catch(() => {});

      return true;
    } catch (e) {
      console.error("Failed to convert to draft:", e);
      this.set({ convertingToDraft: false });
      return false;
    }
  };

  /**
   * Mark PR ready for review
   */
  markReadyForReview = async (): Promise<boolean> => {
    const { owner, repo, pr } = this.state;

    this.set({ markingReady: true });

    try {
      // 1. Request GitHub to mark ready
      await this.github.markReadyForReview(owner, repo, pr.number);

      // 2. Invalidate all PR-related caches FIRST
      this.invalidatePRCaches(owner, repo, pr.number);

      // 3. Update with LATEST state
      this.set({
        pr: { ...this.state.pr, draft: false },
        markingReady: false,
      });

      // 4. Refetch timeline in background (ready for review creates event)
      this.github
        .getPRTimeline(owner, repo, pr.number)
        .then((timeline) => this.set({ timeline }))
        .catch(() => {});

      return true;
    } catch (e) {
      console.error("Failed to mark ready:", e);
      this.set({ markingReady: false });
      return false;
    }
  };

  /**
   * Approve workflow runs awaiting approval
   */
  approveWorkflows = async (): Promise<boolean> => {
    const { owner, repo, workflowRunsAwaitingApproval } = this.state;

    if (workflowRunsAwaitingApproval.length === 0) return true;

    this.set({ approvingWorkflows: true });

    try {
      // Track which workflows we're approving
      const approvedIds = workflowRunsAwaitingApproval.map((run) => run.id);
      for (const id of approvedIds) {
        this.recentlyApprovedWorkflowIds.add(id);
      }

      // Optimistically clear the UI
      this.set({ workflowRunsAwaitingApproval: [] });

      // Approve all workflow runs
      await Promise.all(
        approvedIds.map((id) => this.github.approveWorkflowRun(owner, repo, id))
      );

      // Refresh checks to get updated status
      await this.refreshChecks();

      this.set({ approvingWorkflows: false });
      return true;
    } catch (e) {
      console.error("Failed to approve workflows:", e);
      // On error, clear tracking and refresh to restore actual state
      this.recentlyApprovedWorkflowIds.clear();
      await this.refreshChecks();
      this.set({ approvingWorkflows: false });
      return false;
    }
  };

  /**
   * Update the branch (merge base into head)
   */
  updateBranch = async (): Promise<boolean> => {
    const { owner, repo, pr } = this.state;

    try {
      await this.github.updateBranch(owner, repo, pr.number);

      // Invalidate cache BEFORE refetch so we get fresh data
      this.github.invalidateCache(`pr:${owner}/${repo}/${pr.number}`);

      // Refetch PR to get updated state (branch update changes many fields)
      const updatedPR = await this.github.getPR(owner, repo, pr.number);
      this.set({ pr: updatedPR });

      return true;
    } catch (e) {
      console.error("Failed to update branch:", e);
      return false;
    }
  };

  // ---------------------------------------------------------------------------
  // State Setters (for component updates)
  // ---------------------------------------------------------------------------

  setConversation = (conversation: IssueComment[]) => {
    this.set({ conversation });
  };

  addConversationComment = (comment: IssueComment) => {
    this.set({ conversation: [...this.state.conversation, comment] });
  };

  setReviewThreads = (threads: ReviewThread[]) => {
    this.set({ reviewThreads: threads });
  };

  updateReviewThread = (
    threadId: string,
    updater: (thread: ReviewThread) => ReviewThread
  ) => {
    this.set({
      reviewThreads: this.state.reviewThreads.map((t) =>
        t.id === threadId ? updater(t) : t
      ),
    });
  };
}

// ============================================================================
// Context
// ============================================================================

const PRReviewContext = createContext<PRReviewStore | null>(null);

// ============================================================================
// Provider
// ============================================================================

interface PRReviewProviderProps {
  github: GitHubStore;
  pr: PullRequest;
  files: PullRequestFile[];
  comments: ReviewComment[];
  owner: string;
  repo: string;
  viewerPermission: string | null;
  children: ReactNode;
}

export function PRReviewProvider({
  github,
  pr,
  files,
  comments,
  owner,
  repo,
  viewerPermission,
  children,
}: PRReviewProviderProps) {
  // Create store once and keep it stable
  const storeRef = useRef<PRReviewStore | null>(null);
  if (!storeRef.current) {
    storeRef.current = new PRReviewStore(github, {
      pr,
      files,
      comments,
      owner,
      repo,
      viewerPermission,
    });
  }

  // Load PR data after store creation
  useEffect(() => {
    storeRef.current?.loadPRData();
  }, []);

  // Sync comments from props (for when they're refreshed from server)
  useEffect(() => {
    storeRef.current?.setComments(comments);
  }, [comments]);

  // Sync viewerPermission from props
  useEffect(() => {
    storeRef.current?.setViewerPermission(viewerPermission);
  }, [viewerPermission]);

  // Extract relevant users for @mention suggestions
  // Priority: PR participants (author, reviewers, assignees, commenters)
  const suggestedUsers = useMemo(() => {
    const seen = new Set<string>();
    const users: MentionUser[] = [];

    const addUser = (
      login: string | undefined,
      avatar_url: string | undefined
    ) => {
      if (!login || seen.has(login.toLowerCase())) return;
      seen.add(login.toLowerCase());
      users.push({
        login,
        avatar_url: avatar_url || `https://github.com/${login}.png`,
      });
    };

    // PR author first
    if (pr.user) {
      addUser(pr.user.login, pr.user.avatar_url);
    }

    // Assignees
    for (const assignee of pr.assignees || []) {
      addUser(assignee.login, assignee.avatar_url);
    }

    // Requested reviewers (can be users or teams)
    for (const reviewer of pr.requested_reviewers || []) {
      if ("login" in reviewer) {
        addUser(reviewer.login, reviewer.avatar_url);
      }
    }

    // Commenters (from review comments)
    for (const comment of comments) {
      if (comment.user) {
        addUser(comment.user.login, comment.user.avatar_url);
      }
    }

    return users;
  }, [pr, comments]);

  return (
    <PRReviewContext.Provider value={storeRef.current}>
      <MentionSuggestionsProvider
        suggestedUsers={suggestedUsers}
        owner={owner}
        repo={repo}
      >
        {children}
      </MentionSuggestionsProvider>
    </PRReviewContext.Provider>
  );
}

// ============================================================================
// Base Hooks
// ============================================================================

function useStore(): PRReviewStore {
  const store = useContext(PRReviewContext);
  if (!store) {
    throw new Error("useStore must be used within PRReviewProvider");
  }
  return store;
}

/**
 * Subscribe to a slice of state. Component only re-renders when the selected
 * value changes (using Object.is comparison).
 */
export function usePRReviewSelector<T>(selector: Selector<T>): T {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getSnapshot()),
    () => selector(store.getSnapshot())
  );
}

/**
 * Get the store directly for accessing actions or reading state imperatively.
 * The store reference is stable and never changes.
 */
export function usePRReviewStore(): PRReviewStore {
  return useStore();
}

// ============================================================================
// Utility
// ============================================================================

export function getTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return date.toLocaleDateString();
}

export { useCommentsByFile } from "./useCommentsByFile";
export { usePendingCommentCountsByFile } from "./usePendingCommentCountsByFile";
export { useCommentCountsByFile } from "./useCommentCountsByFile";
export { useCurrentFile } from "./useCurrentFile";
export { useCurrentDiff } from "./useCurrentDiff";
export { useIsCurrentFileLoading } from "./useIsCurrentFileLoading";
export { useCurrentFileComments } from "./useCurrentFileComments";
export { useCurrentFilePendingComments } from "./useCurrentFilePendingComments";
export { useSelectionRange } from "./useSelectionRange";
export { useIsLineFocused } from "./useIsLineFocused";
export { useIsLineInSelection } from "./useIsLineInSelection";
export { useSelectionBoundary } from "./useSelectionBoundary";
export { useIsLineCommenting } from "./useIsLineCommenting";
export { useIsLineInCommentingRange } from "./useIsLineInCommentingRange";
export { useIsLineInCommentRange } from "./useIsLineInCommentRange";
export { useSelectionState, type SelectionState } from "./useSelectionState";
export { useCommentingRange } from "./useCommentingRange";
export { useCommentRangeLookup } from "./useCommentRangeLookup";
export { useKeyboardNavigation } from "./useKeyboardNavigation";
export { useHashNavigation } from "./useHashNavigation";
export { useDiffLoader } from "./useDiffLoader";
export { useCurrentUserLoader } from "./useCurrentUserLoader";
export { usePendingReviewLoader } from "./usePendingReviewLoader";
export { useThreadActions } from "./useThreadActions";
export { useCommentActions } from "./useCommentActions";
export { useReviewActions } from "./useReviewActions";
export {
  useSkipBlockExpansion,
  SKIP_EXPAND_STEP,
  type ExpandDirection,
} from "./useSkipBlockExpansion";
export { useFileCopyActions } from "./useFileCopyActions";
