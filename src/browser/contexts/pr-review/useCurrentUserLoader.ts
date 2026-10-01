import { useEffect } from "react";
import { useGitHubSelector } from "@/browser/contexts/github";
import { usePRReviewStore } from ".";

export function useCurrentUserLoader() {
  const store = usePRReviewStore();
  const ready = useGitHubSelector((s) => s.ready);
  // The cached user arrives asynchronously, so subscribe rather than read once.
  const currentUser = useGitHubSelector((s) => s.currentUser?.login ?? null);

  useEffect(() => {
    if (ready && currentUser) {
      store.setCurrentUser(currentUser);
    }
  }, [ready, currentUser, store]);
}
