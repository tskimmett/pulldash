import { test, expect } from "bun:test";
import { agentEnv } from "./sandbox";

test("agentEnv: keeps base and provider-prefixed variables only", () => {
  const env = agentEnv(
    {
      PATH: "/usr/bin",
      HOME: "/home/u",
      ANTHROPIC_API_KEY: "sk-ant",
      OPENAI_API_KEY: "sk-openai",
      GITHUB_TOKEN: "ghp_secret",
      AZURE_SUBSCRIPTION: "sub",
      UNSET: undefined,
    },
    ["ANTHROPIC_"]
  );
  expect(env).toEqual({
    PATH: "/usr/bin",
    HOME: "/home/u",
    ANTHROPIC_API_KEY: "sk-ant",
  });
});
