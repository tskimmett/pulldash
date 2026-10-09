import { useEffect, type RefObject } from "react";

const MATCH = "find-match";
const ACTIVE = "find-active";

/** Offsets of every case-insensitive, non-overlapping occurrence of needle. */
export function findOccurrences(text: string, needle: string): number[] {
  if (!needle) return [];
  const haystack = text.toLocaleLowerCase();
  const result: number[] = [];
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + needle.length)
  ) {
    result.push(at);
  }
  return result;
}

/**
 * Highlights occurrences of `query` inside `[data-find-code]` elements under
 * the container using the CSS Custom Highlight API (no re-rendering). Matches
 * inside a `[data-find-active]` ancestor use the stronger "active" style.
 * Re-applies when virtualized rows mount or syntax highlighting lands.
 */
export function useFindHighlights(
  containerRef: RefObject<HTMLElement | null>,
  query: string,
  enabled: boolean
) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof CSS === "undefined" || !CSS.highlights) return;
    const needle = query.toLocaleLowerCase();
    if (!enabled || !needle) {
      CSS.highlights.delete(MATCH);
      CSS.highlights.delete(ACTIVE);
      return;
    }

    let frame = 0;
    const apply = () => {
      frame = 0;
      const matchRanges: Range[] = [];
      const activeRanges: Range[] = [];
      for (const code of container.querySelectorAll("[data-find-code]")) {
        if (code.parentElement?.closest("[data-find-code]")) continue;
        const target = code.closest("[data-find-active]")
          ? activeRanges
          : matchRanges;
        // Syntax highlighting splits a line into many text nodes, so match
        // against the concatenated text and map offsets back to nodes.
        const nodes: Text[] = [];
        const starts: number[] = [];
        let text = "";
        const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          nodes.push(node as Text);
          starts.push(text.length);
          text += node.textContent ?? "";
        }
        let index = 0;
        const locate = (offset: number, isEnd: boolean) => {
          while (
            index < nodes.length - 1 &&
            (isEnd
              ? offset > starts[index]! + nodes[index]!.length
              : offset >= starts[index]! + nodes[index]!.length)
          ) {
            index++;
          }
          return [nodes[index]!, offset - starts[index]!] as const;
        };
        for (const at of findOccurrences(text, needle)) {
          index = 0;
          const [startNode, startOffset] = locate(at, false);
          const [endNode, endOffset] = locate(at + needle.length, true);
          const range = new Range();
          range.setStart(startNode, startOffset);
          range.setEnd(endNode, endOffset);
          target.push(range);
        }
      }
      CSS.highlights.set(MATCH, new Highlight(...matchRanges));
      CSS.highlights.set(ACTIVE, new Highlight(...activeRanges));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };

    apply();
    const observer = new MutationObserver(schedule);
    observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["data-find-active"],
    });
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      CSS.highlights.delete(MATCH);
      CSS.highlights.delete(ACTIVE);
    };
  }, [containerRef, query, enabled]);
}
