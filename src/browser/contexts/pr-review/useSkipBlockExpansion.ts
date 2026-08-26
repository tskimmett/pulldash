import { useCallback } from "react";
import { useGitHub } from "@/browser/contexts/github";
import { diffService } from "@/browser/lib/diff";
import {
  usePRReviewStore,
  usePRReviewSelector,
  type ExpandedSkipBlock,
} from ".";

/** How many lines a single up/down expansion reveals (matches GitHub). */
export const SKIP_EXPAND_STEP = 20;

export type ExpandDirection = "up" | "down" | "all";

export function useSkipBlockExpansion() {
  const store = usePRReviewStore();
  const github = useGitHub();
  const owner = usePRReviewSelector((s) => s.owner);
  const repo = usePRReviewSelector((s) => s.repo);
  const pr = usePRReviewSelector((s) => s.pr);
  const selectedFile = usePRReviewSelector((s) => s.selectedFile);
  const expandedSkipBlocks = usePRReviewSelector((s) => s.expandedSkipBlocks);
  const expandingSkipBlocks = usePRReviewSelector((s) => s.expandingSkipBlocks);

  /**
   * Reveal part (or all) of a skip block's remaining gap, GitHub-style.
   * `startLine`/`count` describe the still-collapsed portion of the gap.
   * "down" extends the hunk above downward, "up" extends the hunk below
   * upward, "all" reveals the whole remaining gap.
   */
  const expandSkipBlock = useCallback(
    async (
      skipIndex: number,
      startLine: number,
      count: number,
      direction: ExpandDirection = "all"
    ) => {
      if (!selectedFile || count <= 0) return;

      const key = store.getSkipBlockKey(selectedFile, skipIndex);
      if (expandingSkipBlocks.has(key)) return;

      store.setSkipBlockExpanding(key, true);

      try {
        // Fetch the file content from the head commit
        const content = await github.getFileContent(
          owner,
          repo,
          selectedFile,
          pr.head.sha
        );

        if (!content) {
          console.error("Failed to fetch file for skip block expansion");
          return;
        }

        // Record the file's true length; this also sizes the end-of-file
        // gap, whose count is passed as Infinity until known.
        const split = content.split("\n");
        const totalLines =
          split[split.length - 1] === "" ? split.length - 1 : split.length;
        store.setFileLineCount(selectedFile, totalLines);

        // Clamp the gap to the end of the file
        const remCount = Math.min(count, totalLines - startLine + 1);
        if (remCount <= 0) return;

        const n =
          direction === "all" ? remCount : Math.min(SKIP_EXPAND_STEP, remCount);
        // A partial expansion that would leave a sliver smaller than one
        // step just reveals everything - same as GitHub.
        const fetchAll = direction === "all" || n >= remCount;
        const fetchCount = fetchAll ? remCount : n;
        const fetchStart =
          direction === "up" && !fetchAll
            ? startLine + remCount - n
            : startLine;
        const edge = direction === "up" && !fetchAll ? "bottom" : "top";

        // Get highlighted lines via WebWorker
        const expandedLines = await diffService.highlightLines(
          content,
          selectedFile,
          fetchStart,
          fetchCount
        );

        store.appendExpandedSkipBlock(key, edge, expandedLines);

        // Focus the first revealed line so the user can continue with keyboard
        if (expandedLines.length > 0) {
          const firstLine = expandedLines[0];
          const firstLineNum =
            firstLine.newLineNumber || firstLine.oldLineNumber;
          if (firstLineNum) {
            store.setFocusedLine(firstLineNum, "new");
          }
        }
      } catch (error) {
        console.error("Failed to expand skip block:", error);
      } finally {
        store.setSkipBlockExpanding(key, false);
      }
    },
    [
      store,
      owner,
      repo,
      pr.head.sha,
      selectedFile,
      expandedSkipBlocks,
      expandingSkipBlocks,
    ]
  );

  // Create a getExpandedLines function that uses the subscribed state directly
  const getExpandedLines = useCallback(
    (skipIndex: number): ExpandedSkipBlock | null => {
      if (!selectedFile) return null;
      const key = `${selectedFile}:${skipIndex}`;
      return expandedSkipBlocks[key] ?? null;
    },
    [selectedFile, expandedSkipBlocks]
  );

  const isExpanding = useCallback(
    (skipIndex: number): boolean => {
      if (!selectedFile) return false;
      const key = `${selectedFile}:${skipIndex}`;
      return expandingSkipBlocks.has(key);
    },
    [selectedFile, expandingSkipBlocks]
  );

  return { expandSkipBlock, isExpanding, getExpandedLines };
}
