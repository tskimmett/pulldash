import { memo, useEffect, useRef, useState } from "react";

let mermaidInit: Promise<typeof import("mermaid").default> | null = null;

/** Lazy-load and initialize mermaid once (heavy dependency, ~1MB). */
function loadMermaid() {
  if (!mermaidInit) {
    mermaidInit = import("mermaid").then((m) => {
      m.default.initialize({
        startOnLoad: false,
        theme: "dark",
        securityLevel: "strict",
        fontFamily: "inherit",
      });
      return m.default;
    });
  }
  return mermaidInit;
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

  useEffect(() => {
    let cancelled = false;
    setError(false);
    loadMermaid()
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
  }, [source]);

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
