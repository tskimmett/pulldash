const MARKDOWN_EXTENSIONS = /\.(md|markdown|mdown|mkd|mkdn)$/i;

/** Whether a PR file is markdown that can be shown as a rendered preview. */
export function isMarkdownFile(filename: string): boolean {
  return MARKDOWN_EXTENSIONS.test(filename);
}
