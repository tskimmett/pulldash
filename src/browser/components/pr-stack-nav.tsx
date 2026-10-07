import {
  ChevronLeft,
  ChevronRight,
  GitPullRequest,
  Layers,
} from "lucide-react";
import { cn } from "../cn";
import { usePRStack, type PRStack } from "../contexts/github";
import { useOpenPRReviewTab } from "../contexts/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";

const STACK_STATE_COLOR: Record<PRStack["members"][number]["state"], string> = {
  open: "text-green-500",
  draft: "text-muted-foreground",
  merged: "text-purple-500",
  closed: "text-red-500",
};

// Moves between the PRs of a stack; renders nothing for unstacked PRs
export function StackNav({
  owner,
  repo,
  number,
}: {
  owner: string;
  repo: string;
  number: number;
}) {
  const stack = usePRStack(owner, repo, number);
  const openPR = useOpenPRReviewTab();
  if (!stack) return null;

  const { members, position } = stack;
  const below = members[position - 2];
  const above = members[position];
  const open = (m: PRStack["members"][number]) =>
    openPR(m.owner, m.repo, m.number, m.title);

  const stepClass =
    "p-1 rounded hover:bg-teal-500/20 disabled:opacity-30 disabled:hover:bg-transparent";

  return (
    <div className="ml-auto flex items-center shrink-0 text-teal-600 dark:text-teal-400">
      <button
        className={stepClass}
        disabled={!below}
        onClick={() => below && open(below)}
        title={below ? `Down the stack: #${below.number}` : undefined}
      >
        <ChevronLeft className="w-4 h-4" />
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            className="flex items-center gap-1.5 sm:gap-2 px-2 py-2 text-sm font-medium border-b-2 border-transparent hover:border-teal-500/50 transition-colors whitespace-nowrap"
            title="Stacked pull requests"
          >
            <Layers className="w-4 h-4" />
            <span className="hidden xs:inline sm:inline">Stack</span>
            <span className="px-1.5 py-0.5 text-xs rounded-full bg-teal-500/15 font-mono">
              {position}/{members.length}
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-[360px] max-w-[calc(100vw-1rem)]"
        >
          <DropdownMenuLabel className="text-xs">
            Stack, from the base branch up
          </DropdownMenuLabel>
          {members.map((m) => (
            <DropdownMenuItem
              key={m.number}
              onSelect={() => open(m)}
              className={cn(
                "gap-2 text-xs",
                m.number === number && "bg-accent font-medium"
              )}
            >
              <GitPullRequest
                className={cn(
                  "w-3.5 h-3.5 shrink-0",
                  STACK_STATE_COLOR[m.state]
                )}
              />
              <span className="truncate flex-1">{m.title}</span>
              <span className="text-muted-foreground shrink-0">
                #{m.number}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <button
        className={stepClass}
        disabled={!above}
        onClick={() => above && open(above)}
        title={above ? `Up the stack: #${above.number}` : undefined}
      >
        <ChevronRight className="w-4 h-4" />
      </button>
    </div>
  );
}
