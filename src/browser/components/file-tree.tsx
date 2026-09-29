import { useMemo, useState, useRef, useCallback } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ChevronRight,
  ChevronDown,
  Check,
  Eye,
  EyeOff,
  Folder,
  FolderOpen,
  FolderCheck,
} from "lucide-react";
import { cn } from "../cn";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../ui/context-menu";
import { DiffStat, FileRow, FILE_TREE_ROW_HEIGHT } from "./file-tree-row";
import type { PullRequestFile } from "@/api/types";

interface FileTreeProps {
  files: PullRequestFile[];
  selectedFile: string | null;
  selectedFiles: Set<string>;
  viewedFiles: Set<string>;
  hideViewed: boolean;
  commentCounts: Record<string, number>;
  pendingCommentCounts?: Record<string, number>;
  onSelectFile: (filename: string) => void;
  onToggleFileSelection: (filename: string, isShiftClick: boolean) => void;
  onToggleViewed: (filename: string) => void;
  onToggleViewedMultiple: (filenames: string[]) => void;
  onMarkFolderViewed: (
    folderPath: string,
    filenames: string[],
    markAsViewed: boolean
  ) => void;
  onCopyDiff: (filename: string) => void;
  onCopyFile: (filename: string) => void;
  onCopyMainVersion: (filename: string) => void;
}

interface TreeNode {
  name: string;
  path: string;
  type: "file" | "folder";
  children?: TreeNode[];
  file?: PullRequestFile;
  /** Added/deleted line counts; for folders, summed over all descendants. */
  additions: number;
  deletions: number;
}

// Flattened item for virtualization
interface FlatItem {
  node: TreeNode;
  depth: number;
  // For folders: list of all file paths under this folder
  filesInFolder?: string[];
}

function buildTree(files: PullRequestFile[]): TreeNode[] {
  const root: Record<string, TreeNode> = {};

  for (const file of files) {
    const parts = file.filename.split("/");
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const path = parts.slice(0, i + 1).join("/");

      if (!current[part]) {
        current[part] = {
          name: part,
          path,
          type: isLast ? "file" : "folder",
          children: isLast ? undefined : {},
          file: isLast ? file : undefined,
          additions: 0,
          deletions: 0,
        } as TreeNode & { children: Record<string, TreeNode> };
      }

      // Roll the file's stats up into every ancestor folder (and itself)
      current[part].additions += file.additions ?? 0;
      current[part].deletions += file.deletions ?? 0;

      if (!isLast) {
        current = (
          current[part] as TreeNode & { children: Record<string, TreeNode> }
        ).children!;
      }
    }
  }

  function convertToArray(obj: Record<string, TreeNode>): TreeNode[] {
    return Object.values(obj)
      .map((node) => ({
        ...node,
        children: node.children
          ? convertToArray(node.children as unknown as Record<string, TreeNode>)
          : undefined,
      }))
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  }

  return convertToArray(root);
}

// Helper to collect all file paths under a folder
function collectFilesInFolder(node: TreeNode): string[] {
  if (node.type === "file") {
    return [node.path];
  }
  if (node.children) {
    return node.children.flatMap(collectFilesInFolder);
  }
  return [];
}

// Filter tree to only show non-viewed files
function filterTree(nodes: TreeNode[], viewedFiles: Set<string>): TreeNode[] {
  return nodes
    .map((node) => {
      if (node.type === "file") {
        return viewedFiles.has(node.path) ? null : node;
      }
      // For folders, recursively filter children
      const filteredChildren = node.children
        ? filterTree(node.children, viewedFiles)
        : [];
      // Only include folder if it has non-viewed children
      if (filteredChildren.length === 0) {
        return null;
      }
      return { ...node, children: filteredChildren };
    })
    .filter((node): node is TreeNode => node !== null);
}

// Flatten tree into a list of visible items based on expansion state
function flattenTree(
  nodes: TreeNode[],
  expandedFolders: Set<string>,
  depth = 0
): FlatItem[] {
  const items: FlatItem[] = [];

  for (const node of nodes) {
    if (node.type === "folder") {
      const filesInFolder = collectFilesInFolder(node);
      items.push({ node, depth, filesInFolder });

      // Only include children if folder is expanded
      if (expandedFolders.has(node.path) && node.children) {
        items.push(...flattenTree(node.children, expandedFolders, depth + 1));
      }
    } else {
      items.push({ node, depth });
    }
  }

  return items;
}

export function FileTree({
  files,
  selectedFile,
  selectedFiles,
  viewedFiles,
  hideViewed,
  commentCounts,
  pendingCommentCounts = {},
  onSelectFile,
  onToggleFileSelection,
  onToggleViewed,
  onToggleViewedMultiple,
  onMarkFolderViewed,
  onCopyDiff,
  onCopyFile,
  onCopyMainVersion,
}: FileTreeProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const tree = useMemo(() => buildTree(files), [files]);
  const filteredTree = useMemo(
    () => (hideViewed ? filterTree(tree, viewedFiles) : tree),
    [tree, hideViewed, viewedFiles]
  );

  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => {
    const folders = new Set<string>();
    for (const file of files) {
      const parts = file.filename.split("/");
      for (let i = 1; i < parts.length; i++) {
        folders.add(parts.slice(0, i).join("/"));
      }
    }
    return folders;
  });

  const toggleFolder = useCallback((path: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  // Flatten tree for virtualization
  const flatItems = useMemo(
    () => flattenTree(filteredTree, expandedFolders),
    [filteredTree, expandedFolders]
  );

  // Create index for scrolling to selected file
  const selectedIndex = useMemo(() => {
    if (!selectedFile) return -1;
    return flatItems.findIndex(
      (item) => item.node.type === "file" && item.node.path === selectedFile
    );
  }, [flatItems, selectedFile]);

  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => FILE_TREE_ROW_HEIGHT,
    overscan: 20,
  });

  // Scroll selected file into view
  const lastScrolledToRef = useRef<string | null>(null);
  if (
    selectedFile &&
    selectedIndex >= 0 &&
    lastScrolledToRef.current !== selectedFile
  ) {
    lastScrolledToRef.current = selectedFile;
    // Use requestAnimationFrame to ensure virtualizer is ready
    requestAnimationFrame(() => {
      virtualizer.scrollToIndex(selectedIndex, {
        align: "center",
        behavior: "auto",
      });
    });
  }

  const handleItemClick = useCallback(
    (item: FlatItem, e: React.MouseEvent) => {
      if (item.node.type === "file") {
        if (e.shiftKey || e.metaKey || e.ctrlKey) {
          e.preventDefault();
          onToggleFileSelection(item.node.path, e.shiftKey);
        } else {
          onSelectFile(item.node.path);
        }
      } else {
        toggleFolder(item.node.path);
      }
    },
    [onSelectFile, onToggleFileSelection, toggleFolder]
  );

  if (flatItems.length === 0) {
    return (
      <nav className="flex-1 overflow-auto py-2 themed-scrollbar">
        <div className="px-4 py-8 text-center text-sm text-muted-foreground">
          {hideViewed ? "All files reviewed!" : "No files"}
        </div>
      </nav>
    );
  }

  return (
    <nav ref={parentRef} className="flex-1 overflow-auto py-2 themed-scrollbar">
      <div
        style={{
          height: `${virtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {virtualizer.getVirtualItems().map((virtualRow) => {
          const item = flatItems[virtualRow.index];
          if (!item) return null;

          const { node, depth, filesInFolder } = item;

          if (node.type === "folder") {
            const isExpanded = expandedFolders.has(node.path);
            const viewedCount = filesInFolder
              ? filesInFolder.filter((f) => viewedFiles.has(f)).length
              : 0;
            const allViewed =
              filesInFolder && viewedCount === filesInFolder.length;

            return (
              <div
                key={node.path}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  height: `${virtualRow.size}px`,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <button
                      onClick={(e) => handleItemClick(item, e)}
                      className={cn(
                        "w-full flex items-center gap-1 px-2 text-sm hover:bg-muted/50 transition-colors",
                        "text-left h-full"
                      )}
                      style={{ paddingLeft: `${depth * 12 + 8}px` }}
                    >
                      {isExpanded ? (
                        <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      ) : (
                        <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                      )}
                      {isExpanded ? (
                        <FolderOpen className="w-4 h-4 shrink-0 text-sky-400 fill-sky-400/25" />
                      ) : (
                        <Folder className="w-4 h-4 shrink-0 text-sky-400 fill-sky-400/25" />
                      )}
                      <span className="truncate flex-1">{node.name}</span>
                      <DiffStat
                        additions={node.additions}
                        deletions={node.deletions}
                      />
                      {allViewed && (
                        <Check className="w-3 h-3 text-green-500 shrink-0" />
                      )}
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem
                      onClick={() =>
                        onMarkFolderViewed(
                          node.path,
                          filesInFolder || [],
                          !allViewed
                        )
                      }
                    >
                      {allViewed ? (
                        <>
                          <EyeOff className="w-4 h-4 mr-2" />
                          Mark all as unviewed ({filesInFolder?.length ||
                            0}{" "}
                          files)
                        </>
                      ) : (
                        <>
                          <FolderCheck className="w-4 h-4 mr-2" />
                          Mark all as viewed ({filesInFolder?.length || 0}{" "}
                          files)
                        </>
                      )}
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              </div>
            );
          }

          // File item
          const isSelected = selectedFile === node.path;
          const showMultiSelectMenu =
            selectedFiles.size > 1 && selectedFiles.has(node.path);

          return (
            <div
              key={node.path}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <FileRow
                file={node.file!}
                name={node.name}
                depth={depth}
                isSelected={isSelected}
                isMultiSelected={selectedFiles.has(node.path)}
                isViewed={viewedFiles.has(node.path)}
                commentCount={commentCounts[node.path] || 0}
                pendingCount={pendingCommentCounts[node.path] || 0}
                onClick={(e) => handleItemClick(item, e)}
                onToggleViewed={() => onToggleViewed(node.path)}
                onCopyDiff={() => onCopyDiff(node.path)}
                onCopyFile={() => onCopyFile(node.path)}
                onCopyMainVersion={() => onCopyMainVersion(node.path)}
                contextMenuOverride={
                  showMultiSelectMenu ? (
                    <ContextMenuItem
                      onClick={() => onToggleViewedMultiple([...selectedFiles])}
                    >
                      <Eye className="w-4 h-4 mr-2" />
                      Toggle viewed ({selectedFiles.size} files)
                    </ContextMenuItem>
                  ) : undefined
                }
              />
            </div>
          );
        })}
      </div>
    </nav>
  );
}
