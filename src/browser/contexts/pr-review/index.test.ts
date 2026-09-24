import { test, expect, beforeEach } from "bun:test";
import type { PullRequest, PullRequestFile, ReviewComment } from "@/api/types";
import {
  PRReviewStore,
  commentThreadKey,
  isThreadCollapsed,
  sortFilesLikeTree,
  visibleComments,
  type ParsedDiff,
} from "./index";
import type { GitHubStore } from "@/browser/contexts/github";
import {
  SEMANTIC_REVIEW_VERSION,
  type SemanticReview,
} from "@/semantic/schema";

// Mock localStorage
const storage = new Map<string, string>();
globalThis.localStorage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear(),
  key: () => null,
  length: 0,
};

// Mock GitHub store (minimal implementation for tests)
function createMockGitHubStore(): GitHubStore {
  return {
    getPRReviews: async () => [],
    getPRChecks: async () => ({
      checkRuns: [],
      status: { state: "", statuses: [] },
    }),
    getWorkflowRuns: async () => ({ workflow_runs: [] }),
    getPRConversation: async () => [],
    getPRCommits: async () => [],
    getPRTimeline: async () => [],
    getReviewThreads: async () => ({
      threads: [],
      viewerPermission: null,
      viewerCanMergeAsAdmin: false,
    }),
    invalidateCache: () => {},
    getPR: async () => createMockPR(),
    mergePR: async () => ({ merged: true }),
    closePR: async () => {},
    reopenPR: async () => {},
    deleteBranch: async () => {},
    restoreBranch: async () => {},
    convertToDraft: async () => {},
    markReadyForReview: async () => {},
    approveWorkflowRun: async () => {},
    updateBranch: async () => {},
  } as unknown as GitHubStore;
}

// ============================================================================
// Test Fixtures
// ============================================================================

function createMockPR(overrides?: Partial<PullRequest>): PullRequest {
  return {
    number: 1,
    title: "Test PR",
    state: "open",
    html_url: "https://github.com/test/repo/pull/1",
    user: { login: "testuser", avatar_url: "https://example.com/avatar.png" },
    body: "Test body",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    head: { ref: "feature", sha: "abc123" },
    base: { ref: "main", sha: "def456" },
    merged: false,
    draft: false,
    ...overrides,
  } as PullRequest;
}

function createMockFile(filename: string): PullRequestFile {
  return {
    sha: "abc123",
    filename,
    status: "modified",
    additions: 10,
    deletions: 5,
    changes: 15,
    patch: "@@ -1,3 +1,4 @@\n line1\n+added\n line2",
  } as PullRequestFile;
}

function createMockComment(
  id: number,
  path: string,
  line: number
): ReviewComment {
  return {
    id,
    node_id: `comment_${id}`,
    path,
    line,
    body: `Comment ${id}`,
    user: { login: "reviewer", avatar_url: "https://example.com/avatar.png" },
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as ReviewComment;
}

function createStore(overrides?: {
  files?: PullRequestFile[];
  comments?: ReviewComment[];
}) {
  return new PRReviewStore(createMockGitHubStore(), {
    pr: createMockPR(),
    files: overrides?.files ?? [
      createMockFile("src/index.ts"),
      createMockFile("src/utils.ts"),
      createMockFile("README.md"),
    ],
    comments: overrides?.comments ?? [],
    owner: "test",
    repo: "repo",
    viewerPermission: "WRITE",
  });
}

beforeEach(() => {
  storage.clear();
});

// ============================================================================
// sortFilesLikeTree
// ============================================================================

test("sortFilesLikeTree places folders before files", () => {
  const files = [
    createMockFile("README.md"),
    createMockFile("src/index.ts"),
    createMockFile("package.json"),
  ];

  const sorted = sortFilesLikeTree(files);

  // Folders (src/) come before root-level files, then alphabetically
  expect(sorted.map((f) => f.filename)).toEqual([
    "src/index.ts",
    "package.json",
    "README.md",
  ]);
});

test("sortFilesLikeTree sorts nested folders correctly", () => {
  const files = [
    createMockFile("src/components/Button.tsx"),
    createMockFile("src/index.ts"),
    createMockFile("src/components/Dialog.tsx"),
    createMockFile("src/utils/helpers.ts"),
  ];

  const sorted = sortFilesLikeTree(files);

  // Folders first at each level, then alphabetically
  expect(sorted.map((f) => f.filename)).toEqual([
    "src/components/Button.tsx",
    "src/components/Dialog.tsx",
    "src/utils/helpers.ts",
    "src/index.ts",
  ]);
});

// ============================================================================
// File Navigation
// ============================================================================

test("selectFile updates selectedFile and clears showOverview", () => {
  const store = createStore();
  const state = () => store.getSnapshot();

  expect(state().selectedFile).toBeNull();
  expect(state().showOverview).toBe(true);

  store.selectFile("src/index.ts");

  expect(state().selectedFile).toBe("src/index.ts");
  expect(state().showOverview).toBe(false);
});

test("selectFile clears line selection state", () => {
  const store = createStore();
  store.selectFile("src/index.ts");
  store.setFocusedLine(10, "new");
  store.setSelectionAnchor(5, "new");

  store.selectFile("src/utils.ts");

  const state = store.getSnapshot();
  expect(state.focusedLine).toBeNull();
  expect(state.selectionAnchor).toBeNull();
});

test("selectOverview resets to overview state", () => {
  const store = createStore();
  store.selectFile("src/index.ts");
  store.setFocusedLine(10, "new");

  store.selectOverview();

  const state = store.getSnapshot();
  expect(state.showOverview).toBe(true);
  expect(state.selectedFile).toBeNull();
  expect(state.focusedLine).toBeNull();
});

test("navigateToFile moves between files", () => {
  const store = createStore({
    files: [
      createMockFile("a.ts"),
      createMockFile("b.ts"),
      createMockFile("c.ts"),
    ],
  });

  store.selectFile("b.ts");
  store.navigateToFile("next");
  expect(store.getSnapshot().selectedFile).toBe("c.ts");

  store.navigateToFile("prev");
  expect(store.getSnapshot().selectedFile).toBe("b.ts");

  store.navigateToFile("prev");
  expect(store.getSnapshot().selectedFile).toBe("a.ts");

  // Should not go below first file
  store.navigateToFile("prev");
  expect(store.getSnapshot().selectedFile).toBe("a.ts");
});

// ============================================================================
// Viewed Files
// ============================================================================

test("toggleViewed marks file as viewed", () => {
  const store = createStore();

  expect(store.getSnapshot().viewedFiles.has("src/index.ts")).toBe(false);

  store.toggleViewed("src/index.ts");

  expect(store.getSnapshot().viewedFiles.has("src/index.ts")).toBe(true);
});

test("toggleViewed persists to localStorage", () => {
  const store = createStore();
  store.toggleViewed("src/index.ts");

  const stored = storage.get("pr-test-repo-1-viewed");
  expect(stored).toBeDefined();
  expect(JSON.parse(stored!)).toContain("src/index.ts");
});

test("toggleViewed unmarks viewed file", () => {
  const store = createStore();
  store.toggleViewed("src/index.ts");
  store.toggleViewed("src/index.ts");

  expect(store.getSnapshot().viewedFiles.has("src/index.ts")).toBe(false);
});

test("toggleViewed navigates to next file when marking current file as viewed", () => {
  const store = createStore();
  store.selectFile("src/index.ts");

  store.toggleViewed("src/index.ts");

  expect(store.getSnapshot().viewedFiles.has("src/index.ts")).toBe(true);
  expect(store.getSnapshot().selectedFile).toBe("src/utils.ts");
});

test("toggleViewedMultiple marks multiple files", () => {
  const store = createStore();

  store.toggleViewedMultiple(["src/index.ts", "src/utils.ts"]);

  const { viewedFiles } = store.getSnapshot();
  expect(viewedFiles.has("src/index.ts")).toBe(true);
  expect(viewedFiles.has("src/utils.ts")).toBe(true);
});

// ============================================================================
// Line Selection
// ============================================================================

test("setFocusedLine updates line focus", () => {
  const store = createStore();
  store.selectFile("src/index.ts");

  store.setFocusedLine(42, "new");

  const state = store.getSnapshot();
  expect(state.focusedLine).toBe(42);
  expect(state.focusedLineSide).toBe("new");
});

test("setFocusedLine clears skip block focus", () => {
  const store = createStore();
  store.selectFile("src/index.ts");
  store.setFocusedSkipBlock(0);

  store.setFocusedLine(10, "new");

  expect(store.getSnapshot().focusedSkipBlockIndex).toBeNull();
});

test("setSelectionAnchor creates range selection", () => {
  const store = createStore();
  store.selectFile("src/index.ts");
  store.setFocusedLine(10, "new");
  store.setSelectionAnchor(5, "new");

  const state = store.getSnapshot();
  expect(state.focusedLine).toBe(10);
  expect(state.selectionAnchor).toBe(5);
});

test("clearLineSelection resets all line state", () => {
  const store = createStore();
  store.selectFile("src/index.ts");
  store.setFocusedLine(10, "new");
  store.setSelectionAnchor(5, "new");
  store.startCommenting(10, 5);

  store.clearLineSelection();

  const state = store.getSnapshot();
  expect(state.focusedLine).toBeNull();
  expect(state.selectionAnchor).toBeNull();
  expect(state.commentingOnLine).toBeNull();
});

// ============================================================================
// Commenting
// ============================================================================

test("startCommenting sets commenting state", () => {
  const store = createStore();
  store.selectFile("src/index.ts");

  store.startCommenting(42, 38);

  const state = store.getSnapshot();
  expect(state.commentingOnLine).toEqual({
    line: 42,
    startLine: 38,
    side: "RIGHT",
  });
});

test("startCommenting records LEFT side for old-side lines", () => {
  const store = createStore();
  store.selectFile("src/index.ts");

  store.startCommenting(7, undefined, "old");

  expect(store.getSnapshot().commentingOnLine).toEqual({
    line: 7,
    startLine: undefined,
    side: "LEFT",
  });
});

test("startCommentingOnFocusedLine derives side from focused line", () => {
  const store = createStore();
  store.selectFile("src/index.ts");
  store.setFocusedLine(7, "old");

  store.startCommentingOnFocusedLine();

  expect(store.getSnapshot().commentingOnLine).toEqual({
    line: 7,
    startLine: undefined,
    side: "LEFT",
  });
});

function diffWithOneHunk(): ParsedDiff {
  return {
    hunks: [
      { type: "skip", count: 9, content: "" },
      {
        type: "hunk",
        oldStart: 10,
        newStart: 10,
        lines: [
          { type: "normal", oldLineNumber: 10, newLineNumber: 10, content: [] },
          { type: "delete", oldLineNumber: 11, content: [] },
          { type: "insert", newLineNumber: 11, content: [] },
          { type: "normal", oldLineNumber: 12, newLineNumber: 12, content: [] },
        ],
      },
    ],
  };
}

test("isLineInDiff only accepts hunk lines on the matching side", () => {
  const store = createStore();
  store.selectFile("src/index.ts");
  store.setLoadedDiff("src/index.ts", diffWithOneHunk());

  expect(store.isLineInDiff("src/index.ts", 10, "RIGHT")).toBe(true);
  expect(store.isLineInDiff("src/index.ts", 11, "RIGHT")).toBe(true);
  expect(store.isLineInDiff("src/index.ts", 11, "LEFT")).toBe(true);
  // Line 5 is only reachable by expanding the gap
  expect(store.isLineInDiff("src/index.ts", 5, "RIGHT")).toBe(false);
  expect(store.isLineInDiff("src/index.ts", 5, "LEFT")).toBe(false);
  // Unloaded diffs are not validated
  expect(store.isLineInDiff("src/utils.ts", 5, "RIGHT")).toBe(true);
});

test("startCommenting ignores lines outside the diff hunks", () => {
  const store = createStore();
  store.selectFile("src/index.ts");
  store.setLoadedDiff("src/index.ts", diffWithOneHunk());

  store.startCommenting(5);
  expect(store.getSnapshot().commentingOnLine).toBeNull();

  store.startCommenting(12, 5);
  expect(store.getSnapshot().commentingOnLine).toBeNull();

  store.startCommenting(12, 10);
  expect(store.getSnapshot().commentingOnLine).toEqual({
    line: 12,
    startLine: 10,
    side: "RIGHT",
  });
});

test("cancelCommenting clears commenting state", () => {
  const store = createStore();
  store.selectFile("src/index.ts");
  store.startCommenting(42);

  store.cancelCommenting();

  expect(store.getSnapshot().commentingOnLine).toBeNull();
});

test("comment drafts persist until cleared or emptied", () => {
  const store = createStore();

  store.setDraft("new:src/index.ts:RIGHT:42-42", "half-written");
  expect(store.getDraft("new:src/index.ts:RIGHT:42-42")).toBe("half-written");
  expect(store.getDraft("reply:1")).toBeUndefined();

  store.setDraft("new:src/index.ts:RIGHT:42-42", "");
  expect(store.getDraft("new:src/index.ts:RIGHT:42-42")).toBeUndefined();

  store.setDraft("reply:1", "thanks");
  store.clearDraft("reply:1");
  expect(store.getDraft("reply:1")).toBeUndefined();
});

test("addPendingComment adds comment and clears selection", () => {
  const store = createStore();
  store.selectFile("src/index.ts");
  store.setFocusedLine(10, "new");
  store.startCommenting(10);

  store.addPendingComment({
    id: "local-1",
    path: "src/index.ts",
    line: 10,
    body: "Test comment",
    side: "RIGHT",
  });

  const state = store.getSnapshot();
  expect(state.pendingComments).toHaveLength(1);
  expect(state.pendingComments[0].body).toBe("Test comment");
  expect(state.commentingOnLine).toBeNull();
  expect(state.focusedPendingCommentId).toBe("local-1");
});

test("removePendingComment removes comment and focuses line", () => {
  const store = createStore();
  store.selectFile("src/index.ts");

  store.addPendingComment({
    id: "local-1",
    path: "src/index.ts",
    line: 10,
    body: "Test comment",
    side: "RIGHT",
  });

  store.removePendingComment("local-1");

  const state = store.getSnapshot();
  expect(state.pendingComments).toHaveLength(0);
  expect(state.focusedLine).toBe(10);
});

// ============================================================================
// Comments
// ============================================================================

test("setComments updates comments", () => {
  const store = createStore();
  const comments = [createMockComment(1, "src/index.ts", 10)];

  store.setComments(comments);

  expect(store.getSnapshot().comments).toHaveLength(1);
  expect(store.getSnapshot().comments[0].id).toBe(1);
});

test("setFocusedCommentId updates focus", () => {
  const store = createStore({
    comments: [createMockComment(1, "src/index.ts", 10)],
  });

  store.setFocusedCommentId(1);

  expect(store.getSnapshot().focusedCommentId).toBe(1);
});

test("startEditing sets editing comment id", () => {
  const store = createStore({
    comments: [createMockComment(1, "src/index.ts", 10)],
  });

  store.startEditing(1);

  expect(store.getSnapshot().editingCommentId).toBe(1);
});

test("deleteComment removes comment and focuses line", () => {
  const store = createStore({
    comments: [createMockComment(1, "src/index.ts", 10)],
  });
  store.selectFile("src/index.ts");
  store.setFocusedCommentId(1);

  store.deleteComment(1);

  const state = store.getSnapshot();
  expect(state.comments).toHaveLength(0);
  expect(state.focusedLine).toBe(10);
});

// ============================================================================
// Review Panel
// ============================================================================

test("openReviewPanel shows panel", () => {
  const store = createStore();

  store.openReviewPanel();

  expect(store.getSnapshot().showReviewPanel).toBe(true);
});

test("setReviewBody updates body and persists", () => {
  const store = createStore();

  store.setReviewBody("LGTM!");

  expect(store.getSnapshot().reviewBody).toBe("LGTM!");
  expect(storage.get("pr-test-repo-1-body")).toBe("LGTM!");
});

test("clearReviewState resets all review state", () => {
  const store = createStore();
  store.setReviewBody("Test");
  store.openReviewPanel();
  store.addPendingComment({
    id: "local-1",
    path: "src/index.ts",
    line: 10,
    body: "Comment",
    side: "RIGHT",
  });

  store.clearReviewState();

  const state = store.getSnapshot();
  expect(state.pendingComments).toHaveLength(0);
  expect(state.reviewBody).toBe("");
  expect(state.showReviewPanel).toBe(false);
});

// ============================================================================
// Subscriptions
// ============================================================================

test("subscribe notifies listeners on state change", () => {
  const store = createStore();
  let callCount = 0;

  const unsubscribe = store.subscribe(() => {
    callCount++;
  });

  store.selectFile("src/index.ts");
  expect(callCount).toBe(1);

  store.setFocusedLine(10, "new");
  expect(callCount).toBe(2);

  unsubscribe();
  store.setFocusedLine(20, "new");
  expect(callCount).toBe(2); // No more calls after unsubscribe
});

// ============================================================================
// Diff View Mode
// ============================================================================

test("setDiffViewMode updates mode and persists globally", () => {
  const store = createStore();

  store.setDiffViewMode("split");

  expect(store.getSnapshot().diffViewMode).toBe("split");
  expect(storage.get("pulldash_diff_view_mode")).toBe("split");
});

test("toggleDiffViewMode toggles between unified and split", () => {
  const store = createStore();
  expect(store.getSnapshot().diffViewMode).toBe("unified");

  store.toggleDiffViewMode();
  expect(store.getSnapshot().diffViewMode).toBe("split");

  store.toggleDiffViewMode();
  expect(store.getSnapshot().diffViewMode).toBe("unified");
});

// ============================================================================
// Goto Line Mode
// ============================================================================

test("enterGotoMode enables goto mode", () => {
  const store = createStore();

  store.enterGotoMode();

  const state = store.getSnapshot();
  expect(state.gotoLineMode).toBe(true);
  expect(state.gotoLineInput).toBe("");
});

test("appendGotoInput builds input string", () => {
  const store = createStore();
  store.enterGotoMode();

  store.appendGotoInput("4");
  store.appendGotoInput("2");

  expect(store.getSnapshot().gotoLineInput).toBe("42");
});

test("backspaceGotoInput removes last character", () => {
  const store = createStore();
  store.enterGotoMode();
  store.appendGotoInput("4");
  store.appendGotoInput("2");

  store.backspaceGotoInput();

  expect(store.getSnapshot().gotoLineInput).toBe("4");
});

test("exitGotoMode clears goto state", () => {
  const store = createStore();
  store.enterGotoMode();
  store.appendGotoInput("42");

  store.exitGotoMode();

  const state = store.getSnapshot();
  expect(state.gotoLineMode).toBe(false);
  expect(state.gotoLineInput).toBe("");
});

// ============================================================================
// Hash Navigation
// ============================================================================

test("getHashFromState returns file hash", () => {
  const store = createStore();
  store.selectFile("src/index.ts");

  const hash = store.getHashFromState();

  expect(hash).toBe("file=src%2Findex.ts");
});

test("getHashFromState includes line selection", () => {
  const store = createStore();
  store.selectFile("src/index.ts");
  store.setFocusedLine(42, "new");

  const hash = store.getHashFromState();

  expect(hash).toContain("file=src%2Findex.ts");
  expect(hash).toContain("L=42");
});

test("getHashFromState includes line range", () => {
  const store = createStore();
  store.selectFile("src/index.ts");
  store.setFocusedLine(10, "new");
  store.setSelectionAnchor(5, "new");

  const hash = store.getHashFromState();

  expect(hash).toContain("L=5-10");
});

test("navigateFromHash selects file", () => {
  const store = createStore();

  const result = store.navigateFromHash("file=src%2Findex.ts");

  expect(result).toBe(true);
  expect(store.getSnapshot().selectedFile).toBe("src/index.ts");
});

test("navigateFromHash focuses line", () => {
  const store = createStore();

  store.navigateFromHash("file=src%2Findex.ts&L=42");

  const state = store.getSnapshot();
  expect(state.selectedFile).toBe("src/index.ts");
  expect(state.focusedLine).toBe(42);
});

test("navigateFromHash returns false for invalid file", () => {
  const store = createStore();

  const result = store.navigateFromHash("file=nonexistent.ts");

  expect(result).toBe(false);
});

test("navigateFromHash handles GitHub-style pullrequestreview hash", () => {
  const store = createStore();
  store.selectFile("src/index.ts"); // Start on a file view

  const result = store.navigateFromHash("#pullrequestreview-12345");

  expect(result).toBe(true);
  const state = store.getSnapshot();
  expect(state.showOverview).toBe(true);
  expect(state.overviewScrollTarget).toBe("pullrequestreview-12345");
});

test("navigateFromHash handles GitHub-style issuecomment hash", () => {
  const store = createStore();
  store.selectFile("src/index.ts");

  const result = store.navigateFromHash("#issuecomment-98765");

  expect(result).toBe(true);
  const state = store.getSnapshot();
  expect(state.showOverview).toBe(true);
  expect(state.overviewScrollTarget).toBe("issuecomment-98765");
});

test("navigateFromHash with empty hash navigates to overview", () => {
  const store = createStore();
  store.selectFile("src/index.ts");
  expect(store.getSnapshot().showOverview).toBe(false);

  const result = store.navigateFromHash("");

  expect(result).toBe(true);
  expect(store.getSnapshot().showOverview).toBe(true);
});

test("getHashFromState returns overview scroll target when on overview", () => {
  const store = createStore();
  store.selectOverview("pullrequestreview-12345");

  const hash = store.getHashFromState();

  expect(hash).toBe("pullrequestreview-12345");
});

test("clearOverviewScrollTarget clears the target", () => {
  const store = createStore();
  store.selectOverview("pullrequestreview-12345");

  store.clearOverviewScrollTarget();

  expect(store.getSnapshot().overviewScrollTarget).toBeNull();
});

// ============================================================================
// Semantic review layer <-> file sync
// ============================================================================

function createSemanticStore() {
  const store = createStore();
  const review: SemanticReview = {
    version: SEMANTIC_REVIEW_VERSION,
    provider: "test",
    headSha: "abc123",
    generatedAt: new Date().toISOString(),
    overview: "overview",
    cohorts: [
      {
        id: "c1",
        title: "Cohort 1",
        summary: "s",
        layers: [
          {
            id: "l1",
            title: "Layer 1",
            summary: "s",
            ranges: [
              { file: "src/index.ts", side: "new", startLine: 1, endLine: 2 },
            ],
          },
          {
            id: "l2",
            title: "Layer 2",
            summary: "s",
            ranges: [
              { file: "src/utils.ts", side: "new", startLine: 3, endLine: 4 },
              { file: "src/index.ts", side: "new", startLine: 9, endLine: 9 },
            ],
          },
        ],
      },
    ],
  };
  (store as unknown as { set: (p: Record<string, unknown>) => void }).set({
    semanticReview: review,
  });
  store.setViewMode("semantic");
  return store;
}

test("setViewMode semantic selects the first layer and its file", () => {
  const store = createSemanticStore();

  expect(store.getSnapshot().selectedLayerId).toBe("c1/l1");
  expect(store.getSnapshot().selectedFile).toBe("src/index.ts");
});

test("selectFile in semantic mode syncs selectedLayerId to a covering layer", () => {
  const store = createSemanticStore();

  store.selectFile("src/utils.ts");

  expect(store.getSnapshot().selectedLayerId).toBe("c1/l2");
});

test("file navigation in semantic mode syncs the selected layer", () => {
  const store = createSemanticStore();

  store.navigateToFile("next");

  expect(store.getSnapshot().selectedFile).toBe("src/utils.ts");
  expect(store.getSnapshot().selectedLayerId).toBe("c1/l2");
});

test("jumpToSemanticRange with a layer key selects that layer, not the first covering one", () => {
  const store = createSemanticStore();

  // src/index.ts is covered by l1 and l2; jumping from l2's row must keep l2.
  store.jumpToSemanticRange(
    { file: "src/index.ts", side: "new", startLine: 9, endLine: 9 },
    "c1/l2"
  );

  const state = store.getSnapshot();
  expect(state.selectedLayerId).toBe("c1/l2");
  expect(state.selectedFile).toBe("src/index.ts");
  expect(state.focusedLine).toBe(9);
});

test("selecting a layer keeps that layer even when other layers cover the file", () => {
  const store = createSemanticStore();

  store.selectSemanticLayer("c1/l2");

  // l2's first range is src/utils.ts; selecting it must not bounce to l1.
  expect(store.getSnapshot().selectedLayerId).toBe("c1/l2");
  expect(store.getSnapshot().selectedFile).toBe("src/utils.ts");

  // src/index.ts is covered by both l1 and l2; l2 is already selected and
  // covers it, so the intentional layer selection is preserved.
  store.selectFile("src/index.ts");
  expect(store.getSnapshot().selectedLayerId).toBe("c1/l2");
});

test("selectFile leaves the layer alone for files no layer covers", () => {
  const store = createSemanticStore();

  store.selectFile("README.md");

  expect(store.getSnapshot().selectedFile).toBe("README.md");
  expect(store.getSnapshot().selectedLayerId).toBe("c1/l1");
});

// ============================================================================
// Comment Collapse
// ============================================================================

test("commentThreadKey prefers the review thread id over the root comment id", () => {
  const rooted = createMockComment(1, "src/index.ts", 10);
  expect(commentThreadKey([rooted])).toBe("c1");

  const threaded = {
    ...rooted,
    pull_request_review_thread_id: "PRRT_abc",
  } as ReviewComment;
  expect(
    commentThreadKey([threaded, createMockComment(2, "src/index.ts", 10)])
  ).toBe("PRRT_abc");
});

test("toggleAllCommentsCollapsed flips the global default and persists it", () => {
  const store = createStore();

  expect(store.getSnapshot().allCommentsCollapsed).toBe(false);

  store.toggleAllCommentsCollapsed();

  expect(store.getSnapshot().allCommentsCollapsed).toBe(true);
  expect(storage.get("pulldash_collapse_all_comments")).toBe("true");

  // A fresh store picks up the persisted preference.
  expect(createStore().getSnapshot().allCommentsCollapsed).toBe(true);
});

test("toggleHideResolvedComments flips the flag and persists it", () => {
  const store = createStore();

  expect(store.getSnapshot().hideResolvedComments).toBe(false);

  store.toggleHideResolvedComments();

  expect(store.getSnapshot().hideResolvedComments).toBe(true);
  expect(storage.get("pulldash_hide_resolved_comments")).toBe("true");
  expect(createStore().getSnapshot().hideResolvedComments).toBe(true);

  store.toggleHideResolvedComments();
  expect(store.getSnapshot().hideResolvedComments).toBe(false);
});

test("hiding resolved comments drops focus from a resolved comment", () => {
  const store = createStore();
  const resolved = {
    ...createMockComment(1, "src/index.ts", 10),
    is_resolved: true,
  } as ReviewComment;
  const open = createMockComment(2, "src/index.ts", 12);
  store.setComments([resolved, open]);

  store.setFocusedCommentId(1);
  store.setHideResolvedComments(true);
  expect(store.getSnapshot().focusedCommentId).toBeNull();

  store.setFocusedCommentId(2);
  store.setHideResolvedComments(true);
  expect(store.getSnapshot().focusedCommentId).toBe(2);
});

test("visibleComments filters resolved threads only when hiding", () => {
  const resolved = {
    ...createMockComment(1, "a.ts", 1),
    is_resolved: true,
  } as ReviewComment;
  const open = createMockComment(2, "a.ts", 2);
  const all = [resolved, open];

  expect(visibleComments(all, false)).toBe(all);
  expect(visibleComments(all, true)).toEqual([open]);
  // Nothing filtered: same array back so memoized consumers stay stable.
  expect(visibleComments([open], true)).toEqual([open]);
});

test("toggleThreadCollapsed overrides the global default per thread", () => {
  const store = createStore();

  store.toggleThreadCollapsed("t1");
  expect(store.isThreadCollapsed("t1")).toBe(true);
  expect(store.isThreadCollapsed("t2")).toBe(false);

  store.toggleThreadCollapsed("t1");
  expect(store.isThreadCollapsed("t1")).toBe(false);
  // Returning to the default drops the override entirely.
  expect(store.getSnapshot().collapsedThreadOverrides.size).toBe(0);
});

test("resolved threads collapse by default but stay expandable", () => {
  const store = createStore();

  expect(store.isThreadCollapsed("t1", true)).toBe(true);

  store.toggleThreadCollapsed("t1", true);

  expect(store.isThreadCollapsed("t1", true)).toBe(false);
  expect(store.getSnapshot().collapsedThreadOverrides.get("t1")).toBe(false);
});

test("collapse-all clears per-thread overrides", () => {
  const store = createStore();

  store.toggleThreadCollapsed("t1");
  expect(store.getSnapshot().collapsedThreadOverrides.size).toBe(1);

  store.setAllCommentsCollapsed(true);

  expect(store.getSnapshot().collapsedThreadOverrides.size).toBe(0);
  expect(store.isThreadCollapsed("t1")).toBe(true);
  expect(store.isThreadCollapsed("t2")).toBe(true);

  // Expanding a single thread while the global default is collapsed works.
  store.toggleThreadCollapsed("t2");
  expect(store.isThreadCollapsed("t2")).toBe(false);
  expect(store.isThreadCollapsed("t1")).toBe(true);
});

test("isThreadCollapsed reads state without the store instance", () => {
  const store = createStore();
  store.setAllCommentsCollapsed(true);
  store.toggleThreadCollapsed("t1");

  const state = store.getSnapshot();
  expect(isThreadCollapsed(state, "t1", false)).toBe(false);
  expect(isThreadCollapsed(state, "other", false)).toBe(true);
});

// ============================================================================
// Diff range ("changes since your last review")
// ============================================================================

function createRangeStore() {
  const commits = [
    { sha: "c1", commit: { message: "one" } },
    { sha: "c2", commit: { message: "two" } },
    { sha: "abc123", commit: { message: "head" } },
  ];
  const reviews = [
    {
      user: { login: "me" },
      state: "APPROVED",
      commit_id: "c1",
      submitted_at: "2026-01-01T00:00:00Z",
    },
  ];
  const github = {
    ...createMockGitHubStore(),
    getPRCommits: async () => commits,
    getPRReviews: async () => reviews,
  } as unknown as GitHubStore;
  const store = new PRReviewStore(github, {
    pr: createMockPR(),
    files: [
      createMockFile("src/index.ts"),
      createMockFile("src/utils.ts"),
      createMockFile("README.md"),
    ],
    comments: [],
    owner: "test",
    repo: "repo",
    viewerPermission: "WRITE",
  });
  store.setCurrentUser("me");
  return store;
}

test("setDiffRange narrows files, drops parsed diffs, and restores on clear", async () => {
  const store = createRangeStore();
  await store.loadPRData();
  store.selectFile("README.md");
  store.setLoadedDiff("README.md", { hunks: [] });

  expect(store.lastReviewedSha()).toBe("c1");

  const requested: string[] = [];
  await store.setDiffRange(
    { startSha: "c1", source: "review" },
    async (s, h) => {
      requested.push(`${s}...${h}`);
      return [createMockFile("src/utils.ts")];
    }
  );

  const state = store.getSnapshot();
  expect(requested).toEqual(["c1...abc123"]);
  expect(state.diffRange).toEqual({ startSha: "c1", source: "review" });
  expect(state.files.map((f) => f.filename)).toEqual(["src/utils.ts"]);
  expect(state.allFiles.length).toBe(3);
  // README dropped out of the range, so selection moves to the first in-range file
  expect(state.selectedFile).toBe("src/utils.ts");
  expect(state.loadedDiffs).toEqual({});

  await store.clearDiffRange();
  expect(store.getSnapshot().diffRange).toBeNull();
  expect(store.getSnapshot().files.length).toBe(3);
});

test("setDiffRange rejects a start commit that is gone or already head", async () => {
  const store = createRangeStore();
  await store.loadPRData();

  await store.setDiffRange({ startSha: "force-pushed-away", source: "manual" });
  expect(store.getSnapshot().diffRange).toBeNull();
  expect(store.getSnapshot().diffRangeError).toContain("force-pushed");

  await store.clearDiffRange();
  expect(store.getSnapshot().diffRangeError).toBeNull();

  await store.setDiffRange({ startSha: "abc123", source: "manual" });
  expect(store.getSnapshot().diffRange).toBeNull();
});

test("setDiffRange surfaces a failed compare fetch and blocks LEFT comments while active", async () => {
  const store = createRangeStore();
  await store.loadPRData();

  await store.setDiffRange(
    { startSha: "c2", source: "manual" },
    async () => null
  );
  expect(store.getSnapshot().diffRange).toBeNull();
  expect(store.getSnapshot().diffRangeError).toContain("Couldn't load");

  await store.setDiffRange({ startSha: "c2", source: "manual" }, async () => [
    createMockFile("src/index.ts"),
  ]);
  store.selectFile("src/index.ts");
  store.setLoadedDiff("src/index.ts", {
    hunks: [
      {
        type: "hunk",
        oldStart: 1,
        newStart: 1,
        lines: [
          {
            type: "delete",
            oldLineNumber: 1,
            content: [{ value: "x", html: "x", type: "normal" }],
          },
          {
            type: "insert",
            newLineNumber: 1,
            content: [{ value: "y", html: "y", type: "normal" }],
          },
        ],
      },
    ],
  });
  store.startCommenting(1, undefined, "old");
  expect(store.getSnapshot().commentingOnLine).toBeNull();
  store.startCommenting(1, undefined, "new");
  expect(store.getSnapshot().commentingOnLine?.side).toBe("RIGHT");
});
