# Semantic Review

On-demand, AI-assisted reorganization of a PR from a flat file list into a guided,
dependency-ordered walkthrough — analogous to CodeRabbit's "Change Stack" — plus a
zero-AI **hide test files** toggle to cut initial cognitive load on large PRs.

Status: **spec / not implemented**

## Motivation

Reviewers experience a PR as an alphabetical file list and must mentally reconstruct
the author's narrative before evaluating correctness. On large (often AI-generated)
PRs, that reconstruction is the bottleneck. Pulldash already has the fast,
keyboard-driven review shell; this adds the semantic layer on top.

## Concepts

- **Cohort** — an independent, logically related group of change *hunks*
  ("the auth refactor", "the new endpoint", "config plumbing"). Grouping is
  **hunk-level**: one file's hunks can belong to different cohorts.
- **Layer** — an ordered reading step within a cohort. Layers are dependency-ordered:
  foundational changes (types, data shapes, contracts) before consumers/call sites,
  then tests. Each layer anchors to one or more **ranges**.
- **Range** — a contiguous span of changed lines in one file (`file`, `side`,
  `startLine`, `endLine`) with a plain-language summary.
- **Diagram** — an optional Mermaid diagram (sequence / state / ER) attached to a
  layer, generated only when the change warrants a visual.

## User experience

### Hide test files (independent of AI)

- Toggle in the file tree header (near the existing "hide viewed" control):
  **Hide tests**.
- Classification is heuristic path matching (`*_test.*`, `*.test.*`, `*.spec.*`,
  `__tests__/`, `__mocks__/`, `testdata/`, `test/`, `tests/`, `spec/`,
  `*_snapshot*`, `.snap`), implemented as a pure function with unit tests.
- Hidden test files are removed from the tree, `j`/`k` navigation, and search
  results, with a count indicator ("12 test files hidden"); toggling back is one
  click / keypress. Preference persists globally (localStorage), not per PR.

### Semantic review mode

- A **Semantic review** button appears in the PR header when at least one local
  provider is available (see Availability). Clicking it:
  1. Checks the disk cache for `(repo, pr, headSha)`. Cache hit → open the mode
     instantly.
  2. Otherwise starts an analysis job on the local server and streams progress
     ("collecting diff", "provider running", elapsed time). Analysis of a large PR
     can take minutes; the job continues if the user navigates away.
- Semantic mode is a **view mode of the existing PR review page**, not a separate
  UI. It reuses the diff renderer, comment flows, virtualization, and keyboard model.
  - **Left panel**: cohort → layer tree (replaces the file tree while in the mode;
    a toggle switches back to Files view at any time).
  - **Center**: the existing diff view scoped to the current layer — only hunks
    intersecting the layer's ranges are shown, grouped under their file headers.
    Commenting, line selection, and expansion work exactly as in file view.
  - **Layer summary**: the layer title, summary, and optional diagram render above
    the scoped diff.
  - **Keyboard**: `j`/`k` move between layers (matching file navigation in file
    view); arrows move between lines as today.
- **Reviewed tracking**: layers can be marked reviewed (`v`, same as files).
  A file whose every range is inside reviewed layers is marked viewed in the
  normal file view (and synced to GitHub's viewed state as today).
- **Staleness**: results are keyed to the head SHA. If the PR receives new commits,
  the mode shows an "out of date — re-analyze" banner; the stale result remains
  readable.

### Failure behavior

Invalid provider output, provider crash, or timeout → a clear error state with a
retry button. Never a broken half-view. Raw provider output is kept on disk next to
the cache entry for debugging.

## Architecture

```
Browser (PRReviewStore)                Local server (Hono, node or electron)
────────────────────────               ─────────────────────────────────────
POST /api/semantic/analyze  ────────►  job runner ──► provider (pluggable)
  { owner, repo, number,                    │             ├─ claude (Agent SDK)
    headSha, prMeta, diff }                 │             └─ codex  (codex exec)
GET  /api/semantic/jobs/:id (SSE) ◄───  progress + result
GET  /api/semantic/result/...       ◄──  disk cache  ~/.pulldash/semantic/
GET  /api/semantic/providers        ◄──  availability detection
```

- The **browser supplies the input** (PR title/description + per-file patches it
  already fetched from GitHub). The local server never holds GitHub credentials.
- Endpoints live in the shared Hono `api` app (`src/api/`), so dev/CLI and Electron
  get them for free. On the hosted (Vercel) deployment, `/api/semantic/providers`
  returns an empty list and the browser hides the feature.

### Provider interface

```ts
interface SemanticProvider {
  id: string;                       // "claude" | "codex" | ...
  displayName: string;
  available(): Promise<boolean>;    // auth/CLI detection, cheap
  analyze(
    input: AnalysisInput,
    onProgress: (msg: string) => void,
    signal: AbortSignal,
  ): Promise<SemanticReview>;
}

interface AnalysisInput {
  owner: string; repo: string; number: number; headSha: string;
  title: string; body: string;
  files: { filename: string; status: string; patch?: string }[];
}
```

- **claude**: `@anthropic-ai/claude-agent-sdk` `query()` — rides the user's
  Claude subscription auth (no API key handling in pulldash).
- **codex**: spawns `codex exec` — rides the user's ChatGPT subscription.
- Both receive the same prompt contract and must emit JSON conforming to the
  schema below; output is validated before acceptance and the provider is asked to
  self-correct once on validation failure.
- `AnalysisInput` is deliberately abstract so a future **checkout-based** provider
  (agent explores a local clone for deeper dependency inference) can slot in
  without changing the schema or UI.
- If more than one provider is available, the analyze button offers a picker;
  the last choice is remembered.

### Output schema

```ts
interface SemanticReview {
  version: 1;
  provider: string;
  headSha: string;
  generatedAt: string;              // ISO 8601
  overview: string;                 // markdown, 2–5 sentences
  cohorts: Cohort[];
}
interface Cohort {
  id: string; title: string; summary: string;
  layers: Layer[];
}
interface Layer {
  id: string; title: string; summary: string;   // markdown
  diagram?: { kind: "sequence" | "state" | "er" | "flow"; mermaid: string };
  ranges: Range[];
}
interface Range {
  file: string;
  side: "new" | "old";              // "old" only for pure deletions
  startLine: number; endLine: number;
  summary?: string;
}
```

**Coverage invariant**: every hunk in the diff must intersect at least one range.
The validator computes uncovered hunks; any remainder is placed in an automatic
**"Uncovered changes"** cohort rather than silently dropped — the reviewer must be
able to trust that semantic mode shows the whole PR. Ranges that don't match any
actual hunk are pruned with a warning.

### Caching

- Disk: `~/.pulldash/semantic/<owner>--<repo>--<number>/<headSha>.json`
  (+ `<headSha>.raw.txt` for the unvalidated provider output).
- Keyed by head SHA, so historical revisions accumulate naturally — enabling a
  future "what changed since I last reviewed" snapshot feature.
- No TTL; entries are immutable per SHA. A `Re-analyze` action overwrites.

### Prompt contract (summary)

The provider prompt instructs the agent to:
1. Read PR title/body and the full unified diff.
2. Partition all hunks into 2–7 independent cohorts by intent.
3. Order layers within each cohort foundation-first (contracts → consumers → tests).
4. Anchor every layer to exact file/line ranges from the diff (new side line
   numbers), covering every hunk exactly once.
5. Write range/layer summaries in plain language explaining *why*, not restating
   the diff.
6. Emit a Mermaid diagram only when the layer introduces an API interaction,
   state machine, or schema relationship.
7. Output only JSON matching the schema.

Very large diffs that exceed the provider's practical context are handled v1 by
truncating context intelligently (patch bodies of lockfiles/generated files elided
first, listed by name only); a map-reduce strategy (per-chunk grouping, then merge)
is a noted future improvement.

## Non-goals (v1)

- Checkout/repo-context analysis (interface keeps the door open).
- Cross-revision diffs of semantic results ("what changed since snapshot N").
- Sharing/exporting semantic reviews.
- Semantic review on the hosted pulldash.com (requires a local agent by design).
- Author-defined manual grouping.

## Performance notes

Per AGENTS.md, performance is P1:
- Analysis runs entirely out-of-process (local server + external agent); the main
  thread only receives SSE progress strings and one JSON payload.
- Semantic mode reuses the existing parsed-diff cache, worker highlighting, and
  virtualized rendering; scoping to ranges is a filter over already-parsed hunks.
- Mermaid rendering is lazy-loaded (dynamic import) only when a layer with a
  diagram is opened, keeping it out of the main bundle.
