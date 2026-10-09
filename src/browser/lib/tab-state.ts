export type TabStatus = {
  // CI status
  checks: "pending" | "success" | "failure" | "none" | "action_required";
  // PR state
  state: "open" | "closed" | "merged" | "draft";
  // Mergeable
  mergeable: boolean | null;
};

export interface Tab {
  id: string;
  type: "home" | "pr-review";
  label: string;
  // For PR review tabs
  owner?: string;
  repo?: string;
  number?: number;
  title?: string;
  // Status reported by the tab content
  status?: TabStatus;
}

export interface TabState {
  tabs: Tab[];
  activeTabId: string;
}

const STORAGE_KEY = "pulldash_tabs";

// Opening a tab beyond this many closeable tabs drops the oldest one.
export const MAX_OPEN_TABS = 5;

const HOME_TAB: Tab = {
  id: "home",
  type: "home",
  label: "Home",
};

const DEFAULT_STATE: TabState = {
  tabs: [HOME_TAB],
  activeTabId: "home",
};

export function loadTabState(
  storage: Pick<Storage, "getItem"> = localStorage
): TabState {
  try {
    const stored = storage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as TabState;
      // Ensure home tab always exists
      const hasHome = parsed.tabs.some((t) => t.id === "home");
      if (!hasHome) {
        parsed.tabs.unshift(HOME_TAB);
      }
      // Ensure active tab exists
      const activeExists = parsed.tabs.some((t) => t.id === parsed.activeTabId);
      if (!activeExists) {
        parsed.activeTabId = "home";
      }
      return parsed;
    }
  } catch {
    // ignore
  }
  return DEFAULT_STATE;
}

export function saveTabState(
  state: TabState,
  storage: Pick<Storage, "setItem"> = localStorage
): void {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Keep tabs usable when storage is unavailable or full.
  }
}

export function withOpenedTab(state: TabState, tab: Tab): TabState {
  if (state.tabs.some((t) => t.id === tab.id)) {
    return { ...state, activeTabId: tab.id };
  }
  const tabs = [...state.tabs, tab];
  let closeable = tabs.filter((t) => t.id !== "home").length;
  while (closeable > MAX_OPEN_TABS) {
    tabs.splice(
      tabs.findIndex((t) => t.id !== "home"),
      1
    );
    closeable--;
  }
  return { tabs, activeTabId: tab.id };
}

export function withTabTitle(
  state: TabState,
  tabId: string,
  title: string
): TabState {
  const index = state.tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1 || state.tabs[index].title === title) return state;
  const tabs = [...state.tabs];
  tabs[index] = { ...tabs[index], title };
  return { ...state, tabs };
}
