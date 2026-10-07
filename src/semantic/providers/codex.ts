/**
 * Codex provider - runs the analysis through the Codex TypeScript SDK, which
 * bundles the `codex` CLI and rides the user's ChatGPT login (no API key
 * handling in better pr).
 *
 * Node-only. Import lazily from API routes so browser bundles never
 * pull in the SDK.
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { SemanticProvider, ProviderRunOptions } from "./types";
import { agentEnv, codexMcpServerNames, withScratchDir } from "./sandbox";

const CODEX_MODEL = "gpt-6-luna";

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

    options.onProgress(`starting Codex agent (${CODEX_MODEL})`);
    return withScratchDir(async (workingDirectory) => {
      // Pure analysis over an inlined diff: no shell (the read-only sandbox
      // still allows reading any local file), no MCP servers, no network.
      const codex = new Codex({
        env: agentEnv(process.env, ["OPENAI_", "CODEX_"]),
        config: {
          features: {
            shell_tool: false,
            unified_exec: false,
            apps: false,
            plugins: false,
            browser_use: false,
            computer_use: false,
            image_generation: false,
            multi_agent: false,
            multi_agent_v2: false,
            code_mode_host: false,
            sleep_tool: false,
            goals: false,
          },
          mcp_servers: Object.fromEntries(
            codexMcpServerNames().map((name) => [name, { enabled: false }])
          ),
        },
      });
      const thread = codex.startThread({
        model: CODEX_MODEL,
        sandboxMode: "read-only",
        workingDirectory,
        skipGitRepoCheck: true,
        networkAccessEnabled: false,
        webSearchMode: "disabled",
        approvalPolicy: "never",
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
    });
  },
};
