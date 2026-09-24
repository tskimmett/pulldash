export interface PatchLine {
  type: "insert" | "delete" | "normal" | "hunk";
  content: string;
  oldLine?: number;
  newLine?: number;
}

/** Turn a GitHub file patch into display rows without fetching file contents. */
export function parsePatchLines(patch: string): PatchLine[] {
  const rows: PatchLine[] = [];
  let oldLine = 0;
  let newLine = 0;

  for (const line of patch.split("\n")) {
    if (line.startsWith("@@")) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (!match) continue;
      oldLine = Number(match[1]);
      newLine = Number(match[2]);
      rows.push({ type: "hunk", content: line });
    } else if (line.startsWith("+")) {
      rows.push({ type: "insert", content: line.slice(1), newLine: newLine++ });
    } else if (line.startsWith("-")) {
      rows.push({ type: "delete", content: line.slice(1), oldLine: oldLine++ });
    } else if (line.startsWith(" ")) {
      rows.push({
        type: "normal",
        content: line.slice(1),
        oldLine: oldLine++,
        newLine: newLine++,
      });
    }
  }

  return rows;
}
