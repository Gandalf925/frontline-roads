import { distance, stableId } from '../core/utilities.js';
import { pointToSegmentProjection } from '../roads/geometry.js';

const CURVE_THRESHOLD_RADIANS = 50 * Math.PI / 180;
const TACTICAL_SITE_SPACING_METERS = 55;
const BARRIER_SECTION_MAX_METERS = 150;
const SUPPORT_SITE_LIMIT = 6;
const SUPPORT_SECTOR_COUNT = 6;

const plannerCache = new WeakMap();

function normalizeAngleDifference(left, right) {
  let difference = Math.abs(left - right) % (Math.PI * 2);
  if (difference > Math.PI) difference = Math.PI * 2 - difference;
  return difference;
}

function direction(from, to) {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

function nodePriority(graph, node) {
  const connections = graph.adjacency.get(node.id) ?? [];
  if (connections.length >= 3) return { priority: 4, reason: 'intersection' };
  if (connections.length <= 1) return { priority: 3, reason: 'terminal' };
  const first = graph.nodeById.get(connections[0]?.to);
  const second = graph.nodeById.get(connections[1]?.to);
  if (!first || !second) return { priority: 0, reason: 'shape' };
  const turn = Math.PI - normalizeAngleDifference(direction(node, first), direction(node, second));
  if (Math.abs(turn) >= CURVE_THRESHOLD_RADIANS) return { priority: 2, reason: 'curve' };
  return { priority: 0, reason: 'shape' };
}

function createTacticalSites(graph) {
  const selected = [];
  const selectedNodeIds = new Set();
  for (const node of graph.nodes) {
    const classification = nodePriority(graph, node);
    if (classification.priority <= 0) continue;
    selected.push({ id: `node:${node.id}`, nodeId: node.id, point: { x: node.x, y: node.y }, ...classification });
    selectedNodeIds.add(node.id);
  }

  // Long straight roads still receive sparse construction points. This is deliberately
  // based on physical spacing, not every OSM shape node.
  const remaining = graph.nodes
    .filter(node => !selectedNodeIds.has(node.id))
    .sort((left, right) => left.id.localeCompare(right.id));
  for (const node of remaining) {
    let nearest = Infinity;
    for (const site of selected) {
      nearest = Math.min(nearest, distance(node, site.point));
      if (nearest < TACTICAL_SITE_SPACING_METERS) break;
    }
    if (nearest < TACTICAL_SITE_SPACING_METERS) continue;
    selected.push({ id: `node:${node.id}`, nodeId: node.id, point: { x: node.x, y: node.y }, priority: 1, reason: 'interval' });
    selectedNodeIds.add(node.id);
  }
  return selected;
}

function walkSection(graph, startNodeId, firstEdgeId, visited) {
  const edgeIds = [];
  const nodeIds = [startNodeId];
  let currentNodeId = startNodeId;
  let edgeId = firstEdgeId;
  let length = 0;
  while (edgeId && !visited.has(edgeId)) {
    visited.add(edgeId);
    const edge = graph.edgeById.get(edgeId);
    if (!edge) break;
    edgeIds.push(edge.id);
    length += Math.max(0, Number(edge.length) || 0);
    const nextNodeId = edge.a === currentNodeId ? edge.b : edge.a;
    nodeIds.push(nextNodeId);
    const nextConnections = graph.adjacency.get(nextNodeId) ?? [];
    if (nextConnections.length !== 2 || length >= BARRIER_SECTION_MAX_METERS) break;
    const next = nextConnections.find(connection => connection.edgeId !== edgeId && !visited.has(connection.edgeId));
    if (!next) break;
    currentNodeId = nextNodeId;
    edgeId = next.edgeId;
  }
  return { nodeIds, edgeIds, length };
}

function sectionPlacement(graph, section) {
  const halfway = section.length / 2;
  let traversed = 0;
  for (let index = 0; index < section.edgeIds.length; index += 1) {
    const edge = graph.edgeById.get(section.edgeIds[index]);
    if (!edge) continue;
    const edgeLength = Math.max(0.001, Number(edge.length) || 0.001);
    if (traversed + edgeLength + 1e-9 < halfway) {
      traversed += edgeLength;
      continue;
    }
    const fromNodeId = section.nodeIds[index];
    const toNodeId = section.nodeIds[index + 1];
    const from = graph.nodeById.get(fromNodeId);
    const to = graph.nodeById.get(toNodeId);
    if (!from || !to) break;
    const localDistance = Math.max(0, Math.min(edgeLength, halfway - traversed));
    const tFrom = localDistance / edgeLength;
    const point = { x: from.x + (to.x - from.x) * tFrom, y: from.y + (to.y - from.y) * tFrom };
    const tEdge = edge.a === fromNodeId ? tFrom : 1 - tFrom;
    return { edgeId: edge.id, point, edgeProgress: edgeLength * tEdge };
  }
  const edge = graph.edgeById.get(section.edgeIds[0]);
  const a = edge && graph.nodeById.get(edge.a);
  const b = edge && graph.nodeById.get(edge.b);
  return edge && a && b
    ? { edgeId: edge.id, point: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, edgeProgress: edge.length / 2 }
    : null;
}

function createBarrierSections(graph) {
  const visited = new Set();
  const sections = [];
  const startNodes = graph.nodes.filter(node => (graph.adjacency.get(node.id)?.length ?? 0) !== 2);
  for (const node of startNodes) {
    for (const connection of graph.adjacency.get(node.id) ?? []) {
      if (visited.has(connection.edgeId)) continue;
      const section = walkSection(graph, node.id, connection.edgeId, visited);
      const placement = sectionPlacement(graph, section);
      if (!placement) continue;
      sections.push({
        id: stableId('road-section', ...section.edgeIds.slice().sort()),
        ...section,
        ...placement
      });
    }
  }
  // Closed loops have no degree != 2 node. Split them into bounded sections.
  for (const edge of graph.edges) {
    if (edge.routingDisabled || visited.has(edge.id)) continue;
    const section = walkSection(graph, edge.a, edge.id, visited);
    const placement = sectionPlacement(graph, section);
    if (!placement) continue;
    sections.push({ id: stableId('road-section', ...section.edgeIds.slice().sort()), ...section, ...placement });
  }
  return sections;
}

function createPlanner(graph) {
  const tacticalSites = createTacticalSites(graph);
  const barrierSections = createBarrierSections(graph);
  const sectionByEdgeId = new Map();
  for (const section of barrierSections) for (const edgeId of section.edgeIds) sectionByEdgeId.set(edgeId, section);
  return { tacticalSites, barrierSections, sectionByEdgeId };
}

export function buildSitePlanner(graph) {
  if (!graph?.nodeById || !graph?.edgeById || !graph?.adjacency) return { tacticalSites: [], barrierSections: [], sectionByEdgeId: new Map() };
  const topologyRevision = Math.max(1, Math.floor(Number(graph.topologyRevision) || 1));
  const cached = plannerCache.get(graph);
  if (cached
    && cached.topologyRevision === topologyRevision
    && cached.nodeCount === graph.nodes.length
    && cached.edgeCount === graph.edges.length
    && cached.adjacency === graph.adjacency) {
    return cached.planner;
  }
  const planner = createPlanner(graph);
  plannerCache.set(graph, {
    planner,
    topologyRevision,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    adjacency: graph.adjacency
  });
  return planner;
}


export function barrierSiteForAnchor(graph, section, anchor) {
  if (!graph || !section || !anchor?.point) return null;
  const range = Math.max(0, Number(anchor.range) || 0);
  const midpointDistance = distance(anchor.point, section.point);
  if (midpointDistance <= range) {
    return {
      edgeId: section.edgeId,
      point: { ...section.point },
      edgeProgress: section.edgeProgress,
      distance: midpointDistance
    };
  }
  let best = null;
  for (const edgeId of section.edgeIds) {
    const edge = graph.edgeById.get(edgeId);
    const a = edge && graph.nodeById.get(edge.a);
    const b = edge && graph.nodeById.get(edge.b);
    if (!edge || !a || !b) continue;
    const projection = pointToSegmentProjection(anchor.point, a, b);
    if (!best || projection.distance < best.distance) {
      best = {
        edgeId: edge.id,
        point: projection.point,
        edgeProgress: Math.max(0, Number(edge.length) || distance(a, b)) * projection.t,
        distance: projection.distance
      };
    }
  }
  return best && best.distance <= range ? best : null;
}

export function supportSitesForAnchor(planner, anchor, limit = SUPPORT_SITE_LIMIT) {
  const candidates = planner.tacticalSites
    .map(site => ({ ...site, distance: distance(anchor.point, site.point), angle: direction(anchor.point, site.point) }))
    .filter(site => site.distance <= anchor.range)
    .sort((left, right) => right.priority - left.priority || left.distance - right.distance);
  if (limit <= 1) return candidates.slice(0, Math.max(0, limit));
  const selected = [];
  const sectors = new Set();
  for (const site of candidates) {
    const normalized = (site.angle + Math.PI * 2) % (Math.PI * 2);
    const sector = Math.floor(normalized / (Math.PI * 2 / SUPPORT_SECTOR_COUNT));
    if (sectors.has(sector)) continue;
    sectors.add(sector);
    selected.push(site);
    if (selected.length >= limit) return selected;
  }
  for (const site of candidates) {
    if (selected.some(candidate => candidate.nodeId === site.nodeId)) continue;
    selected.push(site);
    if (selected.length >= limit) break;
  }
  return selected;
}

export function nearestTacticalSites(planner, point, tolerance) {
  return planner.tacticalSites
    .map(site => ({ ...site, distance: distance(point, site.point) }))
    .filter(site => site.distance <= tolerance)
    .sort((left, right) => left.distance - right.distance || right.priority - left.priority);
}

export function nearestBarrierSections(graph, planner, point, tolerance) {
  const matches = [];
  for (const section of planner.barrierSections) {
    let best = null;
    for (const edgeId of section.edgeIds) {
      const edge = graph.edgeById.get(edgeId);
      const a = edge && graph.nodeById.get(edge.a);
      const b = edge && graph.nodeById.get(edge.b);
      if (!edge || !a || !b) continue;
      const projection = pointToSegmentProjection(point, a, b);
      if (!best || projection.distance < best.projection.distance) best = { edge, projection };
    }
    if (best && best.projection.distance <= tolerance) matches.push({ section, edge: best.edge, projection: best.projection, distance: best.projection.distance });
  }
  return matches.sort((left, right) => left.distance - right.distance);
}
