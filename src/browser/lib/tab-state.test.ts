import { expect, test } from "bun:test";
import {
  loadTabState,
  saveTabState,
  withTabTitle,
  type TabState,
} from "./tab-state";

function createStorage(initial?: string) {
  const values = new Map<string, string>();
  if (initial) values.set("pulldash_tabs", initial);
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
}

const prTab = {
  id: "pr-owner-repo-42",
  type: "pr-review" as const,
  label: "#42",
  owner: "owner",
  repo: "repo",
  number: 42,
};

test("PR titles persist and refresh without changing tab identity or status", () => {
  const storage = createStorage();
  const state: TabState = {
    tabs: [
      ...loadTabState(storage).tabs,
      {
        ...prTab,
        status: { checks: "success", state: "open", mergeable: true },
      },
    ],
    activeTabId: prTab.id,
  };
  const titled = withTabTitle(state, prTab.id, "Fix authentication");
  saveTabState(titled, storage);
  const restored = loadTabState(storage);
  expect(restored).toEqual(titled);
  expect(state.tabs[1].title).toBeUndefined();
  const renamed = withTabTitle(restored, prTab.id, "Fix authentication race");
  expect(renamed.tabs[1]).toEqual({
    ...state.tabs[1],
    title: "Fix authentication race",
  });
  saveTabState(renamed, storage);
  expect(loadTabState(storage)).toEqual(renamed);
  expect(withTabTitle(renamed, prTab.id, "Fix authentication race")).toBe(
    renamed
  );
  expect(withTabTitle(renamed, "missing", "Title")).toBe(renamed);
});

test("legacy tabs without titles restore and acquire titles", () => {
  const storage = createStorage(
    JSON.stringify({ tabs: [prTab], activeTabId: prTab.id })
  );
  const state = loadTabState(storage);
  expect(state.tabs[0].id).toBe("home");
  expect(state.tabs[1].label).toBe("#42");
  expect(state.tabs[1].title).toBeUndefined();
  saveTabState(withTabTitle(state, prTab.id, "New title"), storage);
  expect(loadTabState(storage).tabs[1].title).toBe("New title");
});

test("invalid stored state falls back and unavailable storage does not prevent tab updates", () => {
  expect(loadTabState(createStorage("invalid JSON")).activeTabId).toBe("home");
  const storage = {
    getItem: () => {
      throw new Error("Unavailable");
    },
    setItem: () => {
      throw new Error("Full");
    },
  };
  const state = loadTabState(storage);
  expect(state.tabs.map((tab) => tab.id)).toEqual(["home"]);
  expect(() => saveTabState(state, storage)).not.toThrow();
});
