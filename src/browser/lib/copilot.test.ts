import { test, expect } from "bun:test";
import {
  COPILOT_LOGIN,
  COPILOT_REVIEWER_BOT_LOGIN,
  normalizeCopilotLogins,
  toApiLogin,
} from "./copilot";

test("normalizes REST and GraphQL Copilot logins, leaving others alone", () => {
  const data = {
    reviews: [
      { user: { login: COPILOT_REVIEWER_BOT_LOGIN, type: "Bot" } },
      { user: { login: "alice" } },
    ],
    data: { nodes: [{ author: { login: "copilot-pull-request-reviewer" } }] },
    body: "copilot-pull-request-reviewer[bot]",
  };

  normalizeCopilotLogins(data);

  expect(data.reviews[0]!.user.login).toBe(COPILOT_LOGIN);
  expect(data.reviews[1]!.user.login).toBe("alice");
  expect(data.data.nodes[0]!.author.login).toBe(COPILOT_LOGIN);
  expect(data.body).toBe("copilot-pull-request-reviewer[bot]");
});

test("maps Copilot back to the bot login for API calls", () => {
  expect(toApiLogin(COPILOT_LOGIN)).toBe(COPILOT_REVIEWER_BOT_LOGIN);
  expect(toApiLogin("alice")).toBe("alice");
});
