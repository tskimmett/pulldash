import type { ReactNode, MouseEvent } from "react";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  File,
  FileCode,
  FileEdit,
  FileMinus,
  FilePlus,
  GitBranch,
  MessageSquare,
} from "lucide-react";
import { cn } from "../cn";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "../ui/context-menu";
import type { PullRequestFile } from "@/api/types";

/** Height of every row in the file tree and the semantic sidebar tree. */
export const FILE_TREE_ROW_HEIGHT = 28;

export function getFileIcon(file: PullRequestFile) {
  switch (file.status) {
    case "added":
      return <FilePlus className="w-4 h-4 text-green-500" />;
    case "removed":
      return <FileMinus className="w-4 h-4 text-red-500" />;
    case "modified":
    case "changed":
      return <FileEdit className="w-4 h-4 text-muted-foreground" />;
    case "renamed":
      return <FileCode className="w-4 h-4 text-blue-500" />;
    default:
      return <File className="w-4 h-4 text-muted-foreground" />;
  }
}

/** Compact +N -N diff stats shown in the tree's right margin. */
export function DiffStat({
  additions,
  deletions,
}: {
  additions: number;
  deletions: number;
}) {
  if (additions === 0 && deletions === 0) return null;
  return (
    <span className="flex items-center gap-1 text-[11px] tabular-nums shrink-0 leading-none">
      {additions > 0 && <span className="text-green-500">+{additions}</span>}
      {deletions > 0 && <span className="text-red-500">−{deletions}</span>}
    </span>
  );
}

export interface FileRowProps {
  file: PullRequestFile;
  /** Display label (usually the basename). */
  name: string;
  depth: number;
  isSelected: boolean;
  isMultiSelected?: boolean;
  isViewed: boolean;
  commentCount: number;
  pendingCount: number;
  onClick: (e: MouseEvent) => void;
  onToggleViewed: () => void;
  onCopyDiff: () => void;
  onCopyFile: () => void;
  onCopyMainVersion: () => void;
  /** Replaces the default context-menu items when provided. */
  contextMenuOverride?: ReactNode;
  /** Extra badge rendered before the diff stats. */
  trailing?: ReactNode;
  title?: string;
}

/**
 * A single file row shared by the file tree and the semantic sidebar. Fills
 * its parent's height (`h-full`), so the parent decides the row box.
 */
export function FileRow({
  file,
  name,
  depth,
  isSelected,
  isMultiSelected = false,
  isViewed,
  commentCount,
  pendingCount,
  onClick,
  onToggleViewed,
  onCopyDiff,
  onCopyFile,
  onCopyMainVersion,
  contextMenuOverride,
  trailing,
  title,
}: FileRowProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          onClick={onClick}
          title={title}
          className={cn(
            "w-full flex items-center gap-1 px-2 text-sm transition-colors",
            "text-left hover:bg-muted/50 h-full",
            isSelected && "bg-muted",
            isMultiSelected && !isSelected && "bg-blue-500/20",
            isViewed && !isMultiSelected && "opacity-60"
          )}
          // Offset by the folder chevron (w-3.5 + gap-1) so file icons
          // line up with sibling folder icons
          style={{ paddingLeft: `${depth * 12 + 8 + 18}px` }}
        >
          {getFileIcon(file)}
          <span className="truncate flex-1">{name}</span>
          <div className="flex items-center gap-1.5 shrink-0">
            {trailing}
            <DiffStat
              additions={file.additions ?? 0}
              deletions={file.deletions ?? 0}
            />
            {pendingCount > 0 && (
              <span className="flex items-center gap-0.5 text-xs text-yellow-500 bg-yellow-500/20 px-1.5 py-0.5 rounded">
                {pendingCount}
              </span>
            )}
            {commentCount > 0 && (
              <span className="flex items-center gap-0.5 text-xs text-muted-foreground">
                <MessageSquare className="w-3 h-3" />
                {commentCount}
              </span>
            )}
            {isViewed && <Check className="w-3 h-3 text-green-500" />}
          </div>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {contextMenuOverride ?? (
          <>
            <ContextMenuItem onClick={onToggleViewed}>
              {isViewed ? (
                <>
                  <EyeOff className="w-4 h-4 mr-2" />
                  Mark as unviewed
                </>
              ) : (
                <>
                  <Eye className="w-4 h-4 mr-2" />
                  Mark as viewed
                </>
              )}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={onCopyDiff}>
              <Copy className="w-4 h-4 mr-2" />
              Copy diff
            </ContextMenuItem>
            <ContextMenuItem onClick={onCopyFile}>
              <FileCode className="w-4 h-4 mr-2" />
              Copy file (PR version)
            </ContextMenuItem>
            {file.status !== "added" && (
              <ContextMenuItem onClick={onCopyMainVersion}>
                <GitBranch className="w-4 h-4 mr-2" />
                Copy file (base version)
              </ContextMenuItem>
            )}
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}
