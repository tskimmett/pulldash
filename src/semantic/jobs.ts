/**
 * In-memory job runner for semantic review analysis. Node-only.
 *
 * A job runs: build prompt -> provider -> extract JSON -> validate (with one
 * self-correction round-trip) -> reconcile coverage -> cache to disk.
 * Progress messages accumulate so a reconnecting SSE client can replay them.
 */

import type { AnalysisInput } from "./providers/types";
import { getProvider } from "./providers";
import {
  analysisPromptFits,
  buildAnalysisPrompt,
  buildCorrectionPrompt,
  buildMapPrompt,
  buildReducePrompt,
  extractJson,
  parseFragments,
  partitionFilesForMap,
  DEFAULT_MAX_PROMPT_CHARS,
  type DiffFragment,
} from "./prompt";
import { validateSemanticReview, type SemanticReview } from "./schema";
import { reconcileCoverage } from "./coverage";
import { writeCachedReview, writeRawOutput } from "./cache";

export type JobStatus = "running" | "done" | "error";

export interface SemanticJob {
  id: string;
  status: JobStatus;
  /** Progress log; index doubles as an SSE replay cursor. */
  progress: string[];
  result?: SemanticReview;
  warnings?: string[];
  error?: string;
  createdAt: number;
  abort: AbortController;
}

const jobs = new Map<string, SemanticJob>();
const JOB_TTL_MS = 60 * 60 * 1000;

let nextId = 1;

function pruneOldJobs() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) {
    if (job.status !== "running" && job.createdAt < cutoff) {
      jobs.delete(id);
    }
  }
}

export function getJob(id: string): SemanticJob | undefined {
  return jobs.get(id);
}

/** One analysis per PR head at a time; reuse a running job on re-request. */
export function findRunningJob(key: string): SemanticJob | undefined {
  return jobs.get(runningKeys.get(key) ?? "");
}

const runningKeys = new Map<string, string>();

export function jobKey(input: AnalysisInput): string {
  return `${input.owner}/${input.repo}#${input.number}@${input.headSha}`;
}

export function startAnalysisJob(
  providerId: string,
  input: AnalysisInput
): SemanticJob {
  pruneOldJobs();

  const key = jobKey(input);
  const existing = findRunningJob(key);
  if (existing) return existing;

  const job: SemanticJob = {
    id: `job-${nextId++}`,
    status: "running",
    progress: [],
    createdAt: Date.now(),
    abort: new AbortController(),
  };
  jobs.set(job.id, job);
  runningKeys.set(key, job.id);

  void runJob(job, providerId, input).finally(() => {
    if (runningKeys.get(key) === job.id) runningKeys.delete(key);
  });

  return job;
}

async function runJob(
  job: SemanticJob,
  providerId: string,
  input: AnalysisInput
): Promise<void> {
  const log = (message: string) => {
    // Collapse consecutive duplicates (providers emit repeated heartbeats).
    if (job.progress[job.progress.length - 1] !== message) {
      job.progress.push(message);
    }
  };

  try {
    const provider = getProvider(providerId);
    if (!provider) {
      throw new Error(`unknown provider: ${providerId}`);
    }

    log(`analyzing ${input.files.length} files with ${provider.displayName}`);
    let budget = provider.promptBudgetChars ?? DEFAULT_MAX_PROMPT_CHARS;
    const runOptions = { onProgress: log, signal: job.abort.signal };

    // Small PRs go through a single prompt with the full diff inline. PRs
    // whose diff exceeds the provider's context budget are map-reduced:
    // each diff section is annotated with semantic fragments, then a final
    // pass organizes all fragments into cohorts/layers.
    let fragments: DiffFragment[] | null = null;
    let prompt: string;
    if (analysisPromptFits(input, budget)) {
      prompt = buildAnalysisPrompt(input, budget);
    } else {
      fragments = await runMapPhase(input, budget, provider, runOptions, log);
      log(
        `organizing ${fragments.length} fragments into a review guide with ${provider.displayName}`
      );
      prompt = buildReducePrompt(input, fragments);
    }

    // Char budgets are estimates of the provider's token window; if the
    // provider still rejects the prompt as too long, shrink and retry.
    const runShrinkable = async (
      build: (prompt: string) => string
    ): Promise<string> => {
      for (;;) {
        try {
          return await provider.run(build(prompt), runOptions);
        } catch (err) {
          if (!isPromptTooLong(err) || budget <= MIN_PROMPT_BUDGET_CHARS) {
            throw err;
          }
          budget = Math.max(MIN_PROMPT_BUDGET_CHARS, Math.floor(budget / 2));
          if (fragments) {
            // Reduce prompt overflow: shorten fragment summaries.
            const cap = Math.max(
              0,
              Math.floor(budget / Math.max(1, fragments.length) / 2)
            );
            fragments = fragments.map((f) => ({
              ...f,
              summary: f.summary.slice(0, cap),
            }));
            log(
              `prompt too long for ${provider.displayName}; retrying with shortened fragment summaries`
            );
            prompt = buildReducePrompt(input, fragments);
          } else {
            log(
              `prompt too long for ${provider.displayName}; retrying with the largest patches elided`
            );
            prompt = buildAnalysisPrompt(input, budget);
          }
        }
      }
    };

    let raw = await runShrinkable((p) => p);
    await writeRawOutput(
      input.owner,
      input.repo,
      input.number,
      input.headSha,
      raw
    );

    log("validating analysis output");
    let review = tryValidate(raw, input, provider.id);

    if (typeof review === "object" && "errors" in review) {
      // One self-correction round-trip.
      log(
        `output failed validation (${review.errors.length} errors), asking ${provider.displayName} to correct`
      );
      const previousOutput = raw;
      const errors = review.errors;
      raw = await runShrinkable((p) =>
        buildCorrectionPrompt(p, previousOutput, errors)
      );
      await writeRawOutput(
        input.owner,
        input.repo,
        input.number,
        input.headSha,
        raw
      );
      review = tryValidate(raw, input, provider.id);
      if ("errors" in review) {
        throw new Error(
          `provider output failed validation twice: ${review.errors.slice(0, 5).join("; ")}`
        );
      }
    }

    log("reconciling coverage against the diff");
    const {
      review: reconciled,
      warnings,
      uncoveredHunkCount,
    } = reconcileCoverage(review.value, input.files);
    if (uncoveredHunkCount > 0) {
      log(`${uncoveredHunkCount} hunk(s) swept into "Uncovered changes"`);
    }

    await writeCachedReview(input.owner, input.repo, input.number, reconciled);
    job.result = reconciled;
    job.warnings = warnings;
    job.status = "done";
    log("analysis complete");
  } catch (err) {
    job.status = "error";
    job.error = (err as Error).message;
    job.progress.push(`error: ${job.error}`);
  }
}

/**
 * Map phase for PRs too large for a single prompt: annotate each diff
 * section with semantic fragments for the reduce pass to organize. Sections
 * run sequentially — providers are local agents, not parallel API pools.
 */
async function runMapPhase(
  input: AnalysisInput,
  budget: number,
  provider: NonNullable<ReturnType<typeof getProvider>>,
  runOptions: { onProgress: (m: string) => void; signal: AbortSignal },
  log: (message: string) => void
): Promise<DiffFragment[]> {
  // Leave headroom for the map prompt's fixed header and PR description.
  const batches = partitionFilesForMap(input.files, Math.floor(budget * 0.6));
  log(
    `PR too large for one pass: analyzing ${batches.length} diff sections separately`
  );

  const validFiles = new Set(input.files.map((f) => f.filename));
  const fragments: DiffFragment[] = [];
  for (const [i, batch] of batches.entries()) {
    log(`analyzing section ${i + 1}/${batches.length} (${batch.length} files)`);
    const raw = await provider.run(
      buildMapPrompt(input, batch, i + 1, batches.length, budget),
      runOptions
    );
    const parsed = parseFragments(raw, validFiles);
    if (parsed.length === 0) {
      log(
        `section ${i + 1} produced no usable fragments; its hunks will appear under "Uncovered changes"`
      );
    }
    fragments.push(...parsed);
  }

  if (fragments.length === 0) {
    throw new Error("map phase produced no usable fragments");
  }
  return fragments;
}

/** Floor for the shrink-and-retry loop; below this the analysis is useless. */
const MIN_PROMPT_BUDGET_CHARS = 50_000;

function isPromptTooLong(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /prompt is too long|too many tokens|context (length|window)|exceeds? .*context|input length .*exceed/i.test(
    message
  );
}

function tryValidate(
  raw: string,
  input: AnalysisInput,
  providerId: string
): { value: SemanticReview } | { errors: string[] } {
  let parsed: unknown;
  try {
    parsed = extractJson(raw);
  } catch (err) {
    return { errors: [(err as Error).message] };
  }

  // Normalize fields the provider is prone to getting wrong before
  // structural validation: these are ours to pin, not the model's.
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const obj = parsed as Record<string, unknown>;
    obj.provider = providerId;
    obj.headSha = input.headSha;
    if (
      typeof obj.generatedAt !== "string" ||
      Number.isNaN(Date.parse(obj.generatedAt))
    ) {
      obj.generatedAt = new Date().toISOString();
    }
  }

  const result = validateSemanticReview(parsed);
  if (result.ok && result.value) {
    return { value: result.value };
  }
  return { errors: result.errors };
}
