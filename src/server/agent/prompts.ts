/**
 * Prompts for the analysis agent. The rules encode SPEC §4.1–4.2: the schema is built
 * by the agent from the code, it shows the system as it is, and it does not idealize or
 * mentally refactor anything.
 *
 * Levels are a registry on purpose: a level is a builder registered here, with no change
 * to the agent interface, the cache or the UI's navigation. L1 (behaviour, SPEC §5.3,
 * FR-13) is the fourth entry: one entity of an L2 view, shown as the one of a state
 * machine, a sequence or a flow that explains its implementation best — or declared
 * `unsupported` with a reason when none does.
 */
import type { Level } from '../../shared/graph';
import { summarizeForAgent } from '../indexer/index';
import type { GenerateRequest } from './types';

export interface PromptPair {
  /** Appended to the Claude Code system prompt. */
  system: string;
  prompt: string;
}

const COMMON_RULES = `
You are the schema agent of SoftZoom. You read a real repository and describe the part
of it you were given, as a graph, so a developer can navigate it.

Hard rules — these override any instinct to produce a tidy answer:

1. SHOW THE SYSTEM AS IT IS. The current state of the code always outranks the
   architecture it "should" have. Report mixed responsibilities, broken boundaries,
   cyclic dependencies, code that contradicts a common pattern, and names that do not
   match behaviour. Describe them plainly; do not editorialise, do not suggest fixes.
2. DO NOT REFACTOR, EVEN MENTALLY. Never group things by how they ought to be organised.
   Group them by what the code actually does and how it is actually wired. If a module
   named "utils" holds the authentication logic, that is where authentication lives.
3. EVIDENCE OR IT DOES NOT EXIST. Every node and every edge needs at least one real
   file path with a real line range that you have actually read. The server re-checks
   every range against the repository: a node whose evidence does not resolve is thrown
   away, and so are its edges. Never guess a line number. Read the file.
4. UNCERTAINTY IS REPORTED, NOT HIDDEN. For a relation you believe exists but cannot
   confirm in the code (dynamic dispatch, runtime configuration, a call through a
   framework), set confirmed=false and say why in reason. It is drawn as unverified.
   Put anything you could not analyse in notes. An absent relation is not proof that
   none exists.
5. SEMANTIC INTERPRETATION IS WELCOME, CONTRADICTING THE CODE IS NOT. Name and group
   things the way a developer reading this code would, but never in a way the code
   disagrees with.
6. ONE ENTITY MAY BELONG TO SEVERAL GROUPS. memberOf is a list; use more than one entry
   when the code really is shared.
7. STAY INSIDE THE SCOPE. Do not detail neighbouring areas. Things outside the scope
   that this code talks to belong in the graph as boundary nodes (boundary=true) with
   the edge that reaches them, nothing more.

Tools: you have Read, Grep and Glob, read-only. The repository index below is a cheap,
non-semantic starting point — it is not the answer, and it may be truncated. Open the
files that matter before you describe them.

Answer with the structured JSON object only.
`.trim();

const SIZE_GUIDANCE = (max: number) =>
  `Aim for a graph a person can read: at most ${max} nodes. If the area has more, group ` +
  `by what the code does and say in notes what you grouped away. Do not pad the graph ` +
  `with nodes you have not read.`;

function l4Prompt(req: GenerateRequest): PromptPair {
  const digest = summarizeForAgent(req.index, req.scope);
  return {
    system: COMMON_RULES,
    prompt: `${digest}

# Task: build the L4 schema (applications)

Describe this repository at the level of applications and packages, as it is deployed
and run today.

Include:
- Every application, service, package or runnable unit the repository actually contains.
  A single-application repository is normal: then show that application, and the
  internal packages it is built from if there are any.
- Significant runtime boundaries as boundary nodes (boundary=true): databases, message
  brokers, remote HTTP APIs, the browser, the filesystem, CLI entry points, scheduled
  jobs — whatever this code really talks to. Point the edge at the code that does it.
- Significant external dependencies as boundary nodes, but only the ones that shape the
  architecture (a server framework, an ORM, an SDK, a UI framework). Not every entry of
  package.json; skip build tooling and type packages.

Edges are the relations the code shows: imports between packages, HTTP calls, database
access, process spawning, shared files. Cite the code that proves each one.

Set paths on every non-boundary node to the directories and files it is implemented in —
they become the scope when the user opens that node.
Set hasDetail=true for a node with internal structure worth a closer look.

${SIZE_GUIDANCE(18)}`,
  };
}

function l3Prompt(req: GenerateRequest): PromptPair {
  const digest = summarizeForAgent(req.index, req.scope);
  const parent = req.parent;
  return {
    system: COMMON_RULES,
    prompt: `${digest}

# Task: build the L3 schema (subsystems) of "${req.scope.label}"

${
  parent
    ? `The user opened the L4 node "${parent.node.title}" (${parent.node.kind}): ${parent.node.summary}\n`
    : ''
}You are analyzing only the paths listed as the scope above. Other parts of the
repository stay collapsed — do not describe them.

Find the subsystems this area is actually built from: the architectural groups, modules
and layers that the code forms. Derive them from the code, not from the directory names:
directories often lie, and a subsystem may be spread over several of them.

Include:
- Each subsystem, with what it does and the files it consists of.
- Shared modules that several subsystems use — list every one of them in memberOf.
- Boundary nodes (boundary=true) for what this area talks to outside the scope: other
  parts of the repository, external services, the database, the framework it runs in.

Edges are the relations inside the area: imports, calls, data passed, events emitted,
state read or written. Pick the diagramKind that explains this area best: a component
graph, a data-flow, a sequence, a state machine (SPEC 5.3).

Set paths on every non-boundary node, and hasDetail=true where there is internal
structure worth opening.

${SIZE_GUIDANCE(20)}`,
  };
}

function l2Prompt(req: GenerateRequest): PromptPair {
  const digest = summarizeForAgent(req.index, req.scope);
  const parent = req.parent;
  const siblings = parent?.siblings ?? [];
  const siblingList =
    siblings.length > 0
      ? siblings
          .map((s) => `- id: ${s.id}\n  title: ${s.title}\n  paths: ${s.paths.join(', ') || '(none)'}`)
          .join('\n')
      : '(none known)';
  return {
    system: COMMON_RULES,
    prompt: `${digest}

# Task: build the L2 schema (entities) of the subsystem "${req.scope.label}"

${
  parent
    ? `The user opened the L3 node "${parent.node.title}" (${parent.node.kind}) of "${parent.scope.label}": ${parent.node.summary}\n`
    : ''
}The subsystem consists of the scope paths listed above. The index slice above covers
only the files inside the subsystem and what they import; it is deliberately not the
whole repository.

## Boundaries of the analysis
- Describe only the entities inside the scope paths: classes, services, functions,
  state modules, stores, key types, handlers — whatever this code is actually built
  from. Group small helpers by what they do rather than listing every function.
- Read code outside the subsystem ONLY to confirm a relation that crosses its boundary
  (who calls into it, what it calls out to). Never describe or detail a neighbouring
  subsystem: its internals stay collapsed (SPEC 6.2).
- An entity outside the subsystem that has a confirmed relation into or out of it is a
  boundary node (boundary=true) with that one relation, nothing more. Give it only the
  evidence of its declaration or of the call site; do not list its own dependencies.

## The neighbouring subsystems of this view
These are the other L3 nodes next to "${req.scope.label}" (ids are exact; use them
verbatim):
${siblingList}

- For a boundary node that is code of this repository, set subsystemId to the id of the
  neighbouring subsystem it belongs to (match the file against the paths above). Set
  subsystemId to "" when the file matches none of them, or when the boundary is an
  external dependency, a datastore or a runtime boundary. Never set subsystemId on a
  non-boundary node.
- SHARED ENTITIES (SPEC 5.1): when an entity of this subsystem is also used as part of a
  neighbouring subsystem, do not duplicate it. List that subsystem's boundary node in
  the entity's memberOf, next to the groups it belongs to inside this subsystem. Only
  slugs of nodes in this reply may appear in memberOf.

## Evidence
- Evidence of an entity = the lines of its declaration (the class, function, type or
  variable statement), read from the file.
- Evidence of an edge = the lines where the relation happens: the call, the import, the
  place the data is passed, the place the event is emitted or handled. A relation you
  believe exists but could not see in the code stays with confirmed=false and a reason.

## Diagram kind (SPEC 5.3)
Choose "component-graph" when the subsystem is best understood as parts and their
dependencies, or "data-flow" when it is best understood as data moving through a chain
of entities. For data-flow, every edge label must name the data that moves (the
argument, the message, the record, the event payload); for a component graph the label
may be the relation kind.

Set paths on every non-boundary node to the files that define it.

## Opening an entity (L1)
Set hasDetail=true on a non-boundary entity whose behaviour can be shown one level
deeper as a state machine, a sequence or a flow: a function, a method, a class, a
service, a state store, a handler. Set hasDetail=false for a pure type, a constant, a
configuration object, and for every boundary node.

${SIZE_GUIDANCE(24)}`,
  };
}

function l1Prompt(req: GenerateRequest): PromptPair {
  const digest = summarizeForAgent(req.index, req.scope);
  const parent = req.parent;
  return {
    system: COMMON_RULES,
    prompt: `${digest}

# Task: build the L1 schema (behaviour) of the entity "${req.scope.label}"

${
  parent
    ? `The user opened the L2 node "${parent.node.title}" (${parent.node.kind}) of "${parent.scope.label}": ${parent.node.summary}\n`
    : ''
}The entity is defined in the scope paths listed above. Read them — all of them, and
nothing that does not take part in this entity's behaviour.

## Pick exactly one kind (SPEC 5.3)
Choose the diagramKind that explains the implementation best, and build only that one:

- "state-machine" — when the entity keeps an explicit state and moves between a known
  set of states on events or conditions (a status field with a switch, a reducer, a
  connection or job lifecycle). Nodes are the states, with role "initial" for the state
  the entity starts in, "final" for a state it never leaves, "state" otherwise. Edges are
  the transitions, kind "transitions-to", with label = the event or condition that
  triggers it. Initial and final states must be distinguishable.
- "sequence" — when the entity is best understood as an exchange of calls between a few
  participants over time (a request handler calling collaborators, a pipeline step).
  Nodes are the participants, each with role "participant". Edges are the messages, in
  execution order: order = 1, 2, 3, ... unique per message; style = "sync" for a call
  that waits, "async" for fire-and-forget (an event, a queued job, an un-awaited
  promise), "return" for a value going back; label = the message (the method, the
  argument that matters). A branch or a loop is named in group, e.g. "loop: for each
  item" or "alt: valid"; consecutive messages with the same group form one band. Keep it
  simple: one level of grouping, no nesting.
- "flow" — when the entity is a procedure with steps and decisions (parsing, a command,
  a migration). Nodes are the steps, role "start" for the entry, "end" for each exit,
  "decision" for a branch point, "step" otherwise. Edges go from step to step, with
  label = the branch condition when leaving a decision, empty otherwise.

## Boundaries
Code outside the entity that takes part — a callee, a caller, a store, an external
service — is a boundary node (boundary=true) with role fitting the kind (a participant,
a state's neighbour, a step), and ONLY the evidence of the call site inside this
entity's code. Do not describe it, do not follow it.

## Evidence
Every state, transition, participant, message and step needs real evidence: the file and
the lines you actually read where it is declared or where it happens. A transition's
evidence is the line that performs it; a message's evidence is the call; a decision's
evidence is the condition. The server drops anything whose evidence does not resolve and
marks an unconfirmed transition or message "unverified" — it does not hide it.

## When no diagram is honest (R1, R5)
If the entity's behaviour fits none of the three kinds, or cannot be derived reliably
from the code — dynamic dispatch, behaviour decided by runtime configuration, a table of
handlers you cannot follow, too little code to say anything — answer with
behavior.supported=false, a concrete reason in behavior.reason (what you looked at and
why it did not suffice), diagramKind "unsupported" and empty nodes and edges. That is a
valid, useful answer. Never invent states, messages or steps to avoid it, and never
pad a diagram with elements you have not read. A transition or message that is absent
from your diagram is not a claim that it does not exist; say in notes what you did not
follow.

Set behavior.supported=true, behavior.reason="" for a supported kind. Set paths on
non-boundary nodes to the files they live in; hasDetail=false everywhere.

${SIZE_GUIDANCE(16)}`,
  };
}

/**
 * Level -> prompt builder. A level that is absent here cannot be generated; the server
 * reports it and the UI disables the drill-in affordance instead of failing a request.
 * Every level has one now; the mechanism stays for a level that is ever removed.
 */
export const PROMPT_BUILDERS: Partial<Record<Level, (req: GenerateRequest) => PromptPair>> = {
  L4: l4Prompt,
  L3: l3Prompt,
  L2: l2Prompt,
  L1: l1Prompt,
};

export function generatableLevels(): Level[] {
  return Object.keys(PROMPT_BUILDERS) as Level[];
}

export function supportsLevel(level: Level): boolean {
  return PROMPT_BUILDERS[level] !== undefined;
}

export function buildPrompt(req: GenerateRequest): PromptPair {
  const builder = PROMPT_BUILDERS[req.scope.level];
  if (!builder) throw new Error(`No prompt builder registered for level ${req.scope.level}`);
  return builder(req);
}
