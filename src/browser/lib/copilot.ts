/** The single login we show for Copilot's code review bot. */
export const COPILOT_LOGIN = "Copilot";
/** REST login for Copilot's reviews; also the login the API accepts to request it. */
export const COPILOT_REVIEWER_BOT_LOGIN = "copilot-pull-request-reviewer[bot]";

// REST uses the `[bot]` suffix, GraphQL drops it, `requested_reviewers` says "Copilot".
const COPILOT_ALIASES = new Set([
  COPILOT_REVIEWER_BOT_LOGIN,
  "copilot-pull-request-reviewer",
]);

/**
 * Rewrite Copilot reviewer logins to "Copilot" in place, so every view of a
 * GitHub response agrees on one name. Runs on responses we already have.
 */
export function normalizeCopilotLogins(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  if (Array.isArray(value)) {
    for (const item of value) normalizeCopilotLogins(item);
    return;
  }
  const record = value as Record<string, unknown>;
  for (const key in record) {
    const child = record[key];
    if (key === "login") {
      if (typeof child === "string" && COPILOT_ALIASES.has(child)) {
        record[key] = COPILOT_LOGIN;
      }
    } else {
      normalizeCopilotLogins(child);
    }
  }
}

/** Map a displayed login back to one the REST API accepts (requests, /users). */
export function toApiLogin(login: string): string {
  return login === COPILOT_LOGIN ? COPILOT_REVIEWER_BOT_LOGIN : login;
}
