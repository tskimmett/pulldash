/**
 * Codex provider - shells out to the `codex` CLI, riding the user's ChatGPT
 * subscription auth. Node-only; import lazily from API routes.
 */

import { spawn } from "child_process";
import type { SemanticProvider, ProviderRunOptions } from "./types";

function which(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(process.platform === "win32" ? "where" : "which", [bin]);
    proc.on("error", () => resolve(false));
    proc.on("close", (code) => resolve(code === 0));
  });
}

export const codexProvider: SemanticProvider = {
  id: "codex",
  displayName: "Codex",

  async available(): Promise<boolean> {
    try {
      return await which("codex");
    } catch {
      return false;
    }
  },

  run(prompt: string, options: ProviderRunOptions): Promise<string> {
    return new Promise((resolve, reject) => {
      options.onProgress("starting Codex agent");
      // Read-only sandbox; prompt on stdin ("-") to avoid argv size limits.
      const proc = spawn(
        "codex",
        ["exec", "--skip-git-repo-check", "--sandbox", "read-only", "-"],
        { stdio: ["pipe", "pipe", "pipe"] }
      );

      let stdout = "";
      let stderr = "";
      let progressBytes = 0;

      const onAbort = () => proc.kill("SIGTERM");
      options.signal.addEventListener("abort", onAbort, { once: true });

      proc.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
        progressBytes += chunk.length;
        if (progressBytes > 4096) {
          progressBytes = 0;
          options.onProgress("Codex is analyzing the diff");
        }
      });
      proc.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      proc.on("error", (err) => {
        options.signal.removeEventListener("abort", onAbort);
        reject(new Error(`failed to spawn codex: ${err.message}`));
      });
      proc.on("close", (code) => {
        options.signal.removeEventListener("abort", onAbort);
        if (options.signal.aborted) {
          reject(new Error("analysis aborted"));
        } else if (code !== 0) {
          reject(
            new Error(
              `codex exited with code ${code}: ${stderr.slice(-2000) || stdout.slice(-2000)}`
            )
          );
        } else if (!stdout.trim()) {
          reject(new Error("Codex produced no output"));
        } else {
          resolve(stdout);
        }
      });

      proc.stdin.write(prompt);
      proc.stdin.end();
    });
  },
};
