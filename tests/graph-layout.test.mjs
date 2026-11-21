import test from 'node:test';
import assert from 'node:assert/strict';
import { computeLayout, nodeRadius, computeDegrees } from '../src/client/wiki-graph-layout.js';

const graph = {
  nodes: [
    { id: 'a.md', title: 'A', dangling: false },
    { id: 'b.md', title: 'B', dangling: false },
    { id: 'dangling:missing', title: 'missing', dangling: true },
  ],
  edges: [
    { source: 'a.md', target: 'b.md' },
    { source: 'a.md', target: 'dangling:missing' },
  ],
};

test('layout is deterministic for identical input', () => {
  const first = computeLayout(graph, 800, 600);
  const second = computeLayout(graph, 800, 600);
  assert.deepEqual([...first.entries()], [...second.entries()]);
});

test('all nodes receive finite positions inside bounds', () => {
  const positions = computeLayout(graph, 800, 600);
  for (const node of graph.nodes) {
    const at = positions.get(node.id);
    assert.ok(at, node.id + ' positioned');
    assert.ok(Number.isFinite(at.x) && Number.isFinite(at.y));
    assert.ok(at.x >= -100 && at.x <= 900, node.id + ' x in range: ' + at.x);
    assert.ok(at.y >= -100 && at.y <= 700, node.id + ' y in range: ' + at.y);
  }
});

test('degrees and radii follow the droplets constants', () => {
  const degrees = computeDegrees(graph.edges);
  assert.equal(degrees.get('a.md'), 2);
  assert.equal(degrees.get('b.md'), 1);
  assert.equal(nodeRadius(true, 5), 3);
  assert.ok(nodeRadius(false, 4) > nodeRadius(false, 1));
});
