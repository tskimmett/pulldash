/**
 * Provider plugin interface for semantic review analysis.
 *
 * Providers are local agents (Claude via the Agent SDK, Codex via its CLI)
 * that ride the user's existing subscription auth. Each receives a fully
 * rendered prompt and returns raw text; JSON extraction, validation, and
 * coverage reconciliation happen in the job runner so every provider is held
 * to the same contract.
 */

export interface AnalysisInput {
  owner: string;
  repo: string;
  number: number;
  headSha: string;
  title: string;
  body: string;
  files: AnalysisFile[];
}

export interface AnalysisFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  /** Unified patch from the GitHub files API. Absent for binary files. */
  patch?: string;
}

export interface ProviderRunOptions {
  onProgress: (message: string) => void;
  signal: AbortSignal;
}

export interface SemanticProvider {
  id: string;
  displayName: string;
  /**
   * Prompt size budget in characters for this provider's context window.
   * The job runner elides the largest patches to fit. Unset means the
   * default in prompt.ts.
   */
  promptBudgetChars?: number;
  /** Cheap availability probe (auth/CLI detection). Must never throw. */
  available(): Promise<boolean>;
  /** Run the prompt and return the agent's final text output. */
  run(prompt: string, options: ProviderRunOptions): Promise<string>;
}

export interface ProviderInfo {
  id: string;
  displayName: string;
}
