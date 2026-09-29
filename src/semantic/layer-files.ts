import type { SemanticLayer, SemanticRange } from "./schema";

export interface LayerFileEntry {
  file: string;
  /** Ranges touching this file, in layer order. `ranges[0]` is the jump target. */
  ranges: SemanticRange[];
}

/**
 * Unique files of a layer in the order its ranges first visit them, skipping
 * files that are not part of the PR. Shared by the semantic sidebar tree and
 * prev/next file navigation so both walk the same sequence.
 */
export function layerFilesInOrder(
  layer: SemanticLayer,
  presentFiles: ReadonlySet<string>
): LayerFileEntry[] {
  const byFile = new Map<string, LayerFileEntry>();
  for (const range of layer.ranges) {
    if (!presentFiles.has(range.file)) continue;
    const entry = byFile.get(range.file);
    if (entry) {
      entry.ranges.push(range);
    } else {
      byFile.set(range.file, { file: range.file, ranges: [range] });
    }
  }
  return [...byFile.values()];
}
