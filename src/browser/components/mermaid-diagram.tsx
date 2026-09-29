import { memo, useEffect, useRef, useState } from "react";
import { useResolvedTheme } from "../lib/theme";

let mermaidModule: Promise<typeof import("mermaid").default> | null = null;

/**
 * Lazy-load mermaid once (heavy dependency, ~1MB). `initialize` is re-run per
 * load so the diagram palette follows the active theme — mermaid bakes colors
 * into the rendered SVG, so the theme has to be set before every render.
 */
function loadMermaid(theme: "light" | "dark") {
  if (!mermaidModule) {
    mermaidModule = import("mermaid").then((m) => m.default);
  }
  return mermaidModule.then((mermaid) => {
    mermaid.initialize({
      startOnLoad: false,
      theme: theme === "dark" ? "dark" : "default",
      securityLevel: "strict",
      fontFamily: "inherit",
    });
    return mermaid;
  });
}

let diagramCounter = 0;

interface MermaidDiagramProps {
  /** Mermaid source text. */
  source: string;
}

/**
 * Renders a mermaid diagram. On invalid syntax (LLM output isn't guaranteed
 * valid mermaid) it falls back to showing the raw source in a code block —
 * never a broken half-view.
 */
export const MermaidDiagram = memo(function MermaidDiagram({
  source,
}: MermaidDiagramProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(false);
  const theme = useResolvedTheme();

  useEffect(() => {
    let cancelled = false;
    setError(false);
    loadMermaid(theme)
      .then(async (mermaid) => {
        const id = `semantic-diagram-${diagramCounter++}`;
        const { svg } = await mermaid.render(id, source);
        if (!cancelled && containerRef.current) {
          containerRef.current.innerHTML = svg;
        }
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [source, theme]);

  if (error) {
    return (
      <pre className="text-xs text-muted-foreground bg-muted/40 rounded-md p-2 overflow-x-auto themed-scrollbar">
        {source}
      </pre>
    );
  }

  return (
    <div
      ref={containerRef}
      className="overflow-x-auto themed-scrollbar [&_svg]:max-w-full"
    />
  );
});
