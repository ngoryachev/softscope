import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateView } from '../src/server/validation/validate';
import { repoSnapshot } from '../src/server/indexer/git';
import { rootScope, type ScopeRef, type Snapshot } from '../src/shared/graph';
import { agentGraph, cleanupTemps, copyFixture } from './helpers';

afterAll(cleanupTemps);

let repo: string;
let snapshot: Snapshot;
const scope: ScopeRef = rootScope('sample-app');
const l3Scope: ScopeRef = { level: 'L3', id: 'L4:root/app', label: 'app', paths: ['src'] };

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

  it('falls back to the evidence files when the agent gave no usable paths', () => {
    const { view } = run(
      agentGraph([
        { slug: 'app', paths: ['/outside', '../escape'], evidence: [{ file: 'src/index.ts', startLine: 1, endLine: 2 }] },
      ]),
    );

    expect(view.nodes[0]!.paths).toEqual(['src/index.ts']);
  });
});
