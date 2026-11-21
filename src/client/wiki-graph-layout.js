/**
 * Wiki graph layout, a faithful port of droplets'
 * apps/desktop/src/renderer/components/wikiGraphLayout.ts (pure functions;
 * d3-force drives the simulation). Deterministic seeding: sunflower spiral,
 * no RNG — same data, same layout.
 */
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
} from 'd3-force';

export const FORCES = {
  charge: -90,
  linkDistance: 42,
  linkStrength: 0.15,
  centerStrength: 0.04,
  collidePad: 2.5,
  alphaDecay: 0.06,
  velocityDecay: 0.35,
};

export const NODE_R_BASE = 4;
export const NODE_R_K = 1.6;
export const DANGLING_R = 3;

export function computeDegrees(edges) {
  const deg = new Map();
  for (const e of edges) {
    deg.set(e.source, (deg.get(e.source) ?? 0) + 1);
    deg.set(e.target, (deg.get(e.target) ?? 0) + 1);
  }
  return deg;
}

export function nodeRadius(dangling, degree) {
  return dangling ? DANGLING_R : NODE_R_BASE + NODE_R_K * Math.sqrt(degree);
}

export function buildSimNodes(graph) {
  const deg = computeDegrees(graph.edges);
  return graph.nodes.map((n) => {
    const d = deg.get(n.id) ?? 0;
    return { id: n.id, title: n.title, dangling: n.dangling, degree: d, r: nodeRadius(n.dangling, d) };
  });
}

/** Deterministic initial positions: sunflower spiral (golden angle). */
export function seedSpiral(nodes, width, height) {
  const GA = Math.PI * (3 - Math.sqrt(5));
  const cx = width / 2;
  const cy = height / 2;
  nodes.forEach((n, i) => {
    const r = 14 * Math.sqrt(i + 0.5);
    const a = i * GA;
    n.x = cx + r * Math.cos(a);
    n.y = cy + r * Math.sin(a);
  });
}

export function createSimulation(simNodes, links, width, height) {
  const sim = forceSimulation(simNodes)
    .force('charge', forceManyBody().strength(FORCES.charge))
    .force('link', forceLink(links).id((d) => d.id).distance(FORCES.linkDistance).strength(FORCES.linkStrength))
    .force('x', forceX(width / 2).strength(FORCES.centerStrength))
    .force('y', forceY(height / 2).strength(FORCES.centerStrength))
    .force('collide', forceCollide().radius((d) => d.r + FORCES.collidePad).iterations(2))
    .alphaDecay(FORCES.alphaDecay)
    .velocityDecay(FORCES.velocityDecay);
  sim.stop();
  return sim;
}

/** Run the whole simulation synchronously (deterministic verification). */
export function computeLayout(graph, width = 1000, height = 700) {
  const simNodes = buildSimNodes(graph);
  const links = graph.edges.map((e) => ({ source: e.source, target: e.target }));
  seedSpiral(simNodes, width, height);
  const sim = createSimulation(simNodes, links, width, height);
  for (let i = 0; i < 400 && sim.alpha() > sim.alphaMin(); i += 1) sim.tick();
  return new Map(simNodes.map((n) => [n.id, { x: n.x ?? 0, y: n.y ?? 0 }]));
}
