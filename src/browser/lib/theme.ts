// ============================================================================
// Theme (light / dark / system)
// ============================================================================
//
// App-global preference persisted in localStorage. The `dark` class on
// <html> is what Tailwind's `dark:` variant keys off of (see index.css:
// `@custom-variant dark (&:is(.dark *))`).
//
// The initial class is applied by an inline script in index.html so there is
// no flash of the wrong theme before React mounts. This module keeps that in
// sync afterwards.

import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "pulldash_theme";

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark" || value === "system";
}

export function getStoredTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (isTheme(stored)) return stored;
  } catch {}
  return "system";
}

function setStoredTheme(theme: Theme): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {}
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {}
  return true;
}

/** The theme actually being rendered, resolving "system". */
export function resolveTheme(theme: Theme): "light" | "dark" {
  if (theme === "system") return systemPrefersDark() ? "dark" : "light";
  return theme;
}

export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  root.classList.toggle("dark", resolveTheme(theme) === "dark");
  root.style.colorScheme = resolveTheme(theme);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

type Listener = () => void;

let current: Theme = "system";
const listeners = new Set<Listener>();
let initialized = false;
let mediaQuery: MediaQueryList | null = null;

function emit(): void {
  for (const listener of listeners) listener();
}

function handleSystemChange(): void {
  if (current === "system") applyTheme(current);
}

function init(): void {
  if (initialized) return;
  initialized = true;
  current = getStoredTheme();
  applyTheme(current);
  try {
    mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    mediaQuery.addEventListener("change", handleSystemChange);
  } catch {}
}

export function getTheme(): Theme {
  init();
  return current;
}

export function setTheme(theme: Theme): void {
  init();
  if (current === theme) return;
  current = theme;
  setStoredTheme(theme);
  applyTheme(theme);
  emit();
}

/** Cycles light -> dark -> system -> light. */
export function nextTheme(theme: Theme): Theme {
  if (theme === "light") return "dark";
  if (theme === "dark") return "system";
  return "light";
}

export function subscribeTheme(listener: Listener): () => void {
  init();
  listeners.add(listener);
  const onSystem = () => {
    if (current === "system") listener();
  };
  mediaQuery?.addEventListener("change", onSystem);
  return () => {
    listeners.delete(listener);
    mediaQuery?.removeEventListener("change", onSystem);
  };
}

// ---------------------------------------------------------------------------
// React bindings
// ---------------------------------------------------------------------------

/** The user's preference, including "system". */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribeTheme, getTheme, () => "system");
}

/** The theme actually rendered — "system" already resolved. */
export function useResolvedTheme(): "light" | "dark" {
  return useSyncExternalStore(
    subscribeTheme,
    () => resolveTheme(getTheme()),
    () => "dark"
  );
}
