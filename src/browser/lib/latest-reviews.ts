import type { Review } from "@/browser/contexts/github";

/**
 * One review per user, matching GitHub's sidebar: the user's latest
 * APPROVED/CHANGES_REQUESTED review wins; a later dismissal clears it; users
 * who only commented are listed with their latest COMMENTED review.
 * Users in `pendingLogins` (re-requested) are omitted — they render as pending.
 * With `keepDismissed`, a user whose latest review was dismissed stays listed
 * (as DISMISSED) so they can still be re-requested, as GitHub's sidebar does.
 */
export function getLatestReviewsByUser(
  reviews: Review[],
  pendingLogins: Iterable<string> = [],
  keepDismissed = false
): Review[] {
  const pending = new Set(pendingLogins);
  const decisive = new Map<string, Review | null>();
  const dismissed = new Map<string, Review>();
  const commented = new Map<string, Review>();
  const sorted = reviews
    .filter((r) => r.submitted_at && r.user && !pending.has(r.user.login))
    .sort(
      (a, b) =>
        new Date(a.submitted_at!).getTime() -
        new Date(b.submitted_at!).getTime()
    );

  for (const review of sorted) {
    const login = review.user!.login;
    if (review.state === "APPROVED" || review.state === "CHANGES_REQUESTED") {
      decisive.set(login, review);
      dismissed.delete(login);
    } else if (review.state === "DISMISSED") {
      decisive.set(login, null);
      dismissed.set(login, review);
    } else if (review.state === "COMMENTED") {
      commented.set(login, review);
    }
  }

  const logins = new Set([...decisive.keys(), ...commented.keys()]);
  return [...logins]
    .map(
      (login) =>
        decisive.get(login) ??
        commented.get(login) ??
        (keepDismissed ? dismissed.get(login) : undefined)
    )
    .filter((r): r is Review => !!r);
}
