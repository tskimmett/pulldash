# Pulldash (team fork)

A fast, keyboard-driven PR review UI. It runs entirely in the browser and talks to GitHub's API directly, and a small local Node server serves the app and the optional AI review feature.

This is our fork of [coder/pulldash](https://github.com/coder/pulldash). It adds:

- Personal access token (PAT) sign-in
- Commit-range selection in the changes picker
- **Semantic review**: an AI-generated walkthrough of a PR, run by a coding agent on your own machine
- Light/dark/system theme

## Quick start

Requires [Bun](https://bun.sh).

```bash
git clone git@github.com:tskimmett/pulldash.git
cd pulldash
bun install
bun start
```

Open http://localhost:3002. Set `PORT` to use a different port.

`bun start` builds the browser bundle once and starts the server. To update: `git pull && bun install && bun start`.

### Signing in

Sign in with a **personal access token**. Create one at GitHub → Settings → Developer settings. It needs `repo` scope to read private repos and to comment or submit reviews. The token stays in your browser's `localStorage`.

## Semantic review

The AI review only appears when a supported agent is available on the machine running the server. The UI checks `/api/semantic/providers`; if no agent is found, the feature is hidden.

| Provider | Needs                                                       |
| -------- | ----------------------------------------------------------- |
| Claude   | Claude Code logged in (`~/.claude`), or `ANTHROPIC_API_KEY` |
| Codex    | Codex logged in (`~/.codex/auth.json`), or `OPENAI_API_KEY` |

- Diffs are sent to the provider you pick, so use it only on repos you're allowed to share with that provider.
- Results are cached per PR head SHA in `~/.pulldash/semantic` (override with `PULLDASH_SEMANTIC_CACHE_DIR`).
- Model IDs are set in `src/semantic/providers/claude.ts` and `codex.ts`. If your account can't use them, semantic review fails and the rest of the app is unaffected.

## Development

| Command                | What it does                                           |
| ---------------------- | ------------------------------------------------------ |
| `bun dev`              | Watch-rebuild the browser bundle and run server        |
| `bun start`            | One-off build, then run server                         |
| `bun test`             | Run tests                                              |
| `bun typecheck`        | Type check with `tsgo`                                 |
| `bun fmt`              | Format with Prettier                                   |
| `bun electron:dev`     | Run the Electron desktop app in dev mode               |
| `bun electron:package` | Build desktop installers (see `electron-builder.json`) |

Layout:

- `src/browser`: React UI, state stores, diff worker pool
- `src/api`: Hono routes shared by the Node server and Electron
- `src/semantic`: prompt building, providers, job runner, disk cache (Node only)
- `src/node`: the local server entry point
- `src/electron`: desktop shell

Performance is the priority: diffs, file lists and search are virtualized, parsing and highlighting run in web workers, and state lives outside React. See `AGENTS.md` for testing and PR conventions.

## License

[AGPL-3.0](./LICENSE)
