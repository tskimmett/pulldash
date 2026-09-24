/**
 * Claude provider - runs the analysis through the Claude Agent SDK, which
 * rides the user's existing Claude Code login/subscription (no API key
 * handling in pulldash).
 *
 * Node-only. Import lazily from API routes so browser/Vercel bundles never
 * pull in the SDK.
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { SemanticProvider, ProviderRunOptions } from "./types";

const CLAUDE_MODEL = "claude-opus-5-5";

export const claudeProvider: SemanticProvider = {
  id: "claude",
  displayName: "Claude",

  // Claude Code has a 200k-token window shared with its system prompt, and
  // code diffs tokenize at ~3 chars/token. Leave room for the correction
  // round-trip, which resends the prompt plus the previous output.
  promptBudgetChars: 250_000,

  async available(): Promise<boolean> {
    try {
      // The Agent SDK bundles the Claude Code binary; what actually gates it
      // is credentials. Look for a Claude Code login or an API key.
      if (process.env.ANTHROPIC_API_KEY) return true;
      const home = homedir();
      return (
        existsSync(join(home, ".claude", ".credentials.json")) ||
        existsSync(join(home, ".config", "claude", ".credentials.json")) ||
        existsSync(join(home, ".claude.json"))
      );
    } catch {
      return false;
    }
  },

  async run(prompt: string, options: ProviderRunOptions): Promise<string> {
    const { query } = await import("@anthropic-ai/claude-agent-sdk");

    options.onProgress("starting Claude agent");
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal.addEventListener("abort", onAbort, { once: true });

    let resultText = "";
    let assistantText = "";
    try {
      const stream = query({
        prompt,
        options: {
          // Pure analysis over an inlined diff: no tools needed.
          allowedTools: [],
          disallowedTools: ["Bash", "Write", "Edit"],
          maxTurns: 1,
          model: CLAUDE_MODEL,
          abortController: controller,
        },
      });

      let model: string | null = null;
      for await (const message of stream) {
        if (options.signal.aborted) break;
        const m = message as {
          type: string;
          subtype?: string;
          result?: string;
          model?: string;
          message?: { content?: Array<{ type: string; text?: string }> };
        };
        if (m.type === "system" && m.subtype === "init" && m.model) {
          model = m.model;
          options.onProgress(`starting Claude agent (${model})`);
        } else if (m.type === "assistant") {
          for (const block of m.message?.content ?? []) {
            if (block.type === "text" && block.text) {
              assistantText += block.text;
            }
          }
          options.onProgress(
            model
              ? `Claude (${model}) is analyzing the diff`
              : "Claude is analyzing the diff"
          );
        } else if (m.type === "result") {
          if (typeof m.result === "string") {
            resultText = m.result;
          }
        }
      }
    } finally {
      options.signal.removeEventListener("abort", onAbort);
    }

    const output = resultText || assistantText;
    if (!output) {
      throw new Error("Claude agent produced no output");
    }
    if (isAuthError(output)) {
      throw new Error(
        "Claude Code login has expired \u2014 run `claude login` in a terminal, then retry the analysis"
      );
    }
    return output;
  },
};

// The Agent SDK reports auth failures as a result message rather than a
// thrown error; detect them so the UI shows an actionable message.
function isAuthError(output: string): boolean {
  return /failed to authenticate|oauth session expired|please run \/login|invalid api key/i.test(
    output
  );
}
