import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";

import {
  loadTabState,
  saveTabState,
  withOpenedTab,
  withTabTitle,
  type Tab,
  type TabStatus,
  type TabState,
} from "../lib/tab-state";
export type { Tab, TabStatus } from "../lib/tab-state";

// ============================================================================
// Types
// ============================================================================

interface TabContextValue {
  tabs: Tab[];
  activeTabId: string;
  activeTab: Tab | undefined;
  openTab: (tab: Omit<Tab, "id"> & { id?: string }) => string;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  updateTabTitle: (tabId: string, title: string) => void;
  updateTabStatus: (tabId: string, status: TabStatus) => void;
  getExistingPRTab: (
    owner: string,
    repo: string,
    number: number
  ) => Tab | undefined;
}

// ============================================================================
// Context
// ============================================================================

const TabContext = createContext<TabContextValue | null>(null);

export function useTabContext() {
  const ctx = useContext(TabContext);
  if (!ctx) {
    throw new Error("useTabContext must be used within TabProvider");
  }
  return ctx;
}

// ============================================================================
// Provider
// ============================================================================

interface TabProviderProps {
  children: ReactNode;
}

export function TabProvider({ children }: TabProviderProps) {
  const [state, setState] = useState<TabState>(loadTabState);

  // Save to localStorage whenever state changes
  useEffect(() => {
    saveTabState(state);
  }, [state]);

  const openTab = useCallback(
    (tabInput: Omit<Tab, "id"> & { id?: string }): string => {
      const id = tabInput.id || `tab-${Date.now()}`;
      const tab: Tab = { ...tabInput, id };

      setState((prev) => withOpenedTab(prev, tab));

      return id;
    },
    []
  );

  const closeTab = useCallback((tabId: string) => {
    // Can't close home tab
    if (tabId === "home") return;

    setState((prev) => {
      const tabIndex = prev.tabs.findIndex((t) => t.id === tabId);
      if (tabIndex === -1) return prev;

      const newTabs = prev.tabs.filter((t) => t.id !== tabId);
      let newActiveId = prev.activeTabId;

      // If closing active tab, switch to adjacent tab
      if (prev.activeTabId === tabId) {
        const newIndex = Math.min(tabIndex, newTabs.length - 1);
        newActiveId = newTabs[newIndex].id;
      }

      return { tabs: newTabs, activeTabId: newActiveId };
    });
  }, []);

  const setActiveTab = useCallback((tabId: string) => {
    setState((prev) => {
      if (prev.tabs.some((t) => t.id === tabId)) {
        return { ...prev, activeTabId: tabId };
      }
      return prev;
    });
  }, []);

  const updateTabTitle = useCallback((tabId: string, title: string) => {
    setState((prev) => withTabTitle(prev, tabId, title));
  }, []);

  const updateTabStatus = useCallback((tabId: string, status: TabStatus) => {
    setState((prev) => {
      const tabIndex = prev.tabs.findIndex((t) => t.id === tabId);
      if (tabIndex === -1) return prev;

      const newTabs = [...prev.tabs];
      newTabs[tabIndex] = { ...newTabs[tabIndex], status };
      return { ...prev, tabs: newTabs };
    });
  }, []);

  const getExistingPRTab = useCallback(
    (owner: string, repo: string, number: number): Tab | undefined => {
      return state.tabs.find(
        (t) =>
          t.type === "pr-review" &&
          t.owner === owner &&
          t.repo === repo &&
          t.number === number
      );
    },
    [state.tabs]
  );

  const activeTab = state.tabs.find((t) => t.id === state.activeTabId);

  const value: TabContextValue = {
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    activeTab,
    openTab,
    closeTab,
    setActiveTab,
    updateTabTitle,
    updateTabStatus,
    getExistingPRTab,
  };

  return <TabContext.Provider value={value}>{children}</TabContext.Provider>;
}

// ============================================================================
// Hooks
// ============================================================================

export function useOpenPRReviewTab() {
  const { openTab, getExistingPRTab, setActiveTab, updateTabTitle } =
    useTabContext();
  const navigate = useNavigate();

  return useCallback(
    (owner: string, repo: string, number: number, title?: string) => {
      // Check if tab already exists
      const existing = getExistingPRTab(owner, repo, number);
      if (existing) {
        if (title) updateTabTitle(existing.id, title);
        setActiveTab(existing.id);
        // Navigate to the PR URL
        navigate(`/${owner}/${repo}/pull/${number}`);
        return existing.id;
      }

      // Create new tab
      const id = `pr-${owner}-${repo}-${number}`;
      const tabId = openTab({
        id,
        type: "pr-review",
        label: `#${number}`,
        title,
        owner,
        repo,
        number,
      });

      // Navigate to the PR URL
      navigate(`/${owner}/${repo}/pull/${number}`);

      return tabId;
    },
    [openTab, getExistingPRTab, setActiveTab, updateTabTitle, navigate]
  );
}
