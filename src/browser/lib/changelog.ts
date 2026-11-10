// User-facing change log shown in the "What's new" dialog. Newest first.
// Add an entry here for every user-visible feature or change (see AGENTS.md).
// `id` must be unique and sortable; it is stored in localStorage as the last
// entry the user has seen.

export type ChangelogEntry = {
  id: string;
  date: string;
  title: string;
  description?: string;
};

export const CHANGELOG: ChangelogEntry[] = [
  {
    id: "2026-11-10-changed-since-viewed",
    date: "2026-11-10",
    title: "Viewed files reset when they change",
    description:
      'If a push changes a file you marked viewed, it goes back to unviewed and is marked "Changed since viewed". Click that label to see only what changed since you viewed it.',
  },
  {
    id: "2026-11-10-multi-reviewer-picker",
    date: "2026-11-10",
    title: "Request several reviewers at once",
    description:
      "The reviewer picker now has checkboxes. Check or uncheck people, and the changes apply when the picker closes.",
  },
  {
    id: "2026-11-05-image-viewer-paging",
    date: "2026-11-05",
    title: "Page through screenshots",
    description:
      "In the image viewer, use ← and → (or the side arrows) to move between images in the same description or comment.",
  },
  {
    id: "2026-11-05-requested-reviewers-pill",
    date: "2026-11-05",
    title: "Requested reviewers on the dashboard",
    description:
      "PR rows show a pill when reviews are pending from requested reviewers. Hover it to see who.",
  },
  {
    id: "2026-11-04-w-close-tab",
    date: "2026-11-04",
    title: "Press w to close a tab",
    description: "Press w to close the current PR tab.",
  },
  {
    id: "2026-11-02-check-details",
    date: "2026-11-02",
    title: "Check details and re-run",
    description:
      "Expand a check on the Checks tab to see its summary and annotations, or re-run it. Details on the overview card now opens that check here.",
  },
  {
    id: "2026-11-02-description-modal",
    date: "2026-11-02",
    title: "PR description in a modal",
    description:
      "Read the PR description without leaving the diff: click Description in the header or press i. Press Escape to close.",
  },
  {
    id: "2026-10-22-timeline-commits",
    date: "2026-10-22",
    title: "Open commits from the timeline",
    description:
      "Clicking a commit in the PR timeline or Commits tab now shows that commit's changes here instead of opening GitHub. Cmd/Ctrl-click still opens it on GitHub.",
  },
  {
    id: "2026-10-16-edit-title",
    date: "2026-10-16",
    title: "Edit PR title",
    description:
      "Rename a pull request right from the header: click the pencil next to the title (or double-click it), then press Enter to save or Escape to cancel.",
  },
  {
    id: "2026-10-09-pwa",
    date: "2026-10-09",
    title: "Install as an app",
    description:
      "Add better pr to your phone's home screen (Share → Add to Home Screen on iOS, Install app on Android) and it opens full-screen like a native app.",
  },
  {
    id: "2026-10-09-update-branch",
    date: "2026-10-09",
    title: "Update branch",
    description:
      "When a PR falls behind its base branch, update it with a merge commit or a rebase from the merge box.",
  },
  {
    id: "2026-10-09-tab-limit",
    date: "2026-10-09",
    title: "Tab limit",
    description:
      "Up to 5 PR tabs stay open. Opening another closes the oldest one.",
  },
  {
    id: "2026-10-06-pr-stack-nav",
    date: "2026-10-06",
    title: "PR stack navigation",
    description:
      "Jump between PRs in a stack. Commits and checks tabs now work on mobile.",
  },
  {
    id: "2026-10-07-mobile",
    date: "2026-10-07",
    title: "Better mobile layout",
    description:
      "Responsive layout for narrow viewports, and long diff lines scroll horizontally instead of wrapping.",
  },
  {
    id: "2026-10-06-diff-stat",
    date: "2026-10-06",
    title: "Diff stat for visible files",
    description: "Shown next to the hidden test files count.",
  },
  {
    id: "2026-10-02-auto-merge",
    date: "2026-10-02",
    title: "Schedule auto-merge",
    description: "Enable auto-merge right from the PR merge box.",
  },
  {
    id: "2026-10-02-branch-search",
    date: "2026-10-02",
    title: "Search by branch name",
    description: "Paste a branch name into the header search to find its PR.",
  },
  {
    id: "2026-10-02-pr-search",
    date: "2026-10-02",
    title: "Smarter PR search",
    description:
      "Two-stage search also finds PRs that aren't in your feed repos.",
  },
  {
    id: "2026-10-02-tree-expand",
    date: "2026-10-02",
    title: "Expand/collapse folders recursively",
    description: "Available from the file tree folder context menu.",
  },
  {
    id: "2026-10-02-all-files",
    date: "2026-10-02",
    title: "All Files view polish",
    description:
      "File header repeats below each diff, the footer bar only shows for longer diffs, and viewed toggles no longer overlap files.",
  },
];

export const LAST_SEEN_KEY = "better_pr_last_seen_change";

/** Entries newer than `lastSeenId`. Unknown/missing id means all are unseen. */
export function unseenEntries(
  entries: ChangelogEntry[],
  lastSeenId: string | null
): ChangelogEntry[] {
  if (lastSeenId === null) return entries;
  const idx = entries.findIndex((e) => e.id === lastSeenId);
  return idx === -1 ? entries : entries.slice(0, idx);
}
