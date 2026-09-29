// ============================================================================
// Resizable sidebar width
// ============================================================================
//
// App-global preference persisted in localStorage, shared by the file-tree
// sidebar and the semantic-review sidebar so switching view modes doesn't
// change the layout. Resizing is desktop-only; the mobile drawer keeps the
// stored width but is capped by max-width in the sidebar's own classes.

import { useCallback, useRef, useSyncExternalStore } from "react";

export const SIDEBAR_WIDTH_KEY = "pulldash_sidebar_width";

export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 520;
export const DEFAULT_SIDEBAR_WIDTH = 272;

export function clampSidebarWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
}

function getStoredWidth(): number {
  try {
    const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
    if (stored > 0) return clampSidebarWidth(stored);
  } catch {}
  return DEFAULT_SIDEBAR_WIDTH;
}

let width = getStoredWidth();
const listeners = new Set<() => void>();

function setSidebarWidth(next: number): void {
  const clamped = clampSidebarWidth(next);
  if (clamped === width) return;
  width = clamped;
  try {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clamped));
  } catch {}
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useSidebarWidth(): number {
  return useSyncExternalStore(
    subscribe,
    () => width,
    () => width
  );
}

/**
 * Invisible drag handle for the sidebar's right edge. Render as the last
 * child of the sidebar `<aside>` (which is already positioned). Desktop only.
 */
export function SidebarResizeHandle() {
  const dragState = useRef<{ startX: number; startWidth: number } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragState.current = { startX: e.clientX, startWidth: width };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragState.current;
    if (!drag) return;
    setSidebarWidth(drag.startWidth + (e.clientX - drag.startX));
  }, []);

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    dragState.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {}
  }, []);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH)}
      className="hidden md:block absolute inset-y-0 -right-1 w-2 z-10 cursor-col-resize touch-none hover:bg-primary/20 active:bg-primary/30 transition-colors"
    />
  );
}
