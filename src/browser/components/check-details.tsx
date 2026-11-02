import { useEffect, useState } from "react";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Clock,
  ExternalLink,
  Info,
  Loader2,
  MinusCircle,
  RotateCw,
  XCircle,
} from "lucide-react";
import { cn } from "../cn";
import { Markdown } from "../ui/markdown";
import {
  useGitHub,
  type CheckAnnotation,
  type CheckRun,
} from "../contexts/github";
import { usePRReviewSelector } from "../contexts/pr-review";
import { checkRunKey, commitStatusKey } from "../lib/check-rerun";

type CommitStatus = {
  state: string;
  context: string;
  description: string | null;
  target_url: string | null;
};

function CheckRunIcon({ check }: { check: CheckRun }) {
  if (check.status !== "completed") {
    return <Clock className="w-4 h-4 text-yellow-500 animate-pulse" />;
  }
  switch (check.conclusion) {
    case "success":
      return <CheckCircle2 className="w-4 h-4 text-green-500" />;
    case "failure":
    case "timed_out":
      return <XCircle className="w-4 h-4 text-red-500" />;
    case "action_required":
      return <AlertCircle className="w-4 h-4 text-orange-500" />;
    default:
      return <MinusCircle className="w-4 h-4 text-muted-foreground" />;
  }
}

function ExternalLinkButton({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-1 text-xs text-blue-400 hover:underline"
    >
      <ExternalLink className="w-3 h-3" />
      {label}
    </a>
  );
}

function RerunButton({
  check,
  onRerun,
}: {
  check: CheckRun;
  onRerun: (check: CheckRun) => Promise<void>;
}) {
  const [state, setState] = useState<"idle" | "running" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  return (
    <button
      type="button"
      disabled={state === "running"}
      title={error ?? "Re-run this check"}
      onClick={async (e) => {
        e.stopPropagation();
        setState("running");
        try {
          await onRerun(check);
          setState("idle");
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to re-run");
          setState("error");
        }
      }}
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 text-xs rounded border border-border hover:bg-muted transition-colors shrink-0",
        state === "error" && "border-red-500/50 text-red-400"
      )}
    >
      {state === "running" ? (
        <Loader2 className="w-3 h-3 animate-spin" />
      ) : (
        <RotateCw className="w-3 h-3" />
      )}
      {state === "error" ? "Retry" : "Re-run"}
    </button>
  );
}

function AnnotationList({ check }: { check: CheckRun }) {
  const github = useGitHub();
  const [annotations, setAnnotations] = useState<CheckAnnotation[] | null>(
    null
  );
  const [failed, setFailed] = useState(false);
  const owner = usePRReviewSelector((s) => s.owner);
  const repo = usePRReviewSelector((s) => s.repo);

  useEffect(() => {
    let cancelled = false;
    github
      .getCheckRunAnnotations(owner, repo, check.id)
      .then((list) => !cancelled && setAnnotations(list))
      .catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [github, owner, repo, check.id]);

  if (failed) {
    return (
      <p className="text-xs text-muted-foreground">
        Couldn't load annotations.
      </p>
    );
  }
  if (!annotations) {
    return <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />;
  }

  return (
    <div className="space-y-2">
      {annotations.map((a, i) => (
        <div
          key={i}
          className={cn(
            "border-l-2 pl-3 py-1 text-xs space-y-1",
            a.annotation_level === "failure"
              ? "border-red-500"
              : a.annotation_level === "warning"
                ? "border-yellow-500"
                : "border-blue-400"
          )}
        >
          <div className="flex items-center gap-1.5 text-muted-foreground">
            {a.annotation_level === "failure" ? (
              <XCircle className="w-3.5 h-3.5 text-red-500 shrink-0" />
            ) : a.annotation_level === "warning" ? (
              <AlertCircle className="w-3.5 h-3.5 text-yellow-500 shrink-0" />
            ) : (
              <Info className="w-3.5 h-3.5 text-blue-400 shrink-0" />
            )}
            <span className="font-mono wrap-anywhere">
              {a.path}
              {a.start_line ? `:${a.start_line}` : ""}
            </span>
          </div>
          {a.title && <p className="font-medium">{a.title}</p>}
          {a.message && (
            <p className="font-mono whitespace-pre-wrap wrap-anywhere">
              {a.message}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function CheckRunDetails({ check }: { check: CheckRun }) {
  const { title, summary, text, annotations_count } = check.output;
  const providerUrl = check.details_url;
  const githubUrl = check.html_url;
  const hasOutput = !!(title || summary || text || annotations_count);

  return (
    <div className="px-3 pb-3 pl-10 space-y-3">
      {!hasOutput && (
        <p className="text-xs text-muted-foreground">
          This check didn't report any details.
        </p>
      )}
      {title && title !== check.name && (
        <p className="text-sm font-medium">{title}</p>
      )}
      {summary && (
        <div className="text-sm max-h-96 overflow-auto">
          <Markdown>{summary}</Markdown>
        </div>
      )}
      {annotations_count > 0 && (
        <div className="space-y-2">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            Annotations
          </p>
          <AnnotationList check={check} />
        </div>
      )}
      {text && (
        <div className="text-sm max-h-96 overflow-auto">
          <Markdown>{text}</Markdown>
        </div>
      )}
      <div className="flex items-center gap-4">
        {providerUrl && (
          <ExternalLinkButton
            href={providerUrl}
            label={`View on ${check.app?.name ?? "provider"}`}
          />
        )}
        {githubUrl && githubUrl !== providerUrl && (
          <ExternalLinkButton href={githubUrl} label="View on GitHub" />
        )}
      </div>
    </div>
  );
}

export function CheckRunItem({
  check,
  expanded,
  onToggle,
  onRerun,
}: {
  check: CheckRun;
  expanded: boolean;
  onToggle: (key: string) => void;
  /** Omitted when the viewer can't write to the repository. */
  onRerun?: (check: CheckRun) => Promise<void>;
}) {
  const key = checkRunKey(check.id);
  return (
    <div data-check-key={key}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => onToggle(key)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle(key);
          }
        }}
        className="flex items-center gap-3 p-3 hover:bg-card/30 cursor-pointer"
      >
        <CheckRunIcon check={check} />
        <span className="flex-1 min-w-0 text-sm wrap-anywhere">
          {check.name}
        </span>
        {onRerun && check.status === "completed" && (
          <RerunButton check={check} onRerun={onRerun} />
        )}
        <ChevronDown
          className={cn(
            "w-4 h-4 text-muted-foreground transition-transform shrink-0",
            expanded && "rotate-180"
          )}
        />
      </div>
      {expanded && <CheckRunDetails check={check} />}
    </div>
  );
}

export function StatusItem({
  status,
  expanded,
  onToggle,
}: {
  status: CommitStatus;
  expanded: boolean;
  onToggle: (key: string) => void;
}) {
  const key = commitStatusKey(status.context);
  const icon =
    status.state === "success" ? (
      <CheckCircle2 className="w-4 h-4 text-green-500" />
    ) : status.state === "failure" || status.state === "error" ? (
      <XCircle className="w-4 h-4 text-red-500" />
    ) : (
      <Clock className="w-4 h-4 text-yellow-500 animate-pulse" />
    );

  return (
    <div data-check-key={key}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => onToggle(key)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle(key);
          }
        }}
        className="flex items-center gap-3 p-3 hover:bg-card/30 cursor-pointer"
      >
        {icon}
        <span className="flex-1 min-w-0 text-sm wrap-anywhere">
          {status.context}
        </span>
        <ChevronDown
          className={cn(
            "w-4 h-4 text-muted-foreground transition-transform shrink-0",
            expanded && "rotate-180"
          )}
        />
      </div>
      {expanded && (
        <div className="px-3 pb-3 pl-10 space-y-2">
          <p className="text-sm text-muted-foreground">
            {status.description || "This status didn't report any details."}
          </p>
          {status.target_url && (
            <ExternalLinkButton href={status.target_url} label="View details" />
          )}
        </div>
      )}
    </div>
  );
}
