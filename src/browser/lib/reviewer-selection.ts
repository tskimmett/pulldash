export interface ReviewerOption {
  login: string;
  avatar_url: string;
}

/**
 * Builds the reviewer picker rows. Currently requested reviewers come first
 * (so the checked rows sit together, like GitHub), then the remaining
 * collaborators. The PR author can't review their own PR, so they're omitted.
 */
export function buildReviewerOptions(
  requested: ReviewerOption[],
  collaborators: ReviewerOption[],
  author: string | undefined
): ReviewerOption[] {
  const seen = new Set<string>();
  const options: ReviewerOption[] = [];
  for (const user of [...requested, ...collaborators]) {
    if (!user.login || user.login === author || seen.has(user.login)) continue;
    seen.add(user.login);
    options.push(user);
  }
  return options;
}

/** Diffs the picker selection against the reviewers requested when it opened. */
export function diffReviewerSelection(
  initial: Iterable<string>,
  selected: Iterable<string>
): { add: string[]; remove: string[] } {
  const before = new Set(initial);
  const after = new Set(selected);
  return {
    add: [...after].filter((login) => !before.has(login)),
    remove: [...before].filter((login) => !after.has(login)),
  };
}
