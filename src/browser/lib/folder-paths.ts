// The folder itself plus every folder nested under it, derived from file paths
export function folderPathsUnder(
  folderPath: string,
  filenames: string[]
): string[] {
  const folders = new Set([folderPath]);
  const prefix = `${folderPath}/`;
  for (const filename of filenames) {
    if (!filename.startsWith(prefix)) continue;
    const parts = filename.split("/");
    for (let i = folderPath.split("/").length + 1; i < parts.length; i++) {
      folders.add(parts.slice(0, i).join("/"));
    }
  }
  return [...folders];
}
