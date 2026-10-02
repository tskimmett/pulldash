import type { PRSearchResult } from "../contexts/github";

export type ParsedPRQuery =
  | { kind: "pr"; owner: string; repo: string; number: number }
  | { kind: "text"; text: string };

const URL_RE = /github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/;
const SHORTHAND_RE = /^([\w.-]+)\/([\w.-]+)(?:#|\/pull\/)(\d+)$/;

// Distinguishes a pasted PR reference (URL or owner/repo#N) from free text
export function parsePRQuery(input: string): ParsedPRQuery {
  const text = input.trim();
  const match = text.match(URL_RE) ?? text.match(SHORTHAND_RE);
  if (match) {
    return {
      kind: "pr",
      owner: match[1],
      repo: match[2],
      number: parseInt(match[3], 10),
    };
  }
  return { kind: "text", text };
}

export function extractRepoFromUrl(
  url: string
): { owner: string; repo: string } | null {
  const match = url.match(/repos\/([^/]+)\/([^/]+)/);
  if (match) {
    return { owner: match[1], repo: match[2] };
  }
  return null;
}

// Scope free text to the feed: append it to every feed query so results can
// only come from repos/modes the feed already covers.
export function buildTextSearchQueries(
  feedQueries: string[],
  text: string
): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return feedQueries.map((q) => `${q} in:title,body ${trimmed}`);
}

// Merge results from several queries, dedupe, newest first
export function mergeSearchResults(
  results: PRSearchResult[][],
  limit: number
): PRSearchResult[] {
  const seen = new Set<number>();
  const merged: PRSearchResult[] = [];
  for (const item of results.flat()) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
  }
  merged.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return merged.slice(0, limit);
}
