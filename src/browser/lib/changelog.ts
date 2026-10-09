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
