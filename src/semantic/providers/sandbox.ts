/**
 * Isolation helpers for agent providers. PR content is attacker-controlled,
 * so agents run without tools, user settings, or MCP servers, in an empty
 * scratch directory, with only the environment they need to authenticate.
 *
 * Node-only. Import lazily from API routes.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

/** Variables any agent process needs to start, find its login, and reach its API. */
const BASE_ENV_KEYS = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "SYSTEMROOT",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
]);

/**
 * Filter `source` down to the base variables plus any whose name starts with
 * one of `prefixes` (e.g. the provider's own credentials/config).
 */
export function agentEnv(
  source: Record<string, string | undefined>,
  prefixes: string[]
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (BASE_ENV_KEYS.has(upper) || prefixes.some((p) => upper.startsWith(p))) {
      env[key] = value;
    }
  }
  return env;
}

/** Run `fn` with a fresh empty directory as the agent's working directory. */
export async function withScratchDir<T>(
  fn: (dir: string) => Promise<T>
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "better-pr-agent-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Names of MCP servers in the user's Codex config. Codex has no flag to skip
 * user config from the SDK, so the provider disables each one by name.
 */
export function codexMcpServerNames(): string[] {
  const codexHome = process.env.CODEX_HOME || join(homedir(), ".codex");
  const configPath = join(codexHome, "config.toml");
  if (!existsSync(configPath)) return [];
  try {
    const config = Bun.TOML.parse(readFileSync(configPath, "utf-8")) as {
      mcp_servers?: Record<string, unknown>;
    };
    return Object.keys(config.mcp_servers ?? {});
  } catch {
    return [];
  }
}
