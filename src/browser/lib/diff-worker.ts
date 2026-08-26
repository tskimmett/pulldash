/**
 * Diff Worker - Handles CPU-intensive diff parsing and syntax highlighting
 *
 * This worker processes diffs off the main thread to maintain UI responsiveness.
 */

import gitDiffParser, {
  Hunk as _Hunk,
  Change as _Change,
  DeleteChange,
  InsertChange,
} from "gitdiff-parser";
import { DefaultLinesDiffComputer } from "vscode-diff";
import { refractor } from "refractor/all";

// ============================================================================
// Types
// ============================================================================

export interface LineSegment {
  value: string;
  html: string;
  type: "insert" | "delete" | "normal";
}

interface RawLineSegment {
  value: string;
  type: "insert" | "delete" | "normal";
}

export interface DiffLine {
  type: "insert" | "delete" | "normal";
  lineNumber?: number;
  oldLineNumber?: number;
  newLineNumber?: number;
  content: LineSegment[];
}

export interface DiffHunk {
  type: "hunk";
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

export interface DiffSkipBlock {
  type: "skip";
  count: number;
  content: string;
}

export interface ParsedDiff {
  hunks: (DiffHunk | DiffSkipBlock)[];
  /**
   * Default context revealed around each gap (keyed by skip index; the
   * index one past the last skip block is the end-of-file gap). Present
   * only when the new file's content was available at parse time.
   */
  gapContext?: Record<number, { top: DiffLine[]; bottom: DiffLine[] }>;
  /** Total line count of the new file, when content was available. */
  totalNewLines?: number;
}

type ReplaceKey<T, K extends PropertyKey, V> = T extends unknown
  ? Omit<T, K> & Record<K, V>
  : never;

type Line = ReplaceKey<_Change, "content", RawLineSegment[]>;

interface Hunk extends Omit<_Hunk, "changes"> {
  type: "hunk";
  lines: Line[];
}

interface SkipBlock {
  count: number;
  type: "skip";
  content: string;
}

// ============================================================================
// Message Types
// ============================================================================

export type WorkerRequest =
  | {
      type: "parse-diff";
      id: string;
      patch: string;
      filename: string;
      previousFilename?: string;
      /** Full content of the old (base) version of the file for proper highlighting */
      oldContent?: string;
      /** Full content of the new (head) version of the file for proper highlighting */
      newContent?: string;
    }
  | {
      type: "highlight-lines";
      id: string;
      content: string;
      filename: string;
      startLine: number;
      count: number;
    };

export type WorkerResponse =
  | {
      type: "parse-diff-result";
      id: string;
      result: ParsedDiff;
    }
  | {
      type: "highlight-lines-result";
      id: string;
      result: DiffLine[];
    }
  | {
      type: "error";
      id: string;
      error: string;
    };

// ============================================================================
// Language Detection
// ============================================================================

const extToLang: Record<string, string> = {
  js: "javascript",
  jsx: "jsx",
  ts: "typescript",
  tsx: "tsx",
  mjs: "javascript",
  cjs: "javascript",
  html: "markup",
  htm: "markup",
  xml: "markup",
  svg: "markup",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  py: "python",
  pyw: "python",
  pyi: "python",
  java: "java",
  kt: "kotlin",
  scala: "scala",
  groovy: "groovy",
  c: "c",
  cpp: "cpp",
  cc: "cpp",
  cxx: "cpp",
  h: "cpp",
  hpp: "cpp",
  cs: "csharp",
  vb: "vbnet",
  fs: "fsharp",
  rs: "rust",
  go: "go",
  rb: "ruby",
  rake: "ruby",
  php: "php",
  phtml: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  fish: "bash",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "ini",
  md: "markdown",
  markdown: "markdown",
  tex: "latex",
  swift: "swift",
  m: "objectivec",
  mm: "objectivec",
  sql: "sql",
  r: "r",
  lua: "lua",
  perl: "perl",
  pl: "perl",
  dart: "dart",
  elm: "elm",
  ex: "elixir",
  exs: "elixir",
  erl: "erlang",
  clj: "clojure",
  cljs: "clojure",
  lisp: "lisp",
  hs: "haskell",
  ml: "ocaml",
  graphql: "graphql",
  proto: "protobuf",
  vim: "vim",
  zig: "zig",
};

function guessLang(filename?: string): string {
  const ext = filename?.split(".").pop()?.toLowerCase() ?? "";
  return extToLang[ext] ?? "tsx";
}

// ============================================================================
// Syntax Highlighting
// ============================================================================

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function hastToHtml(node: any): string {
  if (node.type === "text") {
    return escapeHtml(node.value);
  }
  if (node.type === "element") {
    const { tagName, properties, children } = node;
    const className = (properties.className as string[] | undefined)?.join(" ");
    const attrs = className ? ` class="${className}"` : "";
    const inner = children.map(hastToHtml).join("");
    return `<${tagName}${attrs}>${inner}</${tagName}>`;
  }
  return "";
}

function highlight(code: string, lang: string): string {
  try {
    const tree = refractor.highlight(code, lang);
    return tree.children.map(hastToHtml).join("");
  } catch {
    return escapeHtml(code);
  }
}

/**
 * Highlight an entire file and return an array of HTML strings, one per line.
 * This handles multi-line constructs (strings, comments) correctly by
 * closing and reopening tags at line boundaries.
 */
interface OpenTag {
  tagName: string;
  className?: string;
}

function highlightFileByLines(content: string, lang: string): string[] {
  if (!content) return [];

  try {
    const tree = refractor.highlight(content, lang);
    const lines: string[] = [];
    let currentLine: string[] = [];
    const openTags: OpenTag[] = [];

    function closeAllTags(): string {
      return [...openTags]
        .reverse()
        .map((t) => `</${t.tagName}>`)
        .join("");
    }

    function openAllTags(): string {
      return openTags
        .map((t) => {
          const cls = t.className ? ` class="${t.className}"` : "";
          return `<${t.tagName}${cls}>`;
        })
        .join("");
    }

    function processText(text: string) {
      const parts = text.split("\n");
      for (let i = 0; i < parts.length; i++) {
        if (i > 0) {
          // End current line with closing tags
          currentLine.push(closeAllTags());
          lines.push(currentLine.join(""));
          // Start new line with opening tags
          currentLine = [openAllTags()];
        }
        if (parts[i]) {
          currentLine.push(escapeHtml(parts[i]));
        }
      }
    }

    function walkNode(node: any) {
      if (node.type === "text") {
        processText(node.value);
      } else if (node.type === "element") {
        const { tagName, properties, children } = node;
        const className = (properties?.className as string[] | undefined)?.join(
          " "
        );
        const tag: OpenTag = { tagName, className };

        // Open tag
        const cls = className ? ` class="${className}"` : "";
        currentLine.push(`<${tagName}${cls}>`);
        openTags.push(tag);

        // Process children
        children.forEach(walkNode);

        // Close tag
        openTags.pop();
        currentLine.push(`</${tagName}>`);
      }
    }

    tree.children.forEach(walkNode);

    // Don't forget the last line
    if (currentLine.length > 0) {
      lines.push(currentLine.join(""));
    }

    return lines;
  } catch {
    // Fallback: escape each line
    return content.split("\n").map(escapeHtml);
  }
}

// ============================================================================
// Diff Parsing
// ============================================================================

const changeToLine = (change: _Change): Line => ({
  ...change,
  content: [{ value: change.content, type: "normal" }],
});

// VS Code's diff algorithm (DefaultLinesDiffComputer), used to align the
// delete/insert lines of each change block and compute character-level
// inner changes - the same output VS Code renders in its diff editor.
const linesDiffComputer = new DefaultLinesDiffComputer();

/** 0-based line index -> [startColumn, endColumn) pairs (1-based columns). */
type EmphasisRanges = Map<number, Array<[number, number]>>;

/** Split a (possibly multi-line) editor Range into per-line column ranges. */
function collectRangeEmphasis(
  map: EmphasisRanges,
  range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  },
  lines: string[]
) {
  for (let ln = range.startLineNumber; ln <= range.endLineNumber; ln++) {
    const idx = ln - 1;
    if (idx < 0 || idx >= lines.length) continue;
    const start = ln === range.startLineNumber ? range.startColumn : 1;
    const end =
      ln === range.endLineNumber ? range.endColumn : lines[idx].length + 1;
    if (end <= start) continue;
    const existing = map.get(idx);
    if (existing) {
      existing.push([start, end]);
    } else {
      map.set(idx, [[start, end]]);
    }
  }
}

/** Turn a line plus its emphasis column ranges into render segments. */
function buildSegments(
  content: string,
  ranges: Array<[number, number]> | undefined,
  emphType: "insert" | "delete"
): RawLineSegment[] {
  if (!ranges || ranges.length === 0) {
    return [{ value: content, type: "normal" }];
  }

  // Sort and merge overlapping/adjacent ranges
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) {
      last[1] = Math.max(last[1], r[1]);
    } else {
      merged.push([r[0], r[1]]);
    }
  }

  // If the emphasis covers the whole line, skip it - the row background
  // already communicates the change (matches VS Code/GitHub).
  if (
    content.length > 0 &&
    merged.length === 1 &&
    merged[0][0] <= 1 &&
    merged[0][1] >= content.length + 1
  ) {
    return [{ value: content, type: "normal" }];
  }

  const segments: RawLineSegment[] = [];
  let pos = 1;
  for (const [rawStart, rawEnd] of merged) {
    const start = Math.max(pos, Math.min(rawStart, content.length + 1));
    const end = Math.max(start, Math.min(rawEnd, content.length + 1));
    if (start > pos) {
      segments.push({
        value: content.slice(pos - 1, start - 1),
        type: "normal",
      });
    }
    if (end > start) {
      segments.push({
        value: content.slice(start - 1, end - 1),
        type: emphType,
      });
    }
    pos = end;
  }
  if (pos <= content.length) {
    segments.push({ value: content.slice(pos - 1), type: "normal" });
  }
  return segments.filter((seg) => seg.value.length > 0);
}

/**
 * Emit one change block (a run of deleted lines followed by a run of
 * inserted lines). VS Code's diff computer aligns the two sides and
 * yields the character-level inner changes used for emphasis.
 */
function emitChangeBlock(
  out: Line[],
  dels: DeleteChange[],
  adds: InsertChange[]
) {
  if (dels.length === 0 || adds.length === 0) {
    for (const d of dels) out.push(changeToLine(d));
    for (const a of adds) out.push(changeToLine(a));
    return;
  }

  const delLines = dels.map((d) => d.content);
  const addLines = adds.map((a) => a.content);
  const oldEmphasis: EmphasisRanges = new Map();
  const newEmphasis: EmphasisRanges = new Map();

  try {
    const result = linesDiffComputer.computeDiff(delLines, addLines, {
      ignoreTrimWhitespace: false,
      computeMoves: false,
      maxComputationTimeMs: 500,
    });
    for (const change of result.changes) {
      if (!change.innerChanges) continue;
      for (const inner of change.innerChanges) {
        collectRangeEmphasis(oldEmphasis, inner.originalRange, delLines);
        collectRangeEmphasis(newEmphasis, inner.modifiedRange, addLines);
      }
    }
  } catch {
    // Fall through to plain (un-emphasized) lines
  }

  dels.forEach((d, i) => {
    out.push({
      ...d,
      content: buildSegments(d.content, oldEmphasis.get(i), "delete"),
    });
  });
  adds.forEach((a, i) => {
    out.push({
      ...a,
      content: buildSegments(a.content, newEmphasis.get(i), "insert"),
    });
  });
}

/** Build a hunk's display lines: deletes then inserts per change block. */
function computeHunkLines(changes: _Change[]): Line[] {
  const out: Line[] = [];
  let dels: DeleteChange[] = [];
  let adds: InsertChange[] = [];

  const flush = () => {
    if (dels.length || adds.length) {
      emitChangeBlock(out, dels, adds);
      dels = [];
      adds = [];
    }
  };

  for (const c of changes) {
    if (c.type === "delete") {
      // A delete after inserts starts a new block
      if (adds.length) flush();
      dels.push(c);
    } else if (c.type === "insert") {
      adds.push(c);
    } else {
      flush();
      out.push(changeToLine(c));
    }
  }
  flush();
  return out;
}

const parseHunk = (hunk: _Hunk): Hunk => {
  return {
    ...hunk,
    type: "hunk",
    lines: computeHunkLines(hunk.changes),
  };
};

const HUNK_HEADER_REGEX = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/;

const extractHunkContext = (header: string): string =>
  HUNK_HEADER_REGEX.exec(header)?.[5]?.trim() ?? "";

const insertSkipBlocks = (hunks: Hunk[]): (Hunk | SkipBlock)[] => {
  const result: (Hunk | SkipBlock)[] = [];
  let lastHunkLine = 1;

  for (const hunk of hunks) {
    const distanceToLastHunk = hunk.oldStart - lastHunkLine;
    const context = extractHunkContext(hunk.content);
    if (distanceToLastHunk > 0) {
      result.push({
        count: distanceToLastHunk,
        type: "skip",
        content: context ?? hunk.content,
      });
    }
    lastHunkLine = Math.max(hunk.oldStart + hunk.oldLines, lastHunkLine);
    result.push(hunk);
  }

  return result;
};

// ============================================================================
// Main Functions
// ============================================================================

function parseDiffWithHighlighting(
  patch: string,
  filename: string,
  previousFilename?: string,
  oldContent?: string,
  newContent?: string
): ParsedDiff {
  const diffHeader = `diff --git a/${filename} b/${filename}
--- a/${previousFilename || filename}
+++ b/${filename}
${patch}`;

  const files = gitDiffParser.parse(diffHeader);
  const file = files[0];

  if (!file) {
    return { hunks: [] };
  }

  const language = guessLang(filename);
  const prevLanguage = previousFilename
    ? guessLang(previousFilename)
    : language;

  // Pre-highlight full files if content is provided
  // This ensures proper highlighting for multi-line constructs (strings, comments, etc.)
  const oldHighlightedLines = oldContent
    ? highlightFileByLines(oldContent, prevLanguage)
    : null;
  const newHighlightedLines = newContent
    ? highlightFileByLines(newContent, language)
    : null;

  const rawHunks = insertSkipBlocks(file.hunks.map((hunk) => parseHunk(hunk)));

  const hunks: (DiffHunk | DiffSkipBlock)[] = rawHunks.map((hunk) => {
    if (hunk.type === "skip") {
      return hunk as DiffSkipBlock;
    }

    return {
      type: "hunk" as const,
      oldStart: hunk.oldStart,
      newStart: hunk.newStart,
      lines: hunk.lines.map((line): DiffLine => {
        const isNormal = line.type === "normal";
        const oldNum = isNormal
          ? (line as any).oldLineNumber
          : line.type === "delete"
            ? (line as any).lineNumber
            : undefined;
        const newNum = isNormal
          ? (line as any).newLineNumber
          : line.type === "insert"
            ? (line as any).lineNumber
            : undefined;

        // For lines with a single segment (no inline diff), use pre-highlighted content
        // For lines with multiple segments (inline diff), highlight each segment
        const hasSingleSegment = line.content.length === 1;
        const singleSegmentIsNormal =
          hasSingleSegment && line.content[0].type === "normal";

        return {
          type: line.type,
          oldLineNumber: oldNum,
          newLineNumber: newNum,
          content: line.content.map((seg) => {
            let html: string;

            // Try to use pre-highlighted content for better context
            if (singleSegmentIsNormal) {
              // Use pre-highlighted line if available
              if (
                line.type === "delete" &&
                oldHighlightedLines &&
                oldNum !== undefined
              ) {
                html =
                  oldHighlightedLines[oldNum - 1] ??
                  highlight(seg.value, prevLanguage);
              } else if (
                line.type === "insert" &&
                newHighlightedLines &&
                newNum !== undefined
              ) {
                html =
                  newHighlightedLines[newNum - 1] ??
                  highlight(seg.value, language);
              } else if (
                line.type === "normal" &&
                newHighlightedLines &&
                newNum !== undefined
              ) {
                // For normal lines, prefer new file highlighting (same content in both)
                html =
                  newHighlightedLines[newNum - 1] ??
                  highlight(seg.value, language);
              } else {
                html = highlight(seg.value, language);
              }
            } else {
              // Multiple segments (inline diff) - highlight each segment individually
              // This is acceptable since inline diffs are usually small
              const segLang = seg.type === "delete" ? prevLanguage : language;
              html = highlight(seg.value, segLang);
            }

            return {
              value: seg.value,
              html,
              type: seg.type,
            };
          }),
        };
      }),
    };
  });

  // Reveal extra context around each gap by default, GitHub-style, using
  // the already-highlighted new file content (near-free at this point).
  if (newContent && newHighlightedLines) {
    const allNewLines = newContent.split("\n");
    const totalNewLines =
      allNewLines[allNewLines.length - 1] === ""
        ? allNewLines.length - 1
        : allNewLines.length;

    const makeLines = (start: number, count: number): DiffLine[] => {
      const lines: DiffLine[] = [];
      for (let i = 0; i < count; i++) {
        const lineNum = start + i;
        const value = allNewLines[lineNum - 1] ?? "";
        lines.push({
          type: "normal",
          oldLineNumber: lineNum,
          newLineNumber: lineNum,
          content: [
            {
              value,
              html:
                newHighlightedLines[lineNum - 1] ?? highlight(value, language),
              type: "normal",
            },
          ],
        });
      }
      return lines;
    };

    const gapContext: Record<number, { top: DiffLine[]; bottom: DiffLine[] }> =
      {};
    let expectedNextLine = 1;
    let skipIdx = 0;
    let seenHunk = false;

    for (const h of hunks) {
      if (h.type === "skip") {
        const start = expectedNextLine;
        const count = h.count;
        if (!seenHunk) {
          // Top-of-file gap: only lines adjacent to the first change
          gapContext[skipIdx] =
            count <= DEFAULT_GAP_CONTEXT
              ? { top: makeLines(start, count), bottom: [] }
              : {
                  top: [],
                  bottom: makeLines(
                    start + count - DEFAULT_GAP_CONTEXT,
                    DEFAULT_GAP_CONTEXT
                  ),
                };
        } else if (count <= DEFAULT_GAP_CONTEXT * 2) {
          gapContext[skipIdx] = { top: makeLines(start, count), bottom: [] };
        } else {
          gapContext[skipIdx] = {
            top: makeLines(start, DEFAULT_GAP_CONTEXT),
            bottom: makeLines(
              start + count - DEFAULT_GAP_CONTEXT,
              DEFAULT_GAP_CONTEXT
            ),
          };
        }
        expectedNextLine += count;
        skipIdx++;
      } else {
        seenHunk = true;
        let maxNewLine = h.newStart;
        for (const line of h.lines) {
          if (line.newLineNumber && line.newLineNumber > maxNewLine) {
            maxNewLine = line.newLineNumber;
          }
        }
        expectedNextLine = maxNewLine + 1;
      }
    }

    // End-of-file gap (index one past the last skip block)
    const trailingRemaining = totalNewLines - expectedNextLine + 1;
    if (seenHunk && trailingRemaining > 0) {
      gapContext[skipIdx] = {
        top: makeLines(
          expectedNextLine,
          Math.min(DEFAULT_GAP_CONTEXT, trailingRemaining)
        ),
        bottom: [],
      };
    }

    return { hunks, gapContext, totalNewLines };
  }

  return { hunks };
}

/** Lines revealed around each gap by default. */
const DEFAULT_GAP_CONTEXT = 20;

function highlightFileLines(
  content: string,
  filename: string,
  startLine: number,
  count: number
): DiffLine[] {
  const language = guessLang(filename);
  const allLines = content.split("\n");

  // Pre-highlight the entire file for proper context
  const highlightedLines = highlightFileByLines(content, language);

  const result: DiffLine[] = [];

  for (let i = 0; i < count; i++) {
    const lineNum = startLine + i;
    const lineContent = allLines[lineNum - 1] ?? "";
    // Use pre-highlighted HTML, fallback to individual highlighting
    const highlighted =
      highlightedLines[lineNum - 1] ?? highlight(lineContent, language);

    result.push({
      type: "normal",
      oldLineNumber: lineNum,
      newLineNumber: lineNum,
      content: [{ value: lineContent, html: highlighted, type: "normal" }],
    });
  }

  return result;
}

// ============================================================================
// Worker Message Handler
// ============================================================================

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const request = event.data;

  try {
    switch (request.type) {
      case "parse-diff": {
        const result = parseDiffWithHighlighting(
          request.patch,
          request.filename,
          request.previousFilename,
          request.oldContent,
          request.newContent
        );
        self.postMessage({
          type: "parse-diff-result",
          id: request.id,
          result,
        } as WorkerResponse);
        break;
      }

      case "highlight-lines": {
        const result = highlightFileLines(
          request.content,
          request.filename,
          request.startLine,
          request.count
        );
        self.postMessage({
          type: "highlight-lines-result",
          id: request.id,
          result,
        } as WorkerResponse);
        break;
      }
    }
  } catch (error) {
    self.postMessage({
      type: "error",
      id: request.id,
      error: error instanceof Error ? error.message : "Unknown error",
    } as WorkerResponse);
  }
};
