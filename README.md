# better pr

A fast, keyboard-driven PR review UI.

## Setup

Requires [Bun](https://bun.sh).

```bash
git clone git@github.com:tskimmett/pulldash.git better-pr
cd better-pr
bun install
bun start
```

Open http://localhost:3002 (set `PORT` to change it). To update: `git pull && bun install && bun start`.

## Sign in

Use a **personal access token**: GitHub → Settings → Developer settings. It needs `repo` scope. The token stays in your browser's `localStorage`.

For Cognito repositories, the PAT must also have SSO configured and authorized for the Cognito organization.

## Semantic review (optional, experimental)

This feature is experimental and the results are hit-or-miss. Treat the walkthrough as a rough starting point, not a reliable summary of the PR.

The AI walkthrough appears only if an agent is available on the machine running the server: Claude Code logged in (or `ANTHROPIC_API_KEY`), or Codex logged in (or `OPENAI_API_KEY`). Diffs are sent to the provider you pick.

## Deploy

`bun run deploy` builds the app and uploads `dist/browser` to an Azure Static Web App. It needs `az login` plus `AZURE_SUBSCRIPTION`, `SWA_RESOURCE_GROUP` and `SWA_APP_NAME` (Bun reads them from `.env`). The hosted build has no server, so semantic review is unavailable there.

## License

[AGPL-3.0](./LICENSE)
