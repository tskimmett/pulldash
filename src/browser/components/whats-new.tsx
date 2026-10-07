import { useState } from "react";
import { Gift } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";
import { CHANGELOG, LAST_SEEN_KEY, unseenEntries } from "../lib/changelog";

function readLastSeen(): string | null {
  try {
    return localStorage.getItem(LAST_SEEN_KEY);
  } catch {
    return null;
  }
}

function markSeen() {
  try {
    localStorage.setItem(LAST_SEEN_KEY, CHANGELOG[0]!.id);
  } catch {}
}

/** Top-bar button + dialog listing recent changes; dot shows when unseen. */
export function WhatsNewButton() {
  const [open, setOpen] = useState(false);
  const [lastSeen, setLastSeen] = useState(readLastSeen);
  const unseen = unseenEntries(CHANGELOG, lastSeen);

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      markSeen();
      setLastSeen(CHANGELOG[0]!.id);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="relative flex items-center justify-center w-9 h-9 sm:w-7 sm:h-7 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors"
        title="What's new"
        aria-label="What's new"
      >
        <Gift className="w-4 h-4" />
        {unseen.length > 0 && (
          <span className="absolute top-1.5 right-1.5 sm:top-1 sm:right-1 w-1.5 h-1.5 rounded-full bg-blue-500" />
        )}
      </button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-md bg-background border-border">
          <DialogTitle>What&apos;s new</DialogTitle>
          <DialogDescription className="sr-only">
            Recent changes to better pr.
          </DialogDescription>
          <ul className="space-y-4 max-h-[60vh] overflow-y-auto">
            {CHANGELOG.map((entry) => (
              <li key={entry.id}>
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-medium text-foreground">
                    {entry.title}
                  </span>
                  {unseen.includes(entry) && (
                    <span className="text-[10px] uppercase font-semibold text-blue-500">
                      new
                    </span>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground">
                    {entry.date}
                  </span>
                </div>
                {entry.description && (
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {entry.description}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
