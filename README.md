# SoftZoom

**SoftZoom** is a local web app that explores a codebase visually. An AI agent reads the
repository and builds multi-level, interactive diagrams of what the code actually does —
you navigate them instead of reading files, and every box and arrow links back to the
lines of code it came from.

Product concept and scope: [`docs/SPEC.md`](docs/SPEC.md). The repository name is
`softscope`; the product is SoftZoom.

## What works today

All five steps of the product cycle — **Explore**, **Zoom**, **Select**,
**Prompt → Change → Verify** and a limited **behaviour view** (SPEC §6.1–6.5, FR-13):

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
- **L1** — the behaviour of one entity of an L2 view, generated when you open it: a
  **state machine**, a **sequence** or a **flow**, whichever explains the implementation
  best — or an honest **"not available"** with the agent's reason when none does. See
  [Behaviour views (L1)](#behaviour-views-l1).
- Breadcrumbs L4 → L3 → L2 → L1; going back up is served from memory, not regenerated.
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

- **Prompt → Change → Verify** (SPEC §6.4, §6.5, FR-09–FR-11): type an instruction over
  the basket and press **Run**. A change agent edits an **isolated copy** of your working
  tree (a git worktree with your uncommitted changes reproduced), the server re-runs the
  repository's own `typecheck`, `lint` and `test` scripts, and the **Change** panel shows
  the diff per file, which files fall **outside the selected area**, which components of
  the loaded schemas are affected, the check results, and a callout when the agent says
  a safe change **needs a wider scope**. You refine, **Apply** the patch to your tree or
  **Discard** it. After Apply the open schema is regenerated if it was affected and the
  other affected schemas get an **Update** button. See
  [Editing and verifying](#editing-and-verifying).

**MVP limits:** analyzed projects must be TypeScript or JavaScript. A schema is an
interpretation of code at one moment, not documentation — and a relation SoftZoom does
not draw is not proof that none exists (SPEC §R5).

## Behaviour views (L1)

An L2 entity whose behaviour can be shown — a function, a method, a class, a service, a
state store, a handler — is openable (the L2 agent marks it; pure types and constants are
not). Opening it generates its **L1**: the same cache → agent → validation pipeline, the
same scoping (only the files that define the entity are analyzed), the same stale
banner, progress, Cancel and Regenerate. The agent reads the entity and picks **exactly
one** of three kinds (SPEC §5.3):

- **State machine** — states with an **initial** (dot) and **final** (double border)
  marker and the **transitions** between them, each labelled with the event or condition
  that triggers it. Laid out top to bottom.
- **Sequence** — **participants** across the top with lifelines, and the **messages**
  between them top to bottom in execution order: a solid arrow with a filled head is a
  synchronous call, an open head an asynchronous one, a dashed arrow a return; a labelled
  band spans the messages of a branch or loop (`loop: for each item`, `alt: valid`).
  Participants outside the entity — a caller, a callee, a store — are dashed boundary
  participants with the evidence of the call site only.
- **Flow** — **steps** with a start, ends and **decisions**, the branch condition on the
  arrow leaving a decision.

Every state, transition, participant, message and step carries evidence and goes through
the same validation as any other level: an element whose evidence does not resolve is
dropped, a transition or message the agent could not confirm is drawn **unverified**.
On top of that the message order of a sequence is checked and repaired (duplicates, gaps
and missing numbers are renumbered in the order given and reported), and a role or arrow
style outside the known set is cleared and reported.

**Not available.** When the behaviour fits none of the three kinds, or cannot be derived
reliably from the code — dynamic dispatch, behaviour decided by runtime configuration,
too little code — the agent answers `behavior.supported: false` with a concrete reason,
and the UI shows **"Behaviour view not available for …"** with that reason, Regenerate
and the breadcrumb back. The server never fills a diagram in for it, and the answer is
cached like any other result so you do not pay twice (SPEC R1, R5). A reply that claims
"unsupported" but sends states anyway has them dropped and reported.

States, participants and messages go into the selection basket like any other node or
relation; the Context panel, `POST /api/context` and the Markdown list a sequence's
messages in execution order (`#1 caller → handler (calls, request, sync)`). An applied
change that touches the entity's file marks its L1 view affected, like the levels above.

With `SOFTSCOPE_FAKE_AGENT=1` the L1 is decided from the scope paths alone: a file whose
name contains `connection`, `state` or `machine` gets a fixed state machine (with one
transition deliberately unverified), a file under `server/` or named `http*` / `cli*` a
three-participant sequence with an async message and a return, anything else "not
available" with a reason — every element pointing at real lines of that file.

**Limits.** Static analysis only: a diagram shows what the agent could read in the
code, not what happens at runtime. One kind per entity, chosen by the agent. Nested
branches and loops are flattened to one level of grouping. And as everywhere in
SoftZoom, a transition or message that is absent from the diagram is not proof that it
does not happen (SPEC §R5).

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

## Editing and verifying

The fourth step of the cycle takes the selection basket and a short instruction and
turns them into a reviewed patch (SPEC §6.4, §6.5). Nothing touches your files until you
press Apply.

**Run.** Under the Context panel, type what should change in the selected area and press
**Run** (enabled when the basket is not empty and the repository is a git repository —
for a directory without git the button says why it is disabled). The server builds the
same context `POST /api/context` returns, with your instruction as its task, and starts a
change.

**Isolation.** The change is made in a `git worktree` of your repository, detached at
`HEAD`, created under `~/.softscope/changes/<id>` (`SOFTSCOPE_WORK_DIR` overrides the
parent). Your uncommitted state is reproduced on top: the tracked changes are applied as
a patch (`git diff HEAD --binary`) and the untracked, non-ignored files are copied. The
`node_modules` directories of the repository root and of its workspace packages are
symlinked into the worktree so the checks run without reinstalling. The live snapshot
the change started from is recorded. The server refuses to start — telling you to commit
or stash first — when the repository has unmerged paths (a merge or rebase in progress),
has no commit yet, or when your changes cannot be replayed; analyzing a subdirectory of
a repository is refused for changes too.

**The agent.** A Claude session runs in the worktree with Read, Grep, Glob, Edit, Write
and MultiEdit, plus Bash restricted to the detected check commands (`Bash(npm run
test:*)` and the like). Its prompt is the selection context with your instruction and
three rules: edit inside the selected paths (the **Change limits** of the context),
explore dependencies freely, and when a safe change requires going outside the
selection, *report* it instead of editing there (SPEC §6.4, risks R2 and R5). The
repository's own `CLAUDE.md`, settings and MCP servers are not loaded. The agent answers
with a structured report: a summary, the files it changed, the checks it ran and, when
needed, a `scopeExpansion` with the reason and the paths that would have to join the
selection.

**Checks.** The server reads the worktree's root `package.json` and runs its
`typecheck`, `lint` and `test` scripts itself after the agent finishes (runner from the
lockfile: `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, else npm), ten minutes per check,
and keeps the last 200 lines of combined output. The agent's own report of what it ran
is shown as information only; these results are the ones that count.

**Verify.** The Change panel shows the diff of the worktree against its recorded base
(new files included), rendered per file with added and removed lines highlighted. A file
not under any of the selected paths carries an **outside selected area** badge. The
**affected components** are the nodes of the schemas you have loaded whose evidence
files or paths intersect the changed files, grouped by schema. **Refine** runs the agent
again in the same worktree with a follow-up instruction, the previous report in hand;
the checks and the diff are recomputed. **Cancel** aborts the agent and keeps the
worktree so you can look at what it did, or discard it.

**Apply** lands the patch in your working tree with `git apply` — no commit, no staging.
You keep working while the agent runs, so a repository that moved since the change
started is normal: the patch is applied as long as `git apply --check` accepts it, and
the response says what moved (`movedSince`, `note`). It is refused, with nothing applied,
only when the check fails — the response names the conflicting files, so you can revert
your edits to them and apply again, or discard and run the change on the current state.
When a changed file lies outside the selected area, the UI asks for confirmation first
and sends `confirmOutside: true`. On success the worktree is removed. **Discard** removes the worktree (`git worktree remove --force` and prune)
and leaves nothing behind. One change is open at a time per repository; apply or discard
it before starting another.

**Schema refresh (FR-11, SPEC §9.4).** After Apply the live snapshot moves, so the
stale banner appears on every schema generated before. If the schema you are looking at
is among the affected ones it is regenerated right away; the other affected schemas you
have loaded are listed in a banner with an **Update** button each. A stale schema is
never presented as current.

The endpoints, all JSON:

```bash
# start a change over a selection (409: not a git repo, unmerged paths, or a change already open)
curl -s http://127.0.0.1:4319/api/change -H 'content-type: application/json' \
  -d '{"nodeIds":["L3:L4:root/app/logging"],"edgeIds":[],"task":"add a request id to every log line"}'
# → {"id":"3f9c1a2b"}

curl -s http://127.0.0.1:4319/api/change/3f9c1a2b            # status, result, files with hunks and outsideLimits,
                                                             # affected components, checks, startSnapshot
curl -N http://127.0.0.1:4319/api/change/3f9c1a2b/progress   # SSE: started / activity / done | error | cancelled
curl -s -X POST http://127.0.0.1:4319/api/change/3f9c1a2b/cancel
curl -s -X POST http://127.0.0.1:4319/api/change/3f9c1a2b/refine -H 'content-type: application/json' \
  -d '{"task":"also cover the error path"}'
curl -s -X POST http://127.0.0.1:4319/api/change/3f9c1a2b/apply -H 'content-type: application/json' \
  -d '{"confirmOutside":true}'                               # 409 with outsideFiles when confirmation is missing;
                                                             # 409 when the repository moved or the patch does not apply
curl -s -X POST http://127.0.0.1:4319/api/change/3f9c1a2b/discard
```

`400` for a malformed body, `404` for an unknown id, `409` when no repository is open,
`501` when the server has no change agent, `502` when the agent fails.

Two things to know: `git worktree add` writes worktree metadata into your repository's
`.git`, and the reproduced base state is committed onto the worktree's detached HEAD —
your branches are never touched; the metadata is removed again on apply or discard
(`git worktree prune` cleans up after a crash) and the base commit becomes garbage that
`git gc` collects. Your git hooks do not run for this bookkeeping, and the patches are
produced with explicit `a/` `b/` prefixes whatever your `diff.*` settings say. And the
changes live in memory: a page reload picks the open change up again (`GET /api/state`
reports `activeChangeId`), but restarting the server forgets it — the next time the
repository is opened, the worktrees a previous run left under the work directory are
removed (each worktree records the pid of the server that owns it in `<id>.owner`, so a
second running instance leaves another's drafts alone), and switching the session to
another repository discards the open change first. With `SOFTSCOPE_FAKE_AGENT=1` the change agent is
faked too: it appends a comment carrying your instruction to the first selected file that
can take one (a `package.json` is left alone), so the whole flow can be clicked through
without tokens. Ctrl+C on the server cancels an open change, which stops its running
checks, before the server exits.

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
so they cannot steer the analysis. Changes are made by a separate session in an isolated
worktree, never in your repository (see [Editing and verifying](#editing-and-verifying)).

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
index alone, down to a fixed L1 per entity (see [Behaviour views](#behaviour-views-l1)).
It marks every relation of L4–L2 unverified, because it read no code.

### Environment variables

| Variable               | Default                | Meaning                                              |
| ---------------------- | ---------------------- | ---------------------------------------------------- |
| `SOFTSCOPE_PORT`       | `4319`                 | Port on `127.0.0.1`.                                 |
| `SOFTSCOPE_CACHE_DIR`  | `~/.softscope/cache`   | Where agent results are cached.                      |
| `SOFTSCOPE_WORK_DIR`   | `~/.softscope/changes` | Where the change worktrees are created.              |
| `SOFTSCOPE_MODEL`      | the Claude Code default | Model for the analysis and change agents.            |
| `SOFTSCOPE_FAKE_AGENT` | unset                  | `1` replaces Claude with the index-derived fake (and a fake change agent). |
| `SOFTSCOPE_NO_OPEN`    | unset                  | `1` does not open the browser on start.              |

The cache and the change worktrees live outside the analyzed repository; SoftZoom writes
into the repository it is looking at only when you press Apply. Delete
`~/.softscope/cache` to drop every cached schema.

## Layout

```
src/shared/     graph model, agent reply contract, HTTP types — used by server, UI and tests
src/server/
  indexer/      cheap, LLM-free index: file list, packages, tsconfig paths, import graph
  agent/        SchemaAgent and ChangeAgent interfaces, claude-agent-sdk implementations, prompts, fakes
  change/       worktree isolation, check runner, the change manager (diff, limits, apply, discard)
  validation/   evidence checking: files and line ranges must exist in the repository
  cache/        disk cache keyed by (repository state, agent, level, scope)
  jobs.ts       running agent calls with buffered progress and cancel, shared by generation and changes
  session.ts    one open repository: cache -> agent -> validation, lazy per scope
  http/         the local API
src/web/        React + Vite UI, React Flow canvas with a dagre layout, SVG sequence canvas
test/           vitest suite, with a small fixture repository under test/fixtures/
```

The index is deliberately not a schema: it is fast, cheap input the agent starts from
(SPEC §4.4). The schema itself is the agent's work, and every element of it is validated
against the real files before the UI sees it — a node whose evidence does not resolve is
dropped, and an edge that loses its evidence is demoted to `unverified`.
