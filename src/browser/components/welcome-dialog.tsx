import { useState } from "react";
import { Github, Loader2, AlertCircle, LogOut, Clock } from "lucide-react";
import { BookmarkletDialog, useShowBookmarklet } from "./bookmarklet";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Button } from "../ui/button";
import { useAuth } from "../contexts/auth";
import { useCurrentUser } from "../contexts/github";
import { cn } from "../cn";

// ============================================================================
// PAT Authentication Section
// ============================================================================

function PATAuthSection() {
  const { loginWithPAT } = useAuth();
  const [showPATInput, setShowPATInput] = useState(true);
  const [patToken, setPatToken] = useState("");
  const [patError, setPatError] = useState<string | null>(null);
  const [isValidatingPAT, setIsValidatingPAT] = useState(false);

  const handlePATLogin = async () => {
    setPatError(null);
    setIsValidatingPAT(true);

    try {
      await loginWithPAT(patToken);
    } catch (error) {
      setPatError(
        error instanceof Error ? error.message : "Authentication failed"
      );
    } finally {
      setIsValidatingPAT(false);
    }
  };

  if (!showPATInput) {
    return (
      <button
        onClick={() => setShowPATInput(true)}
        className="w-full text-center text-sm text-muted-foreground hover:text-foreground transition-colors py-2"
      >
        Or use a Personal Access Token
      </button>
    );
  }

  return (
    <div className="space-y-3 pt-2">
      <div className="relative">
        <input
          id="pat-token"
          type="password"
          value={patToken}
          onChange={(e) => setPatToken(e.target.value)}
          placeholder="Paste your token (ghp_... or github_pat_...)"
          className={cn(
            "w-full h-10 px-3 rounded-md border bg-background text-foreground text-sm",
            "placeholder:text-muted-foreground",
            "focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            patError && "border-destructive focus:ring-destructive"
          )}
          disabled={isValidatingPAT}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter" && patToken && !isValidatingPAT) {
              handlePATLogin();
            }
            if (e.key === "Escape") {
              setShowPATInput(false);
              setPatToken("");
              setPatError(null);
            }
          }}
        />
      </div>

      {patError && (
        <div className="flex items-start gap-2 p-2.5 rounded-md bg-destructive/10 border border-destructive/20 text-destructive text-sm">
          <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{patError}</span>
        </div>
      )}

      <div className="flex gap-2">
        <Button
          onClick={handlePATLogin}
          disabled={!patToken || isValidatingPAT}
          className="flex-1 h-9 gap-2"
        >
          {isValidatingPAT ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              Validating...
            </>
          ) : (
            "Sign in"
          )}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setShowPATInput(false);
            setPatToken("");
            setPatError(null);
          }}
          className="h-9 px-3 text-muted-foreground"
          disabled={isValidatingPAT}
        >
          Cancel
        </Button>
      </div>

      <p className="text-xs text-muted-foreground">
        Use a fine-grained token limited to the repos you review{" "}
        <a
          href="https://github.com/settings/personal-access-tokens/new"
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground hover:underline"
        >
          (create →)
        </a>
        , or a classic token with{" "}
        <code className="px-1 py-0.5 rounded bg-muted font-mono">repo</code>{" "}
        scope{" "}
        <a
          href="https://github.com/settings/tokens/new?scopes=repo,read:user&description=better%20pr"
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground hover:underline"
        >
          (create →)
        </a>
        .
      </p>
    </div>
  );
}

// ============================================================================
// ============================================================================
// Welcome Dialog
// ============================================================================

export function WelcomeDialog() {
  const { isAuthenticated, isRateLimited } = useAuth();

  if (isAuthenticated && !isRateLimited) {
    return null;
  }

  return (
    <Dialog open={true}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md p-0 gap-0 bg-background border-border overflow-hidden"
      >
        <DialogTitle className="sr-only">Welcome to better pr</DialogTitle>
        <DialogDescription className="sr-only">
          Sign in with a personal access token to access your pull requests.
        </DialogDescription>
        <div className="p-6">
          {/* Header */}
          <div className="flex items-center gap-3 mb-6">
            <img src={"/logo.svg"} alt="better pr" className="w-10 h-10" />
            <div>
              <h2 className="text-lg font-semibold text-foreground">
                better pr
              </h2>
              <p className="text-sm text-muted-foreground">
                What GitHub should be
              </p>
            </div>
          </div>

          {isRateLimited && (
            <div className="flex items-start gap-3 p-3 rounded-md bg-amber-500/10 border border-amber-500/20 text-amber-400 mb-4">
              <Clock className="w-4 h-4 shrink-0 mt-0.5" />
              <div className="text-sm">
                <p className="font-medium">Rate limit reached</p>
                <p className="opacity-80 mt-0.5">
                  GitHub API rate limit exceeded. This should resolve
                  automatically in a few minutes.
                </p>
              </div>
            </div>
          )}

          <div className="space-y-4">
            <PATAuthSection />

            <p className="text-xs text-center text-muted-foreground">
              Your token is kept only in this browser&apos;s local storage and
              is sent only to api.github.com. Log out to remove it.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// User Menu Button - Shows logout option when authenticated
// ============================================================================

export function UserMenuButton({ className }: { className?: string }) {
  const { isAuthenticated, logout } = useAuth();
  const currentUser = useCurrentUser()?.login ?? null;
  const showBookmarklet = useShowBookmarklet();
  const [bookmarkletOpen, setBookmarkletOpen] = useState(false);

  if (!isAuthenticated) {
    return null;
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className={cn(
              "flex items-center gap-1.5 p-1 rounded-md hover:bg-muted/50 transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 focus:ring-offset-background",
              className
            )}
            title={currentUser ? `Signed in as ${currentUser}` : "Account"}
          >
            {currentUser ? (
              <img
                src={`https://github.com/${currentUser}.png`}
                alt={currentUser}
                className="w-5 h-5 rounded-full ring-1 ring-border"
              />
            ) : (
              <LogOut className="w-3.5 h-3.5 text-muted-foreground" />
            )}
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          {currentUser && (
            <>
              <DropdownMenuLabel className="font-normal">
                <div className="flex items-center gap-2">
                  <img
                    src={`https://github.com/${currentUser}.png`}
                    alt={currentUser}
                    className="w-8 h-8 rounded-full"
                  />
                  <div className="flex flex-col">
                    <span className="text-sm font-medium">{currentUser}</span>
                    <span className="text-xs text-muted-foreground">
                      Signed in with GitHub
                    </span>
                  </div>
                </div>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
            </>
          )}
          {showBookmarklet && (
            <>
              <DropdownMenuItem
                onClick={() => setBookmarkletOpen(true)}
                className="cursor-pointer"
              >
                <Github className="w-4 h-4" />
                Redirect Bookmark
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem
            variant="destructive"
            onClick={logout}
            className="cursor-pointer"
          >
            <LogOut className="w-4 h-4" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <BookmarkletDialog
        open={bookmarkletOpen}
        onOpenChange={setBookmarkletOpen}
      />
    </>
  );
}
