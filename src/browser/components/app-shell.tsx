import { useCallback, useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import {
  X,
  Home as HomeIcon,
  GitMerge,
  GitPullRequest,
  Search,
  ChevronDown,
} from "lucide-react";
import { cn } from "../cn";
import {
  useTabContext,
  useOpenPRReviewTab,
  type Tab,
  type TabStatus,
} from "../contexts/tabs";
import { Home } from "./home";
import { PRSearchInput } from "./pr-search-input";
import { PRReviewContent } from "./pr-review";
import { UserMenuButton } from "./welcome-dialog";
import { ThemeToggle } from "./theme-toggle";
import { WhatsNewButton } from "./whats-new";
import {
  HoverCard,
  HoverCardTrigger,
  HoverCardContent,
} from "../ui/hover-card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { version } from "../../../package.json";

// ============================================================================
// App Shell - Tab-based Layout
// ============================================================================

export function AppShell() {
  const {
    tabs,
    activeTabId,
    activeTab,
    setActiveTab,
    closeTab,
    openTab,
    getExistingPRTab,
  } = useTabContext();
  const params = useParams<{ owner: string; repo: string; number: string }>();
  const navigate = useNavigate();
  // Below sm the header has no room for the search input, so it opens as a
  // full-width row under the tab bar instead.
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  useEffect(() => setMobileSearchOpen(false), [activeTabId]);

  // URL is the source of truth - sync URL → Tab
  useEffect(() => {
    if (params.owner && params.repo && params.number) {
      const owner = params.owner;
      const repo = params.repo;
      const number = parseInt(params.number, 10);
      const expectedTabId = `pr-${owner}-${repo}-${number}`;

      // Only update if needed
      if (activeTabId === expectedTabId) return;

      // Check if tab already exists
      const existing = getExistingPRTab(owner, repo, number);
      if (existing) {
        setActiveTab(existing.id);
      } else {
        // Create new tab
        openTab({
          id: expectedTabId,
          type: "pr-review",
          label: `#${number}`,
          owner,
          repo,
          number,
        });
      }
    } else {
      // Home route - only switch if not already on home
      if (activeTabId !== "home") {
        setActiveTab("home");
      }
    }
  }, [params.owner, params.repo, params.number]);

  // Navigate when clicking on a tab
  const handleTabSelect = useCallback(
    (tab: Tab) => {
      if (tab.type === "home") {
        navigate("/");
      } else if (
        tab.type === "pr-review" &&
        tab.owner &&
        tab.repo &&
        tab.number
      ) {
        navigate(`/${tab.owner}/${tab.repo}/pull/${tab.number}`);
      }
    },
    [navigate]
  );

  // Handle keyboard shortcuts for tab switching
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd/Ctrl + number to switch tabs
      if ((e.metaKey || e.ctrlKey) && e.key >= "1" && e.key <= "9") {
        e.preventDefault();
        const index = parseInt(e.key) - 1;
        if (tabs[index]) {
          handleTabSelect(tabs[index]);
        }
      }
      // Cmd/Ctrl + W to close current tab
      if ((e.metaKey || e.ctrlKey) && e.key === "w") {
        if (activeTabId !== "home") {
          e.preventDefault();
          closeTab(activeTabId);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [tabs, activeTabId, handleTabSelect, closeTab]);

  return (
    <div className="h-dvh flex flex-col overflow-hidden bg-background">
      {/* Native-style Tab Bar */}
      <div className="h-9 bg-muted/40 dark:bg-[#1a1a1a] flex items-center shrink-0 border-b border-border/50">
        {/* Logo with tooltip */}
        <div className="h-full flex items-center gap-1.5 px-3 shrink-0">
          <HoverCard openDelay={200} closeDelay={100}>
            <HoverCardTrigger asChild>
              <button className="flex items-center focus:outline-none">
                <img
                  src={"/logo.svg"}
                  alt="better pr"
                  className="w-4 h-4 block"
                />
              </button>
            </HoverCardTrigger>
            <HoverCardContent side="bottom" align="start" className="w-64">
              <div className="space-y-3">
                <div className="flex items-center gap-2">
                  <img src={"/logo.svg"} alt="better pr" className="w-6 h-6" />
                  <div>
                    <h4 className="text-sm font-semibold">better pr</h4>
                    <p className="text-[10px] text-muted-foreground font-mono">
                      v{version}
                    </p>
                  </div>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  A fast PR review dashboard for GitHub.
                </p>
              </div>
            </HoverCardContent>
          </HoverCard>
        </div>

        {/* Tabs: a strip on wide screens, a switcher dropdown on phones */}
        <MobileTabSwitcher
          tabs={tabs}
          activeTab={activeTab}
          onSelect={handleTabSelect}
          onClose={closeTab}
        />
        <div className="h-full flex-1 min-w-0 hidden sm:flex items-center gap-0.5 overflow-x-auto hide-scrollbar [mask-image:linear-gradient(to_right,black_calc(100%-24px),transparent)]">
          {tabs.map((tab) => (
            <TabItem
              key={tab.id}
              tab={tab}
              isActive={tab.id === activeTabId}
              onSelect={() => handleTabSelect(tab)}
              onClose={() => closeTab(tab.id)}
            />
          ))}
        </div>

        {/* PR URL input & User menu */}
        <div className="h-full flex items-center gap-2 pr-2 sm:pr-3 sm:pl-2 shrink-0">
          <div className="hidden sm:block">
            <PRSearchInput />
          </div>
          <button
            type="button"
            onClick={() => setMobileSearchOpen((o) => !o)}
            aria-label="Search PRs"
            aria-expanded={mobileSearchOpen}
            className={cn(
              "sm:hidden flex items-center justify-center w-9 h-9 rounded-md text-muted-foreground hover:text-foreground hover:bg-foreground/5 transition-colors",
              mobileSearchOpen && "bg-foreground/10 text-foreground"
            )}
          >
            <Search className="w-4 h-4" />
          </button>
          <WhatsNewButton />
          <ThemeToggle />
          <UserMenuButton />
        </div>
      </div>

      {mobileSearchOpen && (
        <div className="sm:hidden px-2 py-2 border-b border-border/50 bg-muted/40 dark:bg-[#1a1a1a] shrink-0 relative z-50">
          <PRSearchInput className="w-full" autoFocus />
        </div>
      )}

      {/* Content Area - Only render active tab to avoid parallel data fetching */}
      <div className="flex-1 overflow-hidden relative">
        {/* Home is always mounted (lightweight) */}
        <div
          className={cn(
            "absolute inset-0",
            activeTabId !== "home" && "invisible pointer-events-none"
          )}
        >
          <Home />
        </div>

        {/* PR Review - only render active tab */}
        {activeTab?.type === "pr-review" &&
          activeTab.owner &&
          activeTab.repo &&
          activeTab.number && (
            <div key={activeTab.id} className="absolute inset-0">
              <PRReviewContent
                owner={activeTab.owner}
                repo={activeTab.repo}
                number={activeTab.number}
                tabId={activeTab.id}
              />
            </div>
          )}
      </div>
    </div>
  );
}

// ============================================================================
// Tab Item
// ============================================================================

interface TabItemProps {
  tab: Tab;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
}

function TabItem({ tab, isActive, onSelect, onClose }: TabItemProps) {
  const isHome = tab.type === "home";

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onClose();
    },
    [onClose]
  );

  const handleMiddleClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.button === 1 && !isHome) {
        e.preventDefault();
        onClose();
      }
    },
    [isHome, onClose]
  );

  return (
    <div
      role="button"
      tabIndex={0}
      title={
        isHome
          ? "Home"
          : `${tab.owner}/${tab.repo} ${tab.label}${tab.title ? ` — ${tab.title}` : ""}`
      }
      onClick={onSelect}
      onMouseDown={handleMiddleClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "group flex items-center gap-1.5 h-full px-2.5 text-xs font-medium border-b-2 transition-colors shrink-0 max-w-[320px] cursor-pointer",
        isActive
          ? "border-orange-500 bg-background text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground hover:bg-foreground/5"
      )}
    >
      <TabIcon tab={tab} />

      <span className="shrink-0">{isHome ? "Home" : tab.label}</span>
      {!isHome && tab.title && (
        <span className="min-w-0 truncate text-[11px] font-normal">
          {tab.title}
        </span>
      )}

      {/* Repo name for PR tabs */}
      {tab.type === "pr-review" && tab.repo && (
        <span className="text-[10px] text-muted-foreground truncate max-w-[80px] shrink-0 hidden sm:inline">
          {tab.repo}
        </span>
      )}

      {/* Close button */}
      {!isHome && (
        <button
          onClick={handleClose}
          className={cn(
            "p-0.5 rounded hover:bg-foreground/10 transition-opacity shrink-0",
            isActive
              ? "opacity-60 hover:opacity-100"
              : "opacity-0 group-hover:opacity-60 hover:!opacity-100 pointer-coarse:opacity-60"
          )}
        >
          <X className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

// ============================================================================
// Mobile Tab Switcher
// ============================================================================

interface MobileTabSwitcherProps {
  tabs: Tab[];
  activeTab: Tab | undefined;
  onSelect: (tab: Tab) => void;
  onClose: (tabId: string) => void;
}

function MobileTabSwitcher({
  tabs,
  activeTab,
  onSelect,
  onClose,
}: MobileTabSwitcherProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="sm:hidden h-full flex-1 min-w-0 flex items-center gap-1.5 px-1 text-xs font-medium text-foreground"
        >
          {activeTab && <TabIcon tab={activeTab} />}
          <span className="shrink-0">
            {!activeTab || activeTab.type === "home" ? "Home" : activeTab.label}
          </span>
          {activeTab?.type === "pr-review" && activeTab.title && (
            <span className="min-w-0 truncate text-[11px] font-normal text-muted-foreground">
              {activeTab.title}
            </span>
          )}
          {tabs.length > 1 && (
            <span className="shrink-0 inline-flex items-center justify-center h-4 min-w-4 px-1 rounded bg-foreground/10 text-[10px] tabular-nums text-muted-foreground">
              {tabs.length}
            </span>
          )}
          <ChevronDown className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="w-[calc(100vw-1rem)] max-w-sm"
      >
        {tabs.map((tab) => {
          const isHome = tab.type === "home";
          const isActive = tab.id === activeTab?.id;
          return (
            <DropdownMenuItem
              key={tab.id}
              onSelect={() => onSelect(tab)}
              className={cn("gap-2 py-2 pr-1", isActive && "bg-accent/60")}
            >
              <TabIcon tab={tab} />
              <span className="min-w-0 flex-1">
                <span className="flex items-baseline gap-1.5">
                  <span className="shrink-0 text-xs font-medium">
                    {isHome ? "Home" : tab.label}
                  </span>
                  {!isHome && tab.repo && (
                    <span className="min-w-0 truncate text-[10px] text-muted-foreground">
                      {tab.owner}/{tab.repo}
                    </span>
                  )}
                </span>
                {!isHome && tab.title && (
                  <span className="block truncate text-xs text-muted-foreground">
                    {tab.title}
                  </span>
                )}
              </span>
              {!isHome && (
                <button
                  type="button"
                  aria-label={`Close ${tab.label}`}
                  // Radix selects items from pointerup as well as click; stop
                  // both so closing doesn't also switch tabs, and the menu
                  // stays open to close several in a row.
                  onPointerDown={(e) => e.stopPropagation()}
                  onPointerUp={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    onClose(tab.id);
                  }}
                  className="shrink-0 p-2 rounded text-muted-foreground hover:text-foreground hover:bg-foreground/10"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function TabIcon({ tab }: { tab: Tab }) {
  if (tab.type === "home") return <HomeIcon className="w-3 h-3 shrink-0" />;
  if (tab.status?.state === "merged") {
    return <GitMerge className="w-3 h-3 shrink-0 text-purple-500" />;
  }
  return <TabStatusIndicator status={tab.status} />;
}

// ============================================================================
// Status Indicator
// ============================================================================

function TabStatusIndicator({ status }: { status?: TabStatus }) {
  if (!status) {
    // Loading state - show pulsing dot
    return (
      <span className="w-2 h-2 rounded-full bg-muted-foreground/50 animate-pulse shrink-0" />
    );
  }

  // Determine the color based on state and checks
  let colorClass = "bg-muted-foreground/50"; // default/unknown
  let title = "Unknown";

  if (status.state === "closed") {
    colorClass = "bg-red-500";
    title = "Closed";
  } else if (status.state === "draft") {
    colorClass = "bg-muted-foreground";
    title = "Draft";
  } else if (status.state === "open") {
    // Open PR - color based on checks and mergeability
    if (status.mergeable === false) {
      colorClass = "bg-red-500";
      title = "Has conflicts";
    } else if (status.checks === "failure") {
      colorClass = "bg-red-500";
      title = "Checks failing";
    } else if (status.checks === "pending") {
      colorClass = "bg-yellow-500";
      title = "Checks running";
    } else if (status.checks === "success" || status.checks === "none") {
      colorClass = "bg-green-500";
      title = status.mergeable ? "Ready to merge" : "Checks passed";
    }
  }

  return (
    <span
      className={cn("w-2 h-2 rounded-full shrink-0", colorClass)}
      title={title}
    />
  );
}
