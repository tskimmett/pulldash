/**
 * Defense-in-depth filter for GitHub-rendered HTML (`body_html`). GitHub
 * sanitizes it server-side; this keeps a slip there from running script on
 * our origin, where the user's token lives.
 */

const BLOCKED_TAGS = new Set([
  "script",
  "style",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "base",
  "link",
  "meta",
  "noscript",
  "template",
  "foreignobject",
]);

const URL_ATTRIBUTES = new Set([
  "href",
  "src",
  "xlink:href",
  "action",
  "formaction",
  "poster",
  "background",
  "cite",
  "data",
]);

const SAFE_URL_RE = /^(https?:|mailto:|#|\/|\.{0,2}\/|[^:]*$)/i;

export function isAllowedHtmlTag(tag: string): boolean {
  return !BLOCKED_TAGS.has(tag.toLowerCase());
}

export function isAllowedHtmlAttribute(name: string, value: string): boolean {
  const lower = name.toLowerCase();
  if (lower.startsWith("on")) return false;
  if (lower === "srcset") {
    return value
      .split(",")
      .every((candidate) => SAFE_URL_RE.test(candidate.trim()));
  }
  if (URL_ATTRIBUTES.has(lower)) {
    // Browsers ignore control chars and whitespace inside URL schemes.
    return SAFE_URL_RE.test(value.replace(/[\u0000- ]/g, ""));
  }
  return true;
}
