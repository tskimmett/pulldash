import { useLayoutEffect, type RefObject } from "react";

/**
 * Mirrors an element's client width into a CSS custom property on it, so
 * descendants can size themselves to the visible width of a horizontal
 * scroller. Writes the style directly to avoid re-rendering on resize.
 */
export function useWidthCssVar(
  ref: RefObject<HTMLElement | null>,
  name: string,
  enabled: boolean
) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;
    const update = () => el.style.setProperty(name, `${el.clientWidth}px`);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => {
      observer.disconnect();
      el.style.removeProperty(name);
    };
  }, [ref, name, enabled]);
}
