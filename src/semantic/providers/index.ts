/**
 * Provider registry. Node-only; import lazily from API routes.
 */

import type { ProviderInfo, SemanticProvider } from "./types";
import { claudeProvider } from "./claude";
import { codexProvider } from "./codex";

const PROVIDERS: SemanticProvider[] = [claudeProvider, codexProvider];

export function getProvider(id: string): SemanticProvider | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

export async function listAvailableProviders(): Promise<ProviderInfo[]> {
  const availability = await Promise.all(
    PROVIDERS.map(async (p) => ({
      provider: p,
      available: await p.available(),
    }))
  );
  return availability
    .filter((a) => a.available)
    .map((a) => ({ id: a.provider.id, displayName: a.provider.displayName }));
}
