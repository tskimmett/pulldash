/**
 * Codex provider - runs the analysis through the Codex TypeScript SDK, which
 * bundles the `codex` CLI and rides the user's ChatGPT login (no API key
 * handling in pulldash).
 *
 * Node-only. Import lazily from API routes so browser/Vercel bundles never
 * pull in the SDK.
 */

import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { SemanticProvider, ProviderRunOptions } from "./types";

/**
 * The SDK's events never report which model served the turn, so read the
 * user's configured default from the Codex CLI config. Best-effort: absent
 * or unparseable config just means we log without a model name.
 */
function detectCodexModel(): string | null {
  try {
    const config = readFileSync(
      join(homedir(), ".codex", "config.toml"),
      "utf8"
    );
    const match = config.match(/^model\s*=\s*"([^"]+)"/m);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

export const codexProvider: SemanticProvider = {
  id: "codex",
  displayName: "Codex",

  async available(): Promise<boolean> {
    try {
      // The SDK ships its own codex binary; what actually gates the provider
      // is credentials. Look for a ChatGPT login or an API key.
      if (process.env.OPENAI_API_KEY) return true;
      return existsSync(join(homedir(), ".codex", "auth.json"));
    } catch {
      return false;
    }
  },

  async run(prompt: string, options: ProviderRunOptions): Promise<string> {
    const { Codex } = await import("@openai/codex-sdk");

    const model = detectCodexModel();
    options.onProgress(
      model ? `starting Codex agent (${model})` : "starting Codex agent"
    );
    const thread = new Codex().startThread({
      // Pure analysis over an inlined diff: no repo or network access needed.
      sandboxMode: "read-only",
      skipGitRepoCheck: true,
    });

    const { events } = await thread.runStreamed(prompt, {
      signal: options.signal,
    });

    let finalResponse = "";
    for await (const event of events) {
      if (options.signal.aborted) break;
      if (event.type === "item.completed") {
        if (event.item.type === "agent_message") {
          finalResponse = event.item.text;
        } else if (event.item.type === "reasoning") {
          const line = event.item.text.split("\n")[0]?.trim();
          if (line) options.onProgress(line.slice(0, 200));
        }
      } else if (event.type === "turn.failed") {
        throw new Error(`Codex turn failed: ${event.error.message}`);
      } else if (event.type === "error") {
        throw new Error(`Codex error: ${event.message}`);
      }
    }

    if (options.signal.aborted) throw new Error("analysis aborted");
    if (!finalResponse.trim()) throw new Error("Codex produced no output");
    return finalResponse;
  },
};
