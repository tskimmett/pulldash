/**
 * Diff Worker - Handles CPU-intensive diff parsing and syntax highlighting
 *
 * This worker processes diffs off the main thread to maintain UI responsiveness.
 */

import gitDiffParser, { Hunk as _Hunk } from "gitdiff-parser";
import { computeHunkLines, type Line } from "./hunk-lines";
import { generatePatch } from "./recover-patches";
import { rebasedPatch, type RebaseResult } from "./rebase-range";
import { refractor } from "refractor/all";

// ============================================================================
// Types
// ============================================================================

export interface LineSegment {
  value: string;
  html: string;
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
      type: "generate-patch";
      id: string;
      oldContent: string;
      newContent: string;
    }
  | {
      type: "rebase-patch";
      id: string;
      baseOld: string;
      ours: string;
      baseNew: string;
      head: string;
    }
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
  | { type: "generate-patch-result"; id: string; result: string | undefined }
  | { type: "rebase-patch-result"; id: string; result: RebaseResult }
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
      case "generate-patch": {
        self.postMessage({
          type: "generate-patch-result",
          id: request.id,
          result: generatePatch(request.oldContent, request.newContent),
        } as WorkerResponse);
        break;
      }
      case "rebase-patch": {
        self.postMessage({
          type: "rebase-patch-result",
          id: request.id,
          result: rebasedPatch(
            request.baseOld,
            request.ours,
            request.baseNew,
            request.head
          ),
        } as WorkerResponse);
        break;
      }
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
