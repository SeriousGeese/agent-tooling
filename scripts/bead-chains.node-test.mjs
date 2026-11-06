import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { breakReason, buildChains, formatChains, parseDotEdges } from './bead-chains.mjs';

const bead = (id, extra = {}) => ({
  id,
  title: id,
  status: 'open',
  priority: 2,
  issue_type: 'task',
  labels: [],
  assignee: null,
  ...extra,
});
const blocks = (blocker, blocked) => ({ from: blocked, to: blocker, type: 'blocks' });

describe('bead-chains', () => {
  test('parseDotEdges keeps the dependency type from bd --format dot', () => {
    const dot = [
      'digraph dependencies {',
      '  "bd-a.3" -> "bd-a.2" [label="blocks", color=red, style=bold];',
      '  "bd-a.3" -> "bd-a" [label="parent-child", color=blue, style=solid];',
      '  "bd-b" -> "bd-c" [label="related", color=gray, style=dashed];',
      '}',
    ].join('\n');
    assert.deepEqual(parseDotEdges(dot), [
      { from: 'bd-a.3', to: 'bd-a.2', type: 'blocks' },
      { from: 'bd-a.3', to: 'bd-a', type: 'parent-child' },
      { from: 'bd-b', to: 'bd-c', type: 'related' },
    ]);
  });

  test('breakReason names each thing that stops a bead riding in the same PR', () => {
    assert.equal(breakReason(bead('x')), null);
    assert.equal(breakReason(bead('x', { labels: ['human-required'] })), 'human');
    assert.equal(breakReason(bead('x', { labels: ['ask-alice'] })), 'ask:alice');
    assert.equal(breakReason(bead('x', { status: 'deferred' })), 'deferred');
    assert.equal(breakReason(bead('x', { assignee: 'peer-bot-1' })), 'claimed:peer-bot-1');
    assert.equal(breakReason(bead('x', { assignee: 'me-bot-1' }), { actor: 'me-bot-1' }), null);
    assert.equal(breakReason(bead('x', { title: 'the plugin (separate repo)' })), 'other-repo');
    const here = { repoLabel: 'repo:here' };
    assert.equal(breakReason(bead('x', { labels: ['repo:elsewhere'] }), here), 'other-repo');
    assert.equal(breakReason(bead('x', { labels: ['repo:here'] }), here), null);
    assert.equal(breakReason(bead('x', { labels: ['repo:elsewhere'] })), null, 'without a repo label the repo:* labels are not consulted');
  });

  test('a straight chain with a fork lands whole, in dependency order', () => {
    const beads = ['r', 'a', 'b', 'c'].map((id) => bead(id));
    const edges = [blocks('r', 'a'), blocks('a', 'b'), blocks('a', 'c')];
    const [chain] = buildChains(beads, edges);
    assert.equal(chain.root, 'r');
    assert.equal(chain.depth, 2);
    assert.deepEqual(chain.onePr, [
      { id: 'r', level: 0 },
      { id: 'a', level: 1 },
      { id: 'b', level: 2 },
      { id: 'c', level: 2 },
    ]);
    assert.deepEqual(chain.later, []);
  });

  test('a break stops the PR there, and everything behind it waits', () => {
    const beads = [bead('r'), bead('a'), bead('h', { labels: ['human-required'] }), bead('z')];
    const edges = [blocks('r', 'a'), blocks('a', 'h'), blocks('h', 'z')];
    const [chain] = buildChains(beads, edges);
    assert.deepEqual(chain.onePr.map((s) => s.id), ['r', 'a']);
    assert.deepEqual(chain.later, [
      { id: 'h', reason: 'human' },
      { id: 'z', reason: 'after:h' },
    ]);
  });

  test('a blocker outside the chain keeps its bead out of the PR', () => {
    const beads = ['r', 'a', 'b', 'other'].map((id) => bead(id));
    const edges = [blocks('r', 'a'), blocks('a', 'b'), blocks('other', 'b'), blocks('other', 'r2')];
    const chains = buildChains(beads, edges);
    const fromR = chains.find((c) => c.root === 'r');
    assert.deepEqual(fromR.onePr.map((s) => s.id), ['r', 'a']);
    assert.deepEqual(fromR.later, [{ id: 'b', reason: 'waits:other' }]);
  });

  test('parent-child, related and epic edges are not order, and closed ends are not live', () => {
    const beads = [bead('e', { issue_type: 'epic' }), bead('r'), bead('a')];
    const edges = [
      { from: 'r', to: 'e', type: 'parent-child' },
      { from: 'a', to: 'r', type: 'related' },
      blocks('e', 'a'),
      blocks('closed-one', 'r'),
    ];
    assert.deepEqual(buildChains(beads, edges), []);
  });

  test('the epic comes from the parent-child edge, and an excluded root label drops the chain', () => {
    const beads = [bead('e', { issue_type: 'epic', title: 'The epic' }), bead('r', { labels: ['solo-only'] }), bead('a')];
    const edges = [{ from: 'r', to: 'e', type: 'parent-child' }, blocks('r', 'a')];
    assert.equal(buildChains(beads, edges)[0].epic, 'e');
    assert.deepEqual(buildChains(beads, edges, { excludeLabels: ['solo-only'] }), []);
  });

  test('chains rank by beads that fit in one PR, then depth', () => {
    const beads = ['r1', 'a1', 'r2', 'a2', 'b2', 'r3', 'a3'].map((id) => bead(id));
    beads.find((b) => b.id === 'a3').status = 'deferred';
    const edges = [blocks('r1', 'a1'), blocks('r2', 'a2'), blocks('a2', 'b2'), blocks('r3', 'a3')];
    assert.deepEqual(buildChains(beads, edges).map((c) => c.root), ['r2', 'r1', 'r3']);
  });

  test('a cycle does not hang or drop its members', () => {
    const beads = ['r', 'a', 'b'].map((id) => bead(id));
    const edges = [blocks('r', 'a'), blocks('a', 'b'), blocks('b', 'a')];
    const [chain] = buildChains(beads, edges);
    assert.equal(chain.size, 3);
  });

  test('formatChains prints the PR set indented by level and the reasons for the rest', () => {
    const beads = [bead('r', { title: 'Root' }), bead('a', { title: 'Next' }), bead('d', { status: 'deferred', title: 'Later' })];
    const edges = [blocks('r', 'a'), blocks('a', 'd')];
    const byId = new Map(beads.map((b) => [b.id, b]));
    const text = formatChains(buildChains(beads, edges), byId);
    assert.match(text, /^1\. r: 2 of 3 in one PR, depth 2/);
    assert.match(text, /\n {5}r \[P2 task\] Root\n {7}a \[P2 task\] Next\n/);
    assert.match(text, /d \[P2 task deferred\] Later {2}<- deferred/);
  });
});
