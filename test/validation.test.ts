import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateView } from '../src/server/validation/validate';
import { parseAgentGraph } from '../src/shared/agent-schema';
import { repoSnapshot } from '../src/server/indexer/git';
import { rootScope, type ScopeRef, type Snapshot } from '../src/shared/graph';
import { agentGraph, cleanupTemps, copyFixture, l1Graph } from './helpers';

afterAll(cleanupTemps);

let repo: string;
let snapshot: Snapshot;
const scope: ScopeRef = rootScope('sample-app');
const l3Scope: ScopeRef = { level: 'L3', id: 'L4:root/app', label: 'app', paths: ['src'] };
const l2Scope: ScopeRef = { level: 'L2', id: 'L3:L4:root/app/http', label: 'http', paths: ['src/server'] };

beforeAll(() => {
  repo = copyFixture();
  snapshot = repoSnapshot(repo);
});

const run = (graph: ReturnType<typeof agentGraph>, where: ScopeRef = scope) =>
  validateView({ repoPath: repo, scope: where, snapshot, raw: graph });

const lineCount = (rel: string) => readFileSync(join(repo, rel), 'utf8').trimEnd().split('\n').length;

describe('evidence validation', () => {
  it('keeps a node whose evidence points at real lines and namespaces its id per scope', () => {
    const { view, issues } = run(
      agentGraph([{ slug: 'http', evidence: [{ file: 'src/server/http.ts', startLine: 1, endLine: 3 }] }]),
    );

    expect(view.nodes).toHaveLength(1);
    expect(view.nodes[0]!.id).toBe('L4:root/http');
    expect(view.nodes[0]!.level).toBe('L4');
    expect(issues).toHaveLength(0);
  });

  it('drops a node whose evidence file does not exist', () => {
    const { view, issues } = run(
      agentGraph([{ slug: 'ghost', evidence: [{ file: 'src/does-not-exist.ts', startLine: 1, endLine: 2 }] }]),
    );

    expect(view.nodes).toHaveLength(0);
    expect(issues.map((i) => i.kind)).toEqual(['evidence-missing-file', 'node-dropped']);
  });

  it('drops evidence whose line range runs past the end of the file', () => {
    const file = 'src/util/log.ts';
    const past = lineCount(file) + 50;
    const { view, issues } = run(
      agentGraph([{ slug: 'log', evidence: [{ file, startLine: 1, endLine: past }] }]),
    );

    expect(view.nodes).toHaveLength(0);
    expect(issues[0]).toMatchObject({ kind: 'evidence-bad-range', file });
    expect(issues[0]!.message).toContain(`${lineCount(file)} lines`);
  });

  it('rejects an inverted range and a zero start line', () => {
    const file = 'src/util/log.ts';
    const { view } = run(
      agentGraph([
        { slug: 'a', evidence: [{ file, startLine: 3, endLine: 2 }] },
        { slug: 'b', evidence: [{ file, startLine: 0, endLine: 1 }] },
      ]),
    );
    expect(view.nodes).toHaveLength(0);
  });

  it('rejects a path that escapes the repository or is absolute', () => {
    const { view, issues } = run(
      agentGraph([
        { slug: 'escape', evidence: [{ file: '../../etc/passwd', startLine: 1, endLine: 1 }] },
        { slug: 'absolute', evidence: [{ file: '/etc/passwd', startLine: 1, endLine: 1 }] },
      ]),
    );

    expect(view.nodes).toHaveLength(0);
    expect(issues.filter((i) => i.kind === 'evidence-outside-repo')).toHaveLength(2);
  });

  it('keeps the valid evidence of a node and drops only the bad entries', () => {
    const { view } = run(
      agentGraph([
        {
          slug: 'mixed',
          evidence: [
            { file: 'src/missing.ts', startLine: 1, endLine: 1 },
            { file: 'src/index.ts', startLine: 1, endLine: 2 },
          ],
        },
      ]),
    );

    expect(view.nodes[0]!.evidence).toEqual([{ file: 'src/index.ts', startLine: 1, endLine: 2 }]);
  });
});

describe('edges', () => {
  it('drops an edge that points at a dropped node', () => {
    const { view, issues } = run(
      agentGraph(
        [
          { slug: 'keep', evidence: [{ file: 'src/index.ts', startLine: 1, endLine: 1 }] },
          { slug: 'gone', evidence: [{ file: 'src/nope.ts', startLine: 1, endLine: 1 }] },
        ],
        [{ from: 'keep', to: 'gone', evidence: [{ file: 'src/index.ts', startLine: 1, endLine: 1 }] }],
      ),
    );

    expect(view.nodes.map((n) => n.id)).toEqual(['L4:root/keep']);
    expect(view.edges).toHaveLength(0);
    expect(issues.some((i) => i.kind === 'edge-dropped')).toBe(true);
  });

  it('demotes an edge whose only evidence is invalid to unverified instead of hiding it', () => {
    const { view, issues } = run(
      agentGraph(
        [
          { slug: 'a', evidence: [{ file: 'src/index.ts', startLine: 1, endLine: 1 }] },
          { slug: 'b', evidence: [{ file: 'src/util/log.ts', startLine: 1, endLine: 1 }] },
        ],
        [{ from: 'a', to: 'b', kind: 'calls', evidence: [{ file: 'src/index.ts', startLine: 9999, endLine: 9999 }] }],
      ),
    );

    expect(view.edges).toHaveLength(1);
    expect(view.edges[0]).toMatchObject({ status: 'unverified', kind: 'calls', evidence: [] });
    expect(view.edges[0]!.reason).toContain('no evidence survived validation');
    expect(issues.some((i) => i.kind === 'edge-unverified')).toBe(true);
  });

  it('keeps the agent-supplied reason for a relation the agent did not confirm', () => {
    const { view } = run(
      agentGraph(
        [
          { slug: 'a', evidence: [{ file: 'src/index.ts', startLine: 1, endLine: 1 }] },
          { slug: 'b', evidence: [{ file: 'src/util/log.ts', startLine: 1, endLine: 1 }] },
        ],
        [
          {
            from: 'a',
            to: 'b',
            confirmed: false,
            reason: 'wired at runtime through configuration',
            evidence: [{ file: 'src/index.ts', startLine: 1, endLine: 1 }],
          },
        ],
      ),
    );

    expect(view.edges[0]!.status).toBe('unverified');
    expect(view.edges[0]!.reason).toBe('wired at runtime through configuration');
    // The evidence it did provide is kept, so the user can still open the code.
    expect(view.edges[0]!.evidence).toHaveLength(1);
  });

  it('merges a relation the agent cited twice instead of dropping the second mention', () => {
    const { view, issues } = run(
      agentGraph(
        [
          { slug: 'a', evidence: [{ file: 'src/index.ts', startLine: 1, endLine: 1 }] },
          { slug: 'b', evidence: [{ file: 'src/util/log.ts', startLine: 1, endLine: 1 }] },
        ],
        [
          { from: 'a', to: 'b', kind: 'calls', confirmed: false, reason: 'only a guess', evidence: [] },
          { from: 'a', to: 'b', kind: 'calls', evidence: [{ file: 'src/index.ts', startLine: 4, endLine: 4 }] },
        ],
      ),
    );

    expect(view.edges).toHaveLength(1);
    // The evidence of both mentions is kept, and the confirmed one wins the status.
    expect(view.edges[0]).toMatchObject({ status: 'confirmed', reason: '' });
    expect(view.edges[0]!.evidence).toEqual([{ file: 'src/index.ts', startLine: 4, endLine: 4 }]);
    expect(issues.filter((i) => i.kind === 'edge-unverified')).toHaveLength(0);
  });

  it('does not report a merged relation as unverified when its first mention was confirmed', () => {
    // Same relation as above, mentions in the other order: the result must not depend
    // on which mention the agent happened to list first, and the issues shown to the
    // user must describe the edge that is actually in the view.
    const { view, issues } = run(
      agentGraph(
        [
          { slug: 'a', evidence: [{ file: 'src/index.ts', startLine: 1, endLine: 1 }] },
          { slug: 'b', evidence: [{ file: 'src/util/log.ts', startLine: 1, endLine: 1 }] },
        ],
        [
          { from: 'a', to: 'b', kind: 'calls', evidence: [{ file: 'src/index.ts', startLine: 4, endLine: 4 }] },
          { from: 'a', to: 'b', kind: 'calls', confirmed: false, reason: 'only a guess', evidence: [] },
        ],
      ),
    );

    expect(view.edges).toHaveLength(1);
    expect(view.edges[0]).toMatchObject({ status: 'confirmed', reason: '' });
    expect(view.edges[0]!.evidence).toEqual([{ file: 'src/index.ts', startLine: 4, endLine: 4 }]);
    expect(issues.filter((i) => i.kind === 'edge-unverified')).toHaveLength(0);
  });

  it('marks a fully evidenced edge confirmed', () => {
    const { view } = run(
      agentGraph(
        [
          { slug: 'a', evidence: [{ file: 'src/index.ts', startLine: 1, endLine: 1 }] },
          { slug: 'b', evidence: [{ file: 'src/util/log.ts', startLine: 1, endLine: 1 }] },
        ],
        [{ from: 'a', to: 'b', evidence: [{ file: 'src/index.ts', startLine: 4, endLine: 4 }] }],
      ),
    );

    expect(view.edges[0]).toMatchObject({ status: 'confirmed', reason: '' });
  });
});

describe('identity', () => {
  it('keeps two slugs that sanitise to the same id apart instead of merging them', () => {
    // Merging them would drop one node and silently re-point its edges at the other,
    // which invents a relation between the wrong pair of nodes (SPEC R1).
    const { view } = run(
      agentGraph(
        [
          { slug: 'HTTP API', title: 'HTTP API', evidence: [{ file: 'src/index.ts', startLine: 1, endLine: 1 }] },
          { slug: 'http-api', title: 'http-api', evidence: [{ file: 'src/util/log.ts', startLine: 1, endLine: 1 }] },
        ],
        [{ from: 'http-api', to: 'HTTP API', evidence: [{ file: 'src/index.ts', startLine: 1, endLine: 1 }] }],
      ),
    );

    expect(view.nodes.map((n) => n.id)).toEqual(['L4:root/http-api', 'L4:root/http-api-2']);
    expect(view.edges).toHaveLength(1);
    expect(view.edges[0]).toMatchObject({ from: 'L4:root/http-api-2', to: 'L4:root/http-api' });
  });

  it('still reports the same slug used twice as a duplicate', () => {
    const { view, issues } = run(
      agentGraph([
        { slug: 'app', title: 'first', evidence: [{ file: 'src/index.ts', startLine: 1, endLine: 1 }] },
        { slug: 'app', title: 'second', evidence: [{ file: 'src/util/log.ts', startLine: 1, endLine: 1 }] },
      ]),
    );

    expect(view.nodes).toHaveLength(1);
    expect(issues.some((i) => i.message.includes('Duplicate node slug'))).toBe(true);
  });

  it('rejects evidence reached through a symlink that leaves the repository', () => {
    const outside = join(repo, '..', 'outside-secret.txt');
    writeFileSync(outside, 'not part of the analyzed repository\n', 'utf8');
    symlinkSync(outside, join(repo, 'escape.txt'));

    const { view, issues } = run(
      agentGraph([{ slug: 'leak', evidence: [{ file: 'escape.txt', startLine: 1, endLine: 1 }] }]),
    );

    expect(view.nodes).toHaveLength(0);
    expect(issues.some((i) => i.kind === 'evidence-outside-repo')).toBe(true);
  });
});

describe('membership', () => {
  it('keeps a node that belongs to two subsystems at once', () => {
    const ev = [{ file: 'src/util/log.ts', startLine: 1, endLine: 1 }];
    const { view } = run(
      agentGraph(
        [
          { slug: 'http', evidence: [{ file: 'src/server/http.ts', startLine: 1, endLine: 1 }] },
          { slug: 'cli', evidence: [{ file: 'src/cli.ts', startLine: 1, endLine: 1 }] },
          { slug: 'log', evidence: ev, memberOf: ['http', 'cli'] },
        ],
        [],
      ),
      l3Scope,
    );

    const log = view.nodes.find((n) => n.id.endsWith('/log'));
    expect(log?.memberOf).toEqual(['L3:L4:root/app/http', 'L3:L4:root/app/cli']);
  });

  it('prunes a membership in a node that did not survive', () => {
    const { view, issues } = run(
      agentGraph([
        { slug: 'gone', evidence: [{ file: 'src/nope.ts', startLine: 1, endLine: 1 }] },
        { slug: 'log', evidence: [{ file: 'src/util/log.ts', startLine: 1, endLine: 1 }], memberOf: ['gone', 'unknown'] },
      ]),
    );

    expect(view.nodes.find((n) => n.id.endsWith('/log'))?.memberOf).toEqual([]);
    expect(issues.filter((i) => i.kind === 'member-dropped')).toHaveLength(2);
  });
});

describe('boundary nodes linked to a subsystem', () => {
  const siblings = ['L3:L4:root/app/cli', 'L3:L4:root/app/logging'];
  const reply = (subsystemId: string, boundary = true) =>
    agentGraph([
      { slug: 'handler', evidence: [{ file: 'src/server/http.ts', startLine: 1, endLine: 1 }] },
      { slug: 'log', boundary, subsystemId, evidence: [{ file: 'src/util/log.ts', startLine: 1, endLine: 1 }] },
    ]);

  it('keeps a link to one of the known sibling subsystems', () => {
    const { view, issues } = validateView({
      repoPath: repo,
      scope: l2Scope,
      snapshot,
      raw: reply('L3:L4:root/app/logging'),
      subsystemIds: siblings,
    });

    expect(view.nodes.find((n) => n.id.endsWith('/log'))?.subsystemId).toBe('L3:L4:root/app/logging');
    expect(view.nodes.find((n) => n.id.endsWith('/handler'))?.subsystemId).toBe('');
    expect(issues).toHaveLength(0);
  });

  it('drops a link to a subsystem that is not a sibling and reports it', () => {
    const { view, issues } = validateView({
      repoPath: repo,
      scope: l2Scope,
      snapshot,
      raw: reply('L3:L4:root/app/invented'),
      subsystemIds: siblings,
    });

    expect(view.nodes.find((n) => n.id.endsWith('/log'))?.subsystemId).toBe('');
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ kind: 'subsystem-link-dropped', nodeId: 'L2:L3:L4:root/app/http/log' });
  });

  it('drops a link on a node that is not a boundary node', () => {
    const { view, issues } = validateView({
      repoPath: repo,
      scope: l2Scope,
      snapshot,
      raw: reply('L3:L4:root/app/logging', false),
      subsystemIds: siblings,
    });

    expect(view.nodes.find((n) => n.id.endsWith('/log'))?.subsystemId).toBe('');
    expect(issues.map((i) => i.kind)).toEqual(['subsystem-link-dropped']);
  });

  it('drops every link when no sibling ids were given (an L4 or L3 reply)', () => {
    const { view, issues } = run(reply('L3:L4:root/app/logging'));
    expect(view.nodes.find((n) => n.id.endsWith('/log'))?.subsystemId).toBe('');
    expect(issues.map((i) => i.kind)).toEqual(['subsystem-link-dropped']);
  });

  it('parses a reply cached before the field existed', () => {
    // No cache version bump: an older reply without subsystemId must still parse, with
    // the field defaulting to "no link".
    const older = agentGraph([{ slug: 'a', evidence: [{ file: 'src/index.ts', startLine: 1, endLine: 1 }] }]);
    const { subsystemId: _dropped, ...withoutField } = older.nodes[0]!;
    const parsed = parseAgentGraph({ ...older, nodes: [withoutField] });
    expect(parsed.nodes[0]!.subsystemId).toBe('');
    const { view } = run(parsed);
    expect(view.nodes[0]!.subsystemId).toBe('');
  });
});

describe('scope and drill-in', () => {
  it('offers a child scope only for a node that has detail and is not a boundary', () => {
    const { view } = run(
      agentGraph([
        { slug: 'app', paths: ['src'], hasDetail: true, evidence: [{ file: 'src/index.ts', startLine: 1, endLine: 1 }] },
        { slug: 'flat', paths: ['src'], hasDetail: false, evidence: [{ file: 'src/index.ts', startLine: 1, endLine: 1 }] },
        {
          slug: 'db',
          boundary: true,
          hasDetail: true,
          paths: ['src'],
          evidence: [{ file: 'src/index.ts', startLine: 1, endLine: 1 }],
        },
      ]),
    );

    expect(view.nodes.find((n) => n.id.endsWith('/app'))?.childScope).toEqual({
      level: 'L3',
      id: 'L4:root/app',
      label: 'app',
      paths: ['src'],
    });
    expect(view.nodes.find((n) => n.id.endsWith('/flat'))?.childScope).toBeNull();
    expect(view.nodes.find((n) => n.id.endsWith('/db'))?.childScope).toBeNull();
  });

  it('keeps the repository root as the scope of a single-application node', () => {
    // SPEC 6.1 with the accepted L4 decision: a one-application repository is the
    // normal case, and "." is how the agent names the area that application covers.
    // `rootScope` and `filesUnder` both treat "." as the whole repository, so a node
    // that claims it must keep it — otherwise opening that application analyzes a
    // single file instead of the application.
    const { view } = run(
      agentGraph([
        {
          slug: 'app',
          paths: ['.'],
          hasDetail: true,
          evidence: [{ file: 'src/index.ts', startLine: 1, endLine: 2 }],
        },
      ]),
    );

    expect(view.nodes[0]!.paths).toEqual(['.']);
    expect(view.nodes[0]!.childScope?.paths).toEqual(['.']);
  });

  it('falls back to the evidence files when the agent gave no usable paths', () => {
    const { view } = run(
      agentGraph([
        { slug: 'app', paths: ['/outside', '../escape'], evidence: [{ file: 'src/index.ts', startLine: 1, endLine: 2 }] },
      ]),
    );

    expect(view.nodes[0]!.paths).toEqual(['src/index.ts']);
  });
});

describe('behaviour views (L1)', () => {
  const FILE = 'src/server/connection.ts';
  const l1Scope: ScopeRef = {
    level: 'L1',
    id: 'L2:L3:L4:root/app/http/connection',
    label: 'Connection',
    paths: [FILE],
  };
  const at = (startLine: number, endLine = startLine) => [{ file: FILE, startLine, endLine }];
  const runL1 = (graph: ReturnType<typeof agentGraph>) => validateView({ repoPath: repo, scope: l1Scope, snapshot, raw: graph });

  it('parses a reply cached before the behaviour fields existed, with "supported" defaults', () => {
    const older = agentGraph(
      [{ slug: 'a', evidence: [{ file: 'src/index.ts', startLine: 1, endLine: 1 }] }],
      [{ from: 'a', to: 'a', evidence: [{ file: 'src/index.ts', startLine: 1, endLine: 1 }] }],
    );
    const { behavior: _b, ...withoutBehavior } = older;
    const { role: _r, ...node } = older.nodes[0]!;
    const { order: _o, style: _s, group: _g, ...edge } = older.edges[0]!;
    const parsed = parseAgentGraph({ ...withoutBehavior, nodes: [node], edges: [edge] });

    expect(parsed.behavior).toEqual({ supported: true, reason: '' });
    expect(parsed.nodes[0]!.role).toBe('');
    expect(parsed.edges[0]).toMatchObject({ order: 0, style: '', group: '' });
    const { view, issues } = run(parsed);
    expect(view.behavior).toEqual({ supported: true, reason: '' });
    expect(view.nodes[0]!.role).toBeUndefined();
    expect(view.edges[0]!.order).toBeUndefined();
    expect(issues).toEqual([]);
  });

  it('keeps the roles of a state machine, drops a state without evidence with its transitions, flags an unverified one', () => {
    const { view, issues } = runL1(
      l1Graph(
        'state-machine',
        [
          { slug: 'idle', kind: 'state', role: 'initial', evidence: at(8, 9) },
          { slug: 'connecting', kind: 'state', role: 'state', evidence: at(10, 13) },
          { slug: 'closed', kind: 'state', role: 'final', evidence: at(18, 19) },
          { slug: 'ghost', kind: 'state', role: 'state', evidence: [{ file: 'src/server/nope.ts', startLine: 1, endLine: 1 }] },
        ],
        [
          { from: 'idle', to: 'connecting', kind: 'transitions-to', label: 'connect', evidence: at(9) },
          { from: 'connecting', to: 'closed', kind: 'transitions-to', label: 'close', confirmed: false, reason: 'not read', evidence: [] },
          { from: 'connecting', to: 'ghost', kind: 'transitions-to', label: 'vanish', evidence: at(12) },
        ],
      ),
    );

    expect(view.diagramKind).toBe('state-machine');
    expect(view.behavior).toEqual({ supported: true, reason: '' });
    expect(view.nodes.map((n) => [n.title, n.role, n.level])).toEqual([
      ['idle', 'initial', 'L1'],
      ['connecting', 'state', 'L1'],
      ['closed', 'final', 'L1'],
    ]);
    expect(view.nodes[0]!.id).toBe(`L1:${l1Scope.id}/idle`);
    expect(view.edges.map((e) => [e.label, e.status])).toEqual([
      ['connect', 'confirmed'],
      ['close', 'unverified'],
    ]);
    // Not a sequence: no message numbers on the edges; the ids carry the event instead.
    expect(view.edges.every((e) => e.order === undefined)).toBe(true);
    expect(view.edges.map((e) => e.id.slice(e.id.lastIndexOf('#')))).toEqual(['#connect', '#close']);
    expect(issues.map((i) => i.kind)).toEqual(['evidence-missing-file', 'node-dropped', 'edge-dropped', 'edge-unverified']);
  });

  it('keeps two transitions between the same states on different events apart', () => {
    const { view, issues } = runL1(
      l1Graph(
        'state-machine',
        [
          { slug: 'open', kind: 'state', role: 'state', evidence: at(14, 15) },
          { slug: 'closed', kind: 'state', role: 'final', evidence: at(18, 19) },
        ],
        [
          { from: 'open', to: 'closed', kind: 'transitions-to', label: 'close', evidence: at(15) },
          { from: 'open', to: 'closed', kind: 'transitions-to', label: 'error', confirmed: false, reason: 'not read', evidence: [] },
          // The same transition cited twice is still one transition.
          { from: 'open', to: 'closed', kind: 'transitions-to', label: 'close', evidence: at(14) },
        ],
      ),
    );

    expect(view.edges.map((e) => [e.label, e.status, e.evidence.length])).toEqual([
      ['close', 'confirmed', 2],
      ['error', 'unverified', 0],
    ]);
    expect(view.edges.map((e) => e.id)).toEqual([
      `L1:${l1Scope.id}|L1:${l1Scope.id}/open->L1:${l1Scope.id}/closed|transitions-to#close`,
      `L1:${l1Scope.id}|L1:${l1Scope.id}/open->L1:${l1Scope.id}/closed|transitions-to#error`,
    ]);
    expect(issues.map((i) => i.kind)).toEqual(['edge-unverified']);

    // A flow's branches leaving a decision are told apart the same way.
    const flow = runL1(
      l1Graph(
        'flow',
        [
          { slug: 'which', role: 'decision', evidence: at(7) },
          { slug: 'done', role: 'end', evidence: at(21) },
        ],
        [
          { from: 'which', to: 'done', kind: 'next', label: 'closed', evidence: at(19) },
          { from: 'which', to: 'done', kind: 'next', label: 'already closed', evidence: at(18) },
        ],
      ),
    );
    expect(flow.view.edges.map((e) => e.label)).toEqual(['closed', 'already closed']);
    expect(flow.issues).toEqual([]);
  });

  it('reports an L1 reply that did not pick one of the three kinds but keeps its graph', () => {
    const { view, issues } = runL1(
      agentGraph([{ slug: 'a', evidence: at(1) }, { slug: 'b', evidence: at(2) }], [{ from: 'a', to: 'b', evidence: at(3) }], {
        diagramKind: 'component-graph',
      }),
    );
    expect(view.diagramKind).toBe('component-graph');
    expect(view.nodes).toHaveLength(2);
    expect(view.edges).toHaveLength(1);
    expect(issues.map((i) => i.kind)).toEqual(['behavior-inconsistent']);
    expect(issues[0]!.message).toContain('"component-graph"');
  });

  it('clears a role the diagram kind does not allow, and any role outside a behaviour view', () => {
    const { view, issues } = runL1(
      l1Graph('state-machine', [
        { slug: 'a', role: 'participant', evidence: at(1) },
        { slug: 'b', role: 'final', evidence: at(2) },
      ]),
    );
    expect(view.nodes.map((n) => n.role)).toEqual([undefined, 'final']);
    expect(issues).toEqual([expect.objectContaining({ kind: 'role-cleared', nodeId: `L1:${l1Scope.id}/a` })]);

    const plain = run(agentGraph([{ slug: 'x', role: 'initial', evidence: [{ file: 'src/index.ts', startLine: 1, endLine: 1 }] }]));
    expect(plain.view.nodes[0]!.role).toBeUndefined();
    expect(plain.issues.map((i) => i.kind)).toEqual(['role-cleared']);
  });

  it('renumbers duplicate, gapped and missing message orders, keeps same-pair messages apart, clears a bad style', () => {
    const { view, issues } = runL1(
      l1Graph(
        'sequence',
        [
          { slug: 'client', kind: 'participant', role: 'participant', boundary: true, evidence: at(1) },
          { slug: 'conn', kind: 'participant', role: 'participant', evidence: at(23, 30) },
        ],
        [
          { from: 'client', to: 'conn', kind: 'calls', label: 'send', order: 2, style: 'sync', evidence: at(26) },
          { from: 'conn', to: 'client', kind: 'returns', label: 'state', order: 2, style: 'return', evidence: at(28) },
          { from: 'client', to: 'conn', kind: 'calls', label: 'send again', order: 0, style: 'async', group: 'loop: retry', evidence: at(27) },
          { from: 'client', to: 'conn', kind: 'calls', label: 'connect', order: 1, style: 'bogus', evidence: at(27) },
        ],
      ),
    );

    // Given [2, 2, -, 1] → numbered ones by value (ties in order of appearance), unnumbered last.
    expect(view.edges.map((e) => [e.label, e.order, e.style ?? null, e.group ?? null])).toEqual([
      ['send', 2, 'sync', null],
      ['state', 3, 'return', null],
      ['send again', 4, 'async', 'loop: retry'],
      ['connect', 1, null, null],
    ]);
    // Three messages between the same pair with the same kind: three edges, not one merged.
    const ids = view.edges.map((e) => e.id);
    expect(new Set(ids).size).toBe(4);
    expect(ids[0]).toBe(`L1:${l1Scope.id}|L1:${l1Scope.id}/client->L1:${l1Scope.id}/conn|calls#2`);
    expect(issues.filter((i) => i.kind === 'sequence-order-fixed')).toHaveLength(1);
    expect(issues.filter((i) => i.kind === 'style-cleared')).toEqual([
      expect.objectContaining({ kind: 'style-cleared', edgeId: ids[3] }),
    ]);
    expect(view.nodes.map((n) => [n.role, n.boundary])).toEqual([
      ['participant', true],
      ['participant', false],
    ]);
  });

  it('does not report a well-numbered sequence, and a dropped participant takes its messages with it', () => {
    const { view, issues } = runL1(
      l1Graph(
        'sequence',
        [
          { slug: 'a', role: 'participant', evidence: at(1) },
          { slug: 'b', role: 'participant', evidence: at(2) },
          { slug: 'gone', role: 'participant', evidence: [{ file: 'src/server/nope.ts', startLine: 1, endLine: 1 }] },
        ],
        [
          { from: 'a', to: 'b', kind: 'calls', order: 1, evidence: at(3) },
          { from: 'b', to: 'gone', kind: 'calls', order: 2, evidence: at(4) },
          { from: 'b', to: 'a', kind: 'returns', order: 3, style: 'return', evidence: at(5) },
        ],
      ),
    );
    // The surviving messages are 1 and 2: the gap the dropped message left is closed.
    expect(view.edges.map((e) => [e.kind, e.order])).toEqual([
      ['calls', 1],
      ['returns', 2],
    ]);
    expect(issues.map((i) => i.kind)).toEqual(['evidence-missing-file', 'node-dropped', 'edge-dropped', 'sequence-order-fixed']);
  });

  it('drops order, style and group outside a sequence, reporting only the style', () => {
    const { view, issues } = run(
      agentGraph(
        [
          { slug: 'a', evidence: [{ file: 'src/index.ts', startLine: 1, endLine: 1 }] },
          { slug: 'b', evidence: [{ file: 'src/util/log.ts', startLine: 1, endLine: 1 }] },
        ],
        [{ from: 'a', to: 'b', order: 3, style: 'async', group: 'alt: x', evidence: [{ file: 'src/index.ts', startLine: 1, endLine: 1 }] }],
      ),
    );
    expect(view.edges[0]!.order).toBeUndefined();
    expect(view.edges[0]!.style).toBeUndefined();
    expect(view.edges[0]!.group).toBeUndefined();
    expect(issues.map((i) => i.kind)).toEqual(['style-cleared']);
  });

  it('keeps an unsupported reply unsupported: no nodes, the reason, no diagram filled in', () => {
    const { view, issues } = runL1(
      l1Graph('unsupported', [], [], { supported: false, reason: 'the handlers are looked up in a runtime table' }),
    );
    expect(view.diagramKind).toBe('unsupported');
    expect(view.nodes).toEqual([]);
    expect(view.edges).toEqual([]);
    expect(view.behavior).toEqual({ supported: false, reason: 'the handlers are looked up in a runtime table' });
    expect(view.scope).toEqual(l1Scope);
    expect(issues).toEqual([]);
  });

  it('reports and drops the nodes of a reply that claims to be unsupported', () => {
    const { view, issues } = runL1(
      l1Graph('state-machine', [{ slug: 'idle', role: 'initial', evidence: at(8) }], [], {
        supported: false,
        reason: 'too little code',
      }),
    );
    expect(view.diagramKind).toBe('unsupported');
    expect(view.nodes).toEqual([]);
    expect(view.behavior.reason).toBe('too little code');
    expect(issues).toEqual([expect.objectContaining({ kind: 'behavior-inconsistent' })]);
    expect(issues[0]!.message).toContain('1 node(s)');
  });

  it('gives an unsupported reply without a reason a fallback reason and reports it', () => {
    const { view, issues } = runL1(l1Graph('unsupported', [], [], { supported: false, reason: '   ' }));
    expect(view.behavior.supported).toBe(false);
    expect(view.behavior.reason.length).toBeGreaterThan(0);
    expect(issues.map((i) => i.kind)).toEqual(['behavior-inconsistent']);
  });

  it('treats diagramKind "unsupported" with supported=true as unsupported, and reports it', () => {
    const { view, issues } = runL1(l1Graph('unsupported', [], [], { supported: true, reason: '' }));
    expect(view.diagramKind).toBe('unsupported');
    expect(view.behavior.supported).toBe(false);
    expect(issues.filter((i) => i.kind === 'behavior-inconsistent').length).toBeGreaterThanOrEqual(2);
  });

  it('ignores and reports an "unsupported" claim on an L4–L2 reply instead of hiding the graph', () => {
    const ev = [{ file: 'src/index.ts', startLine: 1, endLine: 1 }];
    const flagged = run(agentGraph([{ slug: 'app', evidence: ev }], [], { behavior: { supported: false, reason: 'oops' } }), l3Scope);
    expect(flagged.view.nodes).toHaveLength(1);
    expect(flagged.view.diagramKind).toBe('component-graph');
    expect(flagged.view.behavior).toEqual({ supported: true, reason: '' });
    expect(flagged.issues.map((i) => i.kind)).toEqual(['behavior-inconsistent']);
    expect(flagged.issues[0]!.message).toContain('L3');

    const kind = run(agentGraph([{ slug: 'app', evidence: ev }], [], { diagramKind: 'unsupported' }));
    expect(kind.view.nodes).toHaveLength(1);
    expect(kind.view.diagramKind).toBe('component-graph');
    expect(kind.issues.map((i) => i.kind)).toEqual(['behavior-inconsistent']);
  });

  it('reports a supported L1 reply that ends up with no element, and not an empty L4 one', () => {
    const l1 = runL1(l1Graph('flow', [{ slug: 'start', role: 'start', evidence: [{ file: 'src/server/nope.ts', startLine: 1, endLine: 1 }] }]));
    expect(l1.view.nodes).toEqual([]);
    expect(l1.view.behavior.supported).toBe(true);
    expect(l1.issues.map((i) => i.kind)).toEqual(['evidence-missing-file', 'node-dropped', 'behavior-inconsistent']);

    const l4 = run(agentGraph([]));
    expect(l4.issues).toEqual([]);
    expect(l4.view.behavior).toEqual({ supported: true, reason: '' });
  });

  it('keeps the roles of a flow', () => {
    const { view, issues } = runL1(
      l1Graph(
        'flow',
        [
          { slug: 'start', role: 'start', evidence: at(6) },
          { slug: 'which', role: 'decision', evidence: at(7) },
          { slug: 'done', role: 'end', evidence: at(21) },
        ],
        [
          { from: 'start', to: 'which', kind: 'next', evidence: at(7) },
          { from: 'which', to: 'done', kind: 'next', label: 'closed', evidence: at(19) },
        ],
      ),
    );
    expect(view.nodes.map((n) => n.role)).toEqual(['start', 'decision', 'end']);
    expect(view.edges[1]!.label).toBe('closed');
    expect(issues).toEqual([]);
  });
});
