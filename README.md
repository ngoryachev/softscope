# SoftZoom

**SoftZoom** is a local web app that explores a codebase visually. An AI agent reads the
repository and builds multi-level, interactive diagrams of what the code actually does —
you navigate them instead of reading files, and every box and arrow links back to the
lines of code it came from.

Product concept and scope: [`docs/SPEC.md`](docs/SPEC.md). The repository name is
`softscope`; the product is SoftZoom.

## What works today

Steps 1–3 of 5 of the product cycle — **Explore**, **Zoom** and **Select** (SPEC §6.1–6.3):

- **L4** — the applications, packages and runtime boundaries of the repository.
- **L3** — the subsystems of one application, generated **when you open it** and not
  before; opening one application never analyzes its neighbours (SPEC §4.4, §6.2).
- **L2** — the entities of one subsystem: classes, services, functions, state modules,
  key types, and the calls, imports, data and events between them. Generated when you
  open the subsystem, from its own files and their direct imports only. The agent picks
  a component graph or a data-flow diagram, whichever explains the subsystem better
  (SPEC §5.3). An entity of a neighbouring subsystem that the code reaches appears as a
  **boundary node linked to its subsystem** — one click takes you there — and an entity
  shared with a neighbouring subsystem is listed as a member of both rather than drawn
  twice (SPEC §5.1).
- Breadcrumbs L4 → L3 → L2; going back up is served from memory, not regenerated.
- Clicking a node shows what it is, which subsystems it belongs to, and its code links;
  a link opens the file with the evidence lines highlighted.
- **Selection across levels** (SPEC §6.3, FR-07): click, Shift/Ctrl/Cmd+click and a
  marquee put nodes and relations into a basket that survives navigating between L4,
  L3 and L2. The **Context** panel turns the basket into the structured AI context of
  SPEC §8.4 (FR-08) — entities, merged file ranges, internal and external relations with
  their confirmed/unverified status, change limits, snapshots and warnings — expands it
  along confirmed dependencies (FR-12), and copies it as Markdown or JSON. The same
  context is served by `POST /api/context`. See
  [Selecting and building context](#selecting-and-building-context).
- Relations the agent could not confirm in the code are drawn as **unverified** rather
  than hidden, and boundary nodes are visually distinct from your code (SPEC §5.4).
- Every schema is pinned to a branch, a commit and the state of the working tree, and is
  marked **stale** as soon as the repository moves (SPEC §9.4).
- Agent results are cached on disk per (repository state, agent, level, scope):
  re-opening the same area at the same commit does not call the agent again (SPEC §9.1).
  Once you edit something, the last schema of that area keeps being shown, flagged stale
  — a working tree changes on every save, and you decide when a fresh analysis is worth
  the wait and the tokens by pressing **Regenerate**. The agent is part of the key, so
  the fake agent below never shares entries with Claude.

Not built yet (steps 4–5): AI changes with verification, and L1 behaviour views. The
graph model, the agent interface and the cache are shaped for them — a new level is a
prompt builder registered in `src/server/agent/prompts.ts`, and the context the Change
Agent will consume is exactly what the Context panel already produces.

**MVP limits:** analyzed projects must be TypeScript or JavaScript. A schema is an
interpretation of code at one moment, not documentation — and a relation SoftZoom does
not draw is not proof that none exists (SPEC §R5).

## Selecting and building context

The selection is a **basket** of nodes and relations, kept per open repository; it is
cleared when you open another one. Items from several levels can sit in it at once.

- **Click** a node or a relation: it replaces the selection *on the current level* and is
  shown in the inspector. Items you picked on other levels stay in the basket.
- **Shift+click**, **Ctrl+click** or **Cmd+click** toggles an item in or out.
- **Drag** a rectangle on the empty canvas to add the nodes it touches (relations are
  added by clicking them). Pan with the middle or right mouse button or with Space held
  down, zoom with the wheel; nodes can still be dragged to tidy the layout.
- **Double-click** a node to open it one level deeper, as before.

The **Context** panel under the inspector lists the basket grouped by level and scope,
each item with a remove button, and a **Clear** button. **Expand with dependencies**
adds the neighbours of the selected nodes of the current view — incoming, outgoing or
both — over **confirmed** relations only: an unverified relation is not a fact to expand
along (SPEC §5.4). Below that the panel shows what the selection amounts to:

- **Size** — how many files and lines of evidence the selection covers.
- **Files** — every file with its line ranges, merged so nothing is listed twice;
  clicking a range opens the file with those lines highlighted.
- **Internal relations** (both ends selected) and **external relations** (one end
  selected), each marked **confirmed** or **unverified** with the reason.
- **Change limits** — the paths a change may touch without widening the scope.
- **Warnings** — items whose view was generated against another repository state than
  the one on disk, a basket mixing views of different states, and ids whose view is not
  loaded or that are no longer in it. Nothing is silently dropped.

**Copy as Markdown** and **Copy as JSON** put the context on the clipboard, ready to
paste into a chat with an AI; when the clipboard is unavailable the text appears in a
box to copy from. The context contains paths and line ranges, never file contents.

The server builds the same context from the views it has already produced:

```bash
curl -s http://127.0.0.1:4319/api/context \
  -H 'content-type: application/json' \
  -d '{"nodeIds":["L4:root/app","L3:L4:root/app/logging"],"edgeIds":[],"task":"add a request id"}'
# …?format=markdown returns text/markdown instead of JSON
```

It never triggers a generation: an id of a view that has not been opened yet is
reported in `warnings` and left out. `400` for a malformed body, `409` when no
repository is open.

## Requirements

- **Node 22** or newer.
- **A logged-in Claude Code.** Schemas are generated by Claude through
  `@anthropic-ai/claude-agent-sdk`, which uses your local Claude Code credentials and
  your Claude subscription. There is no API key to set: run `claude` once and sign in,
  and SoftZoom picks the login up. If you are not logged in, generation fails with an
  error from the SDK and nothing is cached.
- `git` on `PATH` (optional — a directory without git works, but the snapshot and the
  cache key then fall back to a file-list fingerprint).

Analysis is **read-only**: the agent session is given `Read`, `Grep` and `Glob` as its
only tools, so no write or shell tool is offered to the model at all, and the analyzed
repository's own `CLAUDE.md`, settings and MCP servers are not loaded into the session
so they cannot steer the analysis.

## Running it

```bash
npm install
npm start -- /path/to/repository
```

The UI is built first, the server starts on `127.0.0.1:4319` (localhost only — it reads
your files and uses your Claude login), and the browser opens. The path is optional; you
can also type it into the UI.

Generating a level for a medium repository takes roughly a minute and costs tokens
against your subscription. While the agent works, the UI shows how long it has been
running and what it is reading right now (the files it opens, the patterns it searches
for), and a **Cancel** button stops it: nothing is cached for a cancelled generation and
the previous view stays on screen. The result of a finished generation is cached, so the
second visit is instant.

### Development

```bash
npm run dev:server   # API on 127.0.0.1:4319, restarts on change
npm run dev:web      # Vite dev server with HMR, proxies /api to the server
npm test             # vitest — never calls Claude, the agent is faked
npm run typecheck    # tsc -b across shared, server, web and tests
```

To work on the UI without spending tokens, run the server with
`SOFTSCOPE_FAKE_AGENT=1`: a stand-in agent derives a clickable graph from the repository
index alone. It marks every relation unverified, because it read no code.

### Environment variables

| Variable               | Default                | Meaning                                              |
| ---------------------- | ---------------------- | ---------------------------------------------------- |
| `SOFTSCOPE_PORT`       | `4319`                 | Port on `127.0.0.1`.                                 |
| `SOFTSCOPE_CACHE_DIR`  | `~/.softscope/cache`   | Where agent results are cached.                      |
| `SOFTSCOPE_MODEL`      | the Claude Code default | Model for the analysis agent.                        |
| `SOFTSCOPE_FAKE_AGENT` | unset                  | `1` replaces Claude with the index-derived fake.      |
| `SOFTSCOPE_NO_OPEN`    | unset                  | `1` does not open the browser on start.              |

The cache lives outside the analyzed repository and SoftZoom never writes into the
repository it is looking at. Delete `~/.softscope/cache` to drop every cached schema.

## Layout

```
src/shared/     graph model, agent reply contract, HTTP types — used by server, UI and tests
src/server/
  indexer/      cheap, LLM-free index: file list, packages, tsconfig paths, import graph
  agent/        SchemaAgent interface, the claude-agent-sdk implementation, prompts, fake
  validation/   evidence checking: files and line ranges must exist in the repository
  cache/        disk cache keyed by (repository state, agent, level, scope)
  session.ts    one open repository: cache -> agent -> validation, lazy per scope
  http/         the local API
src/web/        React + Vite UI, React Flow canvas with a dagre layout
test/           vitest suite, with a small fixture repository under test/fixtures/
```

The index is deliberately not a schema: it is fast, cheap input the agent starts from
(SPEC §4.4). The schema itself is the agent's work, and every element of it is validated
against the real files before the UI sees it — a node whose evidence does not resolve is
dropped, and an edge that loses its evidence is demoted to `unverified`.
